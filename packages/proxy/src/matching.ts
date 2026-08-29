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

/** Prefix and suffix — the old whole-body heuristic, now scoped to one leaf, where it holds. */
function textDistance(a: string, b: string): number {
  let prefix = 0;
  const max = Math.min(a.length, b.length);
  while (prefix < max && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix += 1;
  }
  return Math.max(a.length, b.length) - prefix - suffix;
}

function trailingMessage(form: Record<string, unknown>): unknown {
  const messages = (form.messages ?? []) as unknown[];
  return messages[messages.length - 1];
}

function messageCount(form: Record<string, unknown>): number {
  return ((form.messages ?? []) as unknown[]).length;
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
}

/**
 * Walks the recorded requests in order, consuming one per match. Recorded order is meaningful:
 * a conversation replays forwards, so a match behind the cursor would mean the agent went
 * backwards, which is a divergence rather than a match.
 */
export class RequestMatcher {
  readonly #recorded: CanonicalRequest[];
  /** Redacted but unfolded — rung 1 compares these, so "exact" still means exact. */
  readonly #strict: string[];
  readonly #comparable: Record<string, unknown>[];
  /** Counted before the fold, which is the only point at which the digests are still there. */
  readonly #secrets: number[];
  readonly #redactor?: Redactor;
  #cursor = 0;

  constructor(recorded: CanonicalRequest[], options: MatcherOptions = {}) {
    this.#recorded = recorded;
    this.#redactor = options.redactor;
    const normalized = recorded.map((r) => normalizeRequest(r));
    this.#strict = normalized.map(hashOf);
    this.#secrets = normalized.map(countPlaceholders);
    this.#comparable = normalized.map((n) => mapStrings(n, foldPlaceholders));
  }

  remaining(): number {
    return this.#recorded.length - this.#cursor;
  }

  get cursor(): number {
    return this.#cursor;
  }

  match(incoming: CanonicalRequest): MatchResult {
    if (this.#cursor >= this.#recorded.length) {
      return {
        matched: false,
        rung: 4,
        index: -1,
        reason: `recording exhausted after ${this.#recorded.length} model requests`,
      };
    }

    const index = this.#cursor;
    const recorded = this.#comparable[index]!;

    // Rung 1 — canonical hash. Redacted the same way the recording was, but not folded: a request
    // only counts as exact when nothing in it had to be approximated.
    if (hashOf(redactedForm(incoming, this.#redactor)) === this.#strict[index]) {
      this.#cursor += 1;
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
      this.#cursor += 1;
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
      this.#cursor += 1;
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
    if (sameAsk) {
      this.#cursor += 1;
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

    // Rung 4 — no match. Halt and report; the caller decides whether --loose continues live.
    return {
      matched: false,
      rung: 4,
      index,
      reason:
        `request ${index} does not match the recording ` +
        `(distance ${distance}, ${messageCount(recorded)} recorded vs ` +
        `${messageCount(live)} replayed messages)`,
    };
  }
}
