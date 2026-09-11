import { createHash } from 'node:crypto';
import { Redactor } from '@orcareplay/core';
import type { CanonicalContent, CanonicalRequest } from '@orcareplay/plugin-api';
import { DIVERGENCE_LEVELS, MATCH_RUNGS } from '@orcareplay/schema';

/**
 * The replay matching ladder (spec §4).
 *
 * Agent harnesses are not deterministic — timestamps, generated ids, working directories, context
 * compaction firing at a different point. A recorded request will frequently not be byte-identical
 * to the one the agent makes on replay, so matching degrades through four rungs.
 *
 * The rule that matters more than the algorithm: **replay never silently approximates**. Anything
 * below rung 1 produces a divergence the caller must record. A debugger that quietly guesses is
 * worse than no debugger, because you will believe it.
 */

// Derived from the schema's own constants rather than restated. Both of these were written out a
// second time here, which is how the normative list and the code implementing it drift: nothing
// referenced `MATCH_RUNGS` at all, so it could have been changed without a single test noticing.
export type MatchRung = (typeof MATCH_RUNGS)[number];
export type DivergenceLevel = (typeof DIVERGENCE_LEVELS)[number];

export interface Divergence {
  level: DivergenceLevel;
  rung: MatchRung;
  detail: string;
  distance: number;
}

export interface MatchResult {
  matched: boolean;
  rung: MatchRung;
  index: number;
  divergence?: Divergence;
  reason?: string;
  /**
   * Recorded requests passed over to reach this one.
   *
   * A recording holds calls the harness made for itself — a quota probe before the first turn, a
   * request to name the session — and a replay driven without a terminal does not repeat them. The
   * cursor used to stop dead at the first of those, so a recording of an ordinary interactive
   * session could not be replayed at all. Skipping is only ever done onto an exact or near-exact
   * match, and is reported here because a silently skipped exchange is a replay that lies.
   */
  skipped?: number;
  /**
   * This request was answered from a position other than the cursor: stepped over to, or held
   * from earlier. Reported separately from {@link divergence} because the two say different
   * things.
   *
   * Spec §4: "Anything below rung 1 produces a divergence the caller must record." A rung-1 match
   * approximates nothing — it is byte-identical after redaction — so arriving out of order is not
   * a divergence, it is a fact about order. Calling it one made `exact=N/N` unreachable for any
   * concurrent workload: a pipeline with ten workers replays every request perfectly and reported
   * `exact=1 divergences=7`, which reads as a broken recording. What is *not* reproduced is still
   * reported, by `reused=x/y`, which counts anything never asked for.
   *
   * A skip onto an inexact match keeps its divergence, and the skip is named inside it.
   */
  reordered?: boolean;
}

/** Fields that change every run and say nothing about what was asked. */
const VOLATILE_METADATA = new Set([
  'request_id',
  'user_id',
  'session',
  'session_id',
  'trace_id',
  'idempotency_key',
  'timestamp',
]);

/** Rung 2 accepts differences up to this share of the request's total size. */
const MINOR_DISTANCE_RATIO = 0.15;

/**
 * How many unplayed recorded requests a live one may step over, at least.
 *
 * Small on purpose. The calls a harness makes for itself cluster at the start of a session — a
 * quota probe, a title — so a handful is enough for the case this exists for, and a wide window
 * turns a coincidental near-match into a wrong answer served under a `minor` label.
 *
 * It is a floor rather than the whole answer because a second workload reorders on a different
 * scale. An indexing pipeline issues N requests at once — IndexRAG defaults to ten workers,
 * Microsoft GraphRAG to `concurrent_requests`, LightRAG to `llm_model_max_async` — and the order
 * they are answered in is the order the origin happened to finish them, so a replay of the same
 * pipeline can arrive up to N-1 positions away from the cursor. A fixed 8 against a window of 10
 * refuses the ones that drifted furthest, and refuses them for a reason that has nothing to do
 * with the recording. {@link MatcherOptions.concurrency} lets the proxy raise the ceiling to what
 * it actually observed, which is a number only it can know.
 */
const LOOKAHEAD = 8;

/**
 * Reduce a request to what actually determines the model's answer: same model, same conversation,
 * same tools, same sampling. Tool order is not meaningful, so it is sorted; metadata that changes
 * per invocation is dropped.
 */
export function normalizeRequest(req: CanonicalRequest): Record<string, unknown> {
  const metadata = req.metadata
    ? Object.fromEntries(
        Object.entries(req.metadata)
          .filter(([k]) => !VOLATILE_METADATA.has(k))
          .sort(([a], [b]) => a.localeCompare(b)),
      )
    : undefined;

  return sortKeys({
    model: req.model,
    system: req.system ?? null,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: m.content.map(normalizeContent),
    })),
    tools: (req.tools ?? [])
      .map((t) => ({
        name: t.name,
        description: t.description ?? null,
        input_schema: t.input_schema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    max_tokens: req.max_tokens ?? null,
    temperature: req.temperature ?? null,
    top_p: req.top_p ?? null,
    stop: req.stop ?? null,
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : null,
  });
}

function normalizeContent(c: CanonicalContent): Record<string, unknown> {
  // A tool_use id is generated per call and never affects the answer, so it is excluded from the
  // identity of the request while the name and input — which do — are kept.
  switch (c.type) {
    case 'tool_use':
      return { type: c.type, name: c.name, input: c.input };
    case 'tool_result':
      return { type: c.type, content: c.content, is_error: c.is_error ?? false };
    case 'image':
      return { type: c.type, media_type: c.media_type, data: c.data };
    default:
      return { type: c.type, text: c.text };
  }
}

function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

/**
 * A redaction placeholder is `<secret:kind:hash8>` and the digest is salted **per run** (spec §5),
 * so the same secret, in the same position, becomes a different placeholder in a different run.
 * That is deliberate — it is what stops a short secret being brute-forced out of a published trace
 * — but it means a recorded request can never be byte-equal to the same request made again. Every
 * comparison below rung 1 is therefore made on the *kind* of secret rather than on its digest.
 */
const PLACEHOLDER_DIGEST = /(<secret:[a-z0-9_]+):[0-9a-f]{8}>/g;

function foldPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_DIGEST, '$1>');
}

/** Deep map over string leaves, structure untouched. */
function mapStrings<T>(value: T, f: (s: string) => string): T {
  if (typeof value === 'string') return f(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, f)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = mapStrings(v, f);
    return out as unknown as T;
  }
  return value;
}

/**
 * The recorded side was redacted on its way to disk. An incoming replay request has never been near
 * the write path, so it holds the real values and cannot match a recording that holds placeholders
 * — the two have to be put in the same representation first. Pass the redactor for the live side;
 * the recorded side is already in it.
 */
function redactedForm(req: CanonicalRequest, redactor?: Redactor): Record<string, unknown> {
  const normalized = normalizeRequest(req);
  if (!redactor) return normalized;
  return mapStrings(normalized, (s) => redactor.redactString(s).value);
}

/**
 * What rungs 2 and below compare: the redacted form with placeholder digests folded away, so what
 * survives is *which kind of secret sat here*. That is the most a trace can honestly claim to know
 * about a value it deliberately destroyed.
 */
export function comparableRequest(
  req: CanonicalRequest,
  redactor?: Redactor,
): Record<string, unknown> {
  return mapStrings(redactedForm(req, redactor), foldPlaceholders);
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function canonicalHash(req: CanonicalRequest): string {
  return hashOf(normalizeRequest(req));
}

function countPlaceholders(value: unknown): number {
  let n = 0;
  mapStrings(value, (s) => {
    n += s.match(PLACEHOLDER_DIGEST)?.length ?? 0;
    return s;
  });
  return n;
}

/**
 * Character distance summed over the leaves that actually differ.
 *
 * The obvious implementation — longest common prefix and suffix of the two serialized bodies — is
 * wrong in a way only a real harness shows you. Claude Code carries a session-scoped id in both its
 * system prompt and its tool descriptions; two drifting tokens that far apart leave the entire
 * 200 KB between them counted as changed, so a sixteen-character difference scored 217,568 and
 * rung 2 could not fire on any real recording. Walking the two structures in parallel bounds each
 * difference to the leaf that contains it.
 *
 * Arrays align by index, which is right for `messages` and for the name-sorted `tools`, and
 * deliberately pessimistic when an element is *inserted* in the middle: everything after it counts
 * as changed. Over-counting sends a request down the ladder rather than up it, which is the safe
 * direction for a matcher to be wrong in.
 */
export function structuralDistance(a: CanonicalRequest, b: CanonicalRequest): number {
  return leafDistance(comparableRequest(a), comparableRequest(b));
}

function leafDistance(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    let total = 0;
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i += 1) total += leafDistance(a[i], b[i]);
    for (let i = shared; i < a.length; i += 1) total += weight(a[i]);
    for (let i = shared; i < b.length; i += 1) total += weight(b[i]);
    return total;
  }
  if (isRecord(a) && isRecord(b)) {
    let total = 0;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a)) total += weight(b[key]);
      else if (!(key in b)) total += weight(a[key]);
      else total += leafDistance(a[key], b[key]);
    }
    return total;
  }
  if (typeof a === 'string' && typeof b === 'string') return textDistance(a, b);
  return Math.max(weight(a), weight(b));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function weight(v: unknown): number {
  return JSON.stringify(v ?? null).length;
}

/**
 * Distance within one string leaf.
 *
 * Line-aligned when both sides have the same number of lines, because that is the shape drift takes
 * inside a command's output: `node --test` prints four `duration_ms` floats scattered over fifty
 * lines, and taking the common prefix and suffix of the whole string counted the 1,289 characters
 * lying between the first and the last of them. Per line, it counts the four. Same failure as the
 * whole-body metric had, one level down; the structural walk above cannot see inside a string.
 */
function textDistance(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.split('\n');
  const lb = b.split('\n');
  if (la.length === lb.length && la.length > 1) {
    let total = 0;
    for (let i = 0; i < la.length; i += 1) total += spanDistance(la[i]!, lb[i]!);
    return total;
  }
  return spanDistance(a, b);
}

/** Prefix and suffix — the old whole-body heuristic, now scoped to one line, where it holds. */
function spanDistance(a: string, b: string): number {
  let prefix = 0;
  const max = Math.min(a.length, b.length);
  while (prefix < max && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix += 1;
  }
  return Math.max(a.length, b.length) - prefix - suffix;
}

/**
 * How good a candidate is, lower being better: the rung first, then the distance, then how far it
 * is from the cursor.
 *
 * The rung leads because the rungs are already ordered by how much was approximated — a rung-2
 * match really is better evidence than a rung-3 one, whatever the raw character counts say, since
 * rung 3 means the conversation itself differs. Distance separates candidates at the same rung.
 * The last term is the tie-break, and it points at the cursor: with nothing else to choose
 * between two equally good answers, the one the recording expected next is the honest pick.
 */
function rank(result: MatchResult, cursor: number): number {
  const distance = result.divergence?.distance ?? 0;
  return result.rung * 1e12 + distance * 1e3 + Math.abs(result.index - cursor);
}

function trailingMessage(form: Record<string, unknown>): unknown {
  const messages = (form.messages ?? []) as unknown[];
  return messages[messages.length - 1];
}

function messageCount(form: Record<string, unknown>): number {
  return ((form.messages ?? []) as unknown[]).length;
}

/**
 * The request with the body of every tool result blanked, leaving what the model was told and what
 * it said.
 *
 * If two requests agree on this and differ elsewhere, the only thing that changed is what the world
 * returned — and on replay it will, because orca does not intercept tool execution. That is the
 * price of not patching the harness: the agent really re-runs `npm test`, which really reprints its
 * own durations. `is_error` is kept, so a check that went from failing to passing is still a
 * difference; only the text of the output is set aside.
 */
function withoutToolOutput(form: Record<string, unknown>): Record<string, unknown> {
  const messages = ((form.messages ?? []) as Record<string, unknown>[]).map((m) => ({
    ...m,
    content: ((m.content ?? []) as Record<string, unknown>[]).map((c) =>
      c?.type === 'tool_result' ? { ...c, content: '' } : c,
    ),
  }));
  return { ...form, messages };
}

/**
 * How far the ask may drift and still be the same ask: a share of its own size, capped in absolute
 * terms. Both halves earn their place. The ratio has no floor, so on a short question a fraction of
 * a short string is a fraction of a character and "same ask" collapses back to equality — which is
 * what stops a swapped question being served the recorded answer. The cap stops a very large tool
 * result buying a proportionally large licence to differ: however big the message, at most this
 * many characters of it may move.
 *
 * The number that motivated it, from the first real recording this was pointed at: a Claude Code
 * tool result quoting the on-disk path of a bundled skill, whose 32-character content-addressed
 * directory name is regenerated per install. Thirty-two characters, in a message of several
 * kilobytes, and the run could not be replayed at all.
 */
const ASK_DRIFT_RATIO = 0.02;
const ASK_DRIFT_MAX = 512;

/** `Infinity` when one side has no trailing message at all and the other does. */
function askDistance(live: Record<string, unknown>, recorded: Record<string, unknown>): number {
  const a = trailingMessage(live);
  const b = trailingMessage(recorded);
  if (a === undefined || b === undefined) return a === b ? 0 : Number.POSITIVE_INFINITY;
  return leafDistance(a, b);
}

function askTolerance(recorded: Record<string, unknown>): number {
  const ask = trailingMessage(recorded);
  return ask === undefined ? 0 : Math.min(weight(ask) * ASK_DRIFT_RATIO, ASK_DRIFT_MAX);
}

export interface MatcherOptions {
  /**
   * Applied to incoming requests before they are compared, so a live body meets the recording in
   * the representation the recording is stored in. Leave it out and the two are compared raw,
   * which only ever matches a recording that had nothing redacted in it at all.
   */
  redactor?: Redactor;
  /**
   * The most requests the caller has ever had in flight at once, read each time a skip is
   * considered.
   *
   * A function rather than a number because the peak is not known when the matcher is built: the
   * proxy learns it from the run it is watching. See {@link LOOKAHEAD} for why the window has to
   * follow the workload's own concurrency rather than a constant.
   */
  concurrency?: () => number;
}

/**
 * Walks the recorded requests in order, consuming one per match. Recorded order is meaningful:
 * a conversation replays forwards, so a match behind the cursor would mean the agent went
 * backwards, which is a divergence rather than a match.
 */
/**
 * Tools the recording had and the replay does not.
 *
 * The reason a miss is worth naming rather than counting. A session recorded through a terminal is
 * offered tools that only make sense with a person in front of it — asking a question, entering
 * plan mode, ending the conversation — and a replay driven without one is not offered them. Their
 * schemas are large, so the distance runs into the hundreds of thousands and reads as a corrupted
 * trace, when what happened is that the same agent was started two different ways.
 */
function toolsOnlyInRecording(live: CanonicalRequest, recorded: CanonicalRequest): string[] {
  const replayed = new Set((live.tools ?? []).map((t) => t.name));
  return (recorded.tools ?? []).map((t) => t.name).filter((name) => !replayed.has(name));
}

export class RequestMatcher {
  readonly #recorded: CanonicalRequest[];
  /** Redacted but unfolded — rung 1 compares these, so "exact" still means exact. */
  readonly #strict: string[];
  readonly #comparable: Record<string, unknown>[];
  /** Counted before the fold, which is the only point at which the digests are still there. */
  readonly #secrets: number[];
  readonly #redactor?: Redactor;
  readonly #concurrency?: () => number;
  #cursor = 0;
  /**
   * Recorded requests the cursor stepped over that have not been played yet.
   *
   * Stepping over used to discard them, and against a harness that issues a call concurrently with
   * its own conversation that loses the conversation. goose is the case that found it: it asks for
   * a session title on a second task, so the title and the first real turn race, and the order
   * they land in is not the order they were recorded in. When the replay's title arrived first the
   * cursor jumped past the recorded first turn to reach it — and the first turn, which was about
   * to be asked for, had already been thrown away. The next request then met turn *two* and the
   * replay halted on a recording that contained everything it needed.
   *
   * Holding them here instead costs nothing when the order does match — the set stays empty — and
   * makes out-of-order arrival a matter of which request is served rather than whether the replay
   * survives. Anything still in here at the end was genuinely never repeated, which is what
   * `reused=x/y` already reports.
   */
  readonly #deferred: number[] = [];
  /**
   * Recorded positions by strict hash, ascending — the index behind {@link #exactAhead}.
   *
   * A map rather than a scan because the scan is what the window was protecting against: looking
   * for an exact match by walking the recording is O(n) per request and O(n²) over a run, and a
   * pipeline recording is exactly the shape with thousands of them.
   */
  readonly #byStrictHash = new Map<string, number[]>();

  constructor(recorded: CanonicalRequest[], options: MatcherOptions = {}) {
    this.#recorded = recorded;
    this.#redactor = options.redactor;
    this.#concurrency = options.concurrency;
    const normalized = recorded.map((r) => normalizeRequest(r));
    this.#strict = normalized.map(hashOf);
    this.#secrets = normalized.map(countPlaceholders);
    this.#comparable = normalized.map((n) => mapStrings(n, foldPlaceholders));
    for (const [index, hash] of this.#strict.entries()) {
      const at = this.#byStrictHash.get(hash);
      if (at) at.push(index);
      else this.#byStrictHash.set(hash, [index]);
    }
  }

  remaining(): number {
    return this.#recorded.length - this.#cursor + this.#deferred.length;
  }

  get cursor(): number {
    return this.#cursor;
  }

  match(incoming: CanonicalRequest): MatchResult {
    const hash = hashOf(redactedForm(incoming, this.#redactor));

    // The ordinary case, and the only one that needs no judgement: the request at the cursor is
    // byte-identical to the one being asked for.
    if (this.#cursor < this.#recorded.length && this.#strict[this.#cursor] === hash) {
      const at = this.#matchAt(incoming, this.#cursor);
      this.#cursor = at.index + 1;
      return at;
    }

    // An exact match somewhere else outranks an approximate one here.
    //
    // This ordering is load-bearing, and having it the other way round is how an indexing
    // pipeline came to be served another document's answer. Rung 2 exists for drift *around* a
    // stable question — a regenerated id, a different working directory in the system prompt —
    // and it measures that drift as a share of the request's own size. An extraction prompt
    // carries the document in the *system* prompt and a fixed template as its only message, so
    // two different paragraphs are `sameAsk` by construction and differ by a few hundred
    // characters in a request of several thousand: comfortably inside tolerance. Taking the
    // cursor's near-match first meant paragraph 2's request was answered with paragraph 1's
    // extraction, under a `minor` label, while paragraph 2's own answer sat unplayed three
    // positions along — and the knowledge base built from that replay was a knowledge base of
    // mismatched answers.
    //
    // Nothing is lost by looking first. An exact match is a hash lookup, and where there is none
    // the ladder runs exactly as it did before.
    const heldExact = this.#matchDeferred(incoming, hash);
    if (heldExact) return heldExact;
    const aheadExact = this.#exactAhead(hash);
    if (aheadExact !== undefined) return this.#skipTo(incoming, aheadExact);

    if (this.#cursor >= this.#recorded.length) {
      // The cursor is past the end, and nothing held is an exact answer to this. A near one still
      // might be: the out-of-order pair whose second half arrives last.
      const held = this.#matchDeferred(incoming);
      if (held) return held;
      return {
        matched: false,
        rung: 4,
        index: -1,
        reason: `recording exhausted after ${this.#recorded.length} model requests`,
      };
    }

    // No exact answer anywhere, so the ladder has to approximate — and the question becomes
    // *which* recorded request it approximates against. Taking the cursor's, because it is the
    // cursor's, is the other half of the same mistake: a request that is a rung-2 match against
    // the cursor is frequently a much better rung-2 match against one three positions along, and
    // `leafDistance` already says which, by how much. The exact path above covers an indexing
    // pipeline whose requests repeat byte for byte; this covers the same pipeline once anything
    // per-run is in the prompt — a session id, a timestamp — so that nothing is byte-equal and
    // every comparison lands on rung 2 against several neighbours at once.
    //
    // "Nearest" means lowest rung first and then least distance, because the rungs are ordered by
    // how much was approximated and a rung-2 match elsewhere really is better evidence than a
    // rung-3 at the cursor. Ties go to the cursor, which is where a well-behaved run always is.
    const best = this.#nearest(incoming);
    if (best !== undefined) {
      if (best.index === this.#cursor) {
        this.#cursor = best.index + 1;
        return best;
      }
      const held = this.#matchDeferred(incoming, undefined, best.index);
      if (held) return held;
      return this.#skipTo(incoming, best.index);
    }

    return this.#matchAt(incoming, this.#cursor);
  }

  /**
   * The best approximate match available: the cursor, anything held, and the window ahead.
   *
   * The cursor is allowed to match at any rung — rung 3 is what a compacted conversation lands on
   * and it is only ever legitimate in place. Everything else is held to rung 2, for the reason a
   * step-forward always has been: below that the agent would be handed some other turn's answer.
   */
  #nearest(incoming: CanonicalRequest): MatchResult | undefined {
    const candidates: MatchResult[] = [];
    const atCursor = this.#matchAt(incoming, this.#cursor);
    if (atCursor.matched) candidates.push(atCursor);
    for (const index of [...this.#deferred, ...this.#nearAhead()]) {
      const other = this.#matchAt(incoming, index);
      if (other.matched && other.rung <= 2) candidates.push(other);
    }

    let best: MatchResult | undefined;
    for (const candidate of candidates) {
      if (best === undefined || rank(candidate, this.#cursor) < rank(best, this.#cursor)) {
        best = candidate;
      }
    }
    return best;
  }

  /** Move the cursor to `index`, holding what it stepped over, and report what was passed by. */
  #skipTo(incoming: CanonicalRequest, index: number): MatchResult {
    const later = this.#matchAt(incoming, index);
    const skipped = index - this.#cursor;
    // Set aside rather than dropped. They may yet be asked for — see `#deferred`.
    for (let i = this.#cursor; i < index; i += 1) this.#deferred.push(i);
    this.#cursor = index + 1;
    const skippedNote =
      `, holding ${skipped} recorded ${skipped === 1 ? 'request' : 'requests'} ` +
      'the replay has not asked for yet';
    // A rung-1 skip is reported as a reordering, not a divergence — see `MatchResult.reordered`.
    // Nothing is hidden by that: the requests stepped over are held, and anything still held at
    // the end was never asked for, which is exactly what `reused=x/y` counts.
    if (later.rung === 1) return { ...later, skipped, reordered: true };
    return {
      ...later,
      skipped,
      reordered: true,
      // Said even when the match had a divergence of its own: an inexact exchange stepped over
      // without mention is a replay claiming to have reproduced something it passed by.
      divergence: {
        level: later.divergence?.level ?? 'minor',
        rung: later.rung,
        distance: later.divergence?.distance ?? 0,
        detail: `${later.divergence?.detail ?? `matched request ${index}`}${skippedNote}`,
      },
    };
  }

  /**
   * Serve a request the cursor stepped over earlier, when this is the one it was waiting for.
   *
   * With `exactHash`, only a byte-identical one counts. That pass runs before the ladder is
   * allowed to approximate anything, so a held request that *is* the answer is served rather than
   * a near-match at the cursor that merely resembles it.
   */
  #matchDeferred(
    incoming: CanonicalRequest,
    exactHash?: string,
    only?: number,
  ): MatchResult | undefined {
    for (let slot = 0; slot < this.#deferred.length; slot += 1) {
      const index = this.#deferred[slot]!;
      if (only !== undefined && index !== only) continue;
      if (exactHash !== undefined && this.#strict[index] !== exactHash) continue;
      const held = this.#matchAt(incoming, index);
      if (!held.matched || held.rung > 2) continue;
      this.#deferred.splice(slot, 1);
      // As in `#skipTo`: byte-identical is byte-identical, whichever order it arrived in.
      if (held.rung === 1) return { ...held, reordered: true };
      const note = ', matched out of the order it was recorded in';
      return {
        ...held,
        reordered: true,
        divergence: {
          level: held.divergence?.level ?? 'minor',
          rung: held.rung,
          distance: held.divergence?.distance ?? 0,
          detail: `${held.divergence?.detail ?? `matched request ${index}`}${note}`,
        },
      };
    }
    return undefined;
  }

  /**
   * The first unplayed recorded position this request is byte-identical to, if there is one.
   *
   * Reached by hash rather than by walking, so "anywhere ahead" costs the same as one comparison.
   * The earliest candidate is taken: a recording that asked the same thing twice owes the answers
   * back in the order it got them.
   */
  #exactAhead(hash: string): number | undefined {
    for (const index of this.#byStrictHash.get(hash) ?? []) {
      if (index > this.#cursor) return index;
    }
    return undefined;
  }

  /**
   * Positions a near-match may reach. Bounded: past this, a match is more likely a coincidence.
   */
  #nearAhead(): number[] {
    const observed = this.#concurrency?.() ?? 0;
    const window = Math.max(LOOKAHEAD, Number.isFinite(observed) ? observed : 0);
    const limit = Math.min(this.#cursor + window, this.#recorded.length - 1);
    const out: number[] = [];
    for (let ahead = this.#cursor + 1; ahead <= limit; ahead += 1) out.push(ahead);
    return out;
  }

  /** Match against one recorded request, without moving the cursor. */
  #matchAt(incoming: CanonicalRequest, index: number): MatchResult {
    const recorded = this.#comparable[index]!;

    // Rung 1 — canonical hash. Redacted the same way the recording was, but not folded: a request
    // only counts as exact when nothing in it had to be approximated.
    if (hashOf(redactedForm(incoming, this.#redactor)) === this.#strict[index]) {
      return { matched: true, rung: 1, index };
    }

    const live = comparableRequest(incoming, this.#redactor);
    const distance = leafDistance(live, recorded);
    const size = JSON.stringify(recorded).length;

    // Rung 2a — identical everywhere the trace kept a value. The digests differ because they are
    // salted per run, which is the one difference orca can neither reproduce nor rule out, so it
    // is reported rather than waved through: this is the ordinary shape of replaying a real
    // harness, whose own prompt carries a session id.
    if (distance === 0) {
      const secrets = this.#secrets[index]!;
      return {
        matched: true,
        rung: 2,
        index,
        divergence: {
          level: 'minor',
          rung: 2,
          distance: 0,
          detail:
            `request ${index} is identical apart from ${secrets} redacted ` +
            `${secrets === 1 ? 'value' : 'values'}, whose digests are salted per run`,
        },
      };
    }

    // Rung 2 — same position, same ask, small difference around it.
    //
    // The trailing-message condition is load-bearing, not belt-and-braces. Tolerance has an
    // absolute floor, and on a short request that floor is a large fraction of the entire body —
    // so without this, swapping the user's question for an unrelated one of similar length fell
    // inside tolerance and was served the recorded answer under a `minor` label. Rung 2 exists for
    // drift *around* the question: a regenerated id, a different cwd in the system prompt, a
    // reordered tool list. A changed question is a different run, and it belongs at rung 4.
    const askDrift = askDistance(live, recorded);
    const sameAsk = askDrift <= askTolerance(recorded);
    if (
      sameAsk &&
      messageCount(live) === messageCount(recorded) &&
      distance <= Math.max(64, size * MINOR_DISTANCE_RATIO)
    ) {
      return {
        matched: true,
        rung: 2,
        index,
        divergence: {
          level: 'minor',
          rung: 2,
          distance,
          detail:
            `request ${index} differs by ${distance} ${distance === 1 ? 'char' : 'chars'} ` +
            `with an identical message count` +
            (askDrift > 0 ? `, ${askDrift} of them in the trailing message` : ''),
        },
      };
    }

    // Rung 3 — the ask is the same, the history is not. Typical after context compaction.
    //
    // "The history is not" has to mean the history. Compaction is the case this rung was written
    // for, and compaction rewrites `messages`; what it never does is leave the message count
    // untouched while replacing the system prompt. An indexing pipeline does exactly that — one
    // fixed instruction as the only message, the document that varies carried in the system
    // prompt — so every document's request is `sameAsk` against every other document's, and this
    // rung handed each one whichever answer the cursor happened to be sitting on. Measured on 30
    // real HotpotQA paragraphs at concurrency 10: 24 matched here, each served another
    // paragraph's answer, and the run still exited 0.
    //
    // Requiring the counts to differ costs nothing that rung 2 does not already cover — a request
    // whose history is the same length and whose ask is the same either fits inside rung 2's
    // tolerance or is a different request — and it sends the indexing case to rung 4, where the
    // lookahead can find its real answer instead of being handed a wrong one.
    const historyDiffers = messageCount(live) !== messageCount(recorded);
    if (sameAsk && historyDiffers) {
      return {
        matched: true,
        rung: 3,
        index,
        divergence: {
          level: 'major',
          rung: 3,
          distance,
          detail:
            `request ${index} has ${askDrift === 0 ? 'an identical' : 'an equivalent'} trailing ` +
            `message but a different prefix ` +
            `(${messageCount(recorded)} recorded vs ${messageCount(live)} replayed)`,
        },
      };
    }

    // Rung 3 — every difference in this request is inside tool output. Halting here would make
    // exact replay impossible for most real agents, since re-running a command reprints its own
    // timings, and the drift accumulates: by the fifth turn the earlier results are in the prefix
    // too. Serving the recorded answer is the useful thing to do, and a `major` divergence is the
    // honest way to say so. Deliberately narrow — a changed *question*, or a check that went from
    // failing to passing, moves this comparison and still falls through to rung 4.
    // A message count that differs is already covered: `leafDistance` charges the full weight of
    // any message only one side has, so it cannot come back zero.
    if (leafDistance(withoutToolOutput(live), withoutToolOutput(recorded)) === 0) {
      return {
        matched: true,
        rung: 3,
        index,
        divergence: {
          level: 'major',
          rung: 3,
          distance,
          detail:
            `request ${index} replayed against a different world: ` +
            `only tool output differs (${distance} chars)`,
        },
      };
    }

    // Rung 4 — no match. Halt and report; the caller decides whether --loose continues live.
    const missingTools = toolsOnlyInRecording(incoming, this.#recorded[index]!);
    return {
      matched: false,
      rung: 4,
      index,
      reason:
        `request ${index} does not match the recording ` +
        `(distance ${distance}, ${messageCount(recorded)} recorded vs ` +
        `${messageCount(live)} replayed messages)` +
        (missingTools.length === 0
          ? ''
          : `; the recording offered ${missingTools.length} tools this replay is not: ` +
            `${missingTools.slice(0, 6).join(', ')}` +
            `${missingTools.length > 6 ? ', …' : ''}` +
            ' — a session recorded through a terminal carries tools that need one'),
    };
  }
}
