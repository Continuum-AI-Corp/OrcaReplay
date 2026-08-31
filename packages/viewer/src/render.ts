/**
 * Pure derivation from a trace to the shapes the UI renders. No DOM, no I/O.
 *
 * Everything here is a third-party read of the format described in `spec/orca-trace-v0.md`:
 * attrs are advisory (§2.1 calls them "type-specific scalar data"), so every reader is written
 * to be liberal — a missing or oddly-shaped attr degrades the row, it never throws.
 */

import type { Manifest, TraceEvent } from '@orcareplay/schema';
import { isDelegation } from '@orcareplay/core';

export type Tone = 'attention' | 'normal' | 'quiet';

export interface TimelineRow {
  /** Dense total order from the envelope (spec §2.1). */
  seq: number;
  turn: number;
  /** Microseconds since run start. Authoritative for playback timing; wall clocks lie. */
  monoUs: number;
  /** Short uppercase token, at most 7 chars, used as the row chip. */
  kind: string;
  /** The one thing worth reading at a glance. Never empty. */
  label: string;
  /**
   * How many sub-agent calls this row is inside.
   *
   * A harness that delegates runs the delegate's model and tool calls through the same proxy, so
   * they land in the same flat sequence as the parent's — and a run that spawned an Explore agent
   * read as one stream in which no line said whose work it was. The nesting is already in the
   * trace: the `tool.result` closing a sub-agent call names it in `causes`, so everything between
   * the two belongs to the delegate.
   */
  depth: number;
  /** Secondary text, dimmed. */
  detail: string;
  /** Right-aligned trailing text (ids, token counts, durations). */
  meta: string;
  tone: Tone;
}

export interface RunSummary {
  runId: string;
  adapter: string;
  durationMs: number;
  eventCount: number;
  turnCount: number;
  exitCode: number | null;
  errorCount: number;
  divergenceCount: number;
  totalUsage: { input: number; output: number };
  blobCount: number;
}

export interface LoopFinding {
  fromTurn: number;
  toTurn: number;
  turns: number[];
  /** Why this run was called a loop, which is also what makes it actionable. */
  kind: 'repeated-action' | 'error-spin';
  /** The action being repeated, for `repeated-action`. */
  signature?: string;
  /** Times the cycle went round, for `repeated-action`. */
  repeats?: number;
  /**
   * Filesystem tree the run sat on, when every turn in it shared one.
   *
   * Optional now: it was the whole basis of the old detector and is only context here, and an
   * error-spin can happen in a run that has no filesystem capture at all.
   */
  tree?: string;
}

const KIND_BY_TYPE: Record<string, string> = {
  'model.request': 'MODEL',
  'model.response': 'MODEL',
  'tool.call': 'TOOL',
  'tool.result': 'TOOL',
  'shell.exec': 'SHELL',
  'shell.result': 'SHELL',
  'fs.change': 'FILE',
  'fs.snapshot': 'SNAP',
  'mcp.request': 'MCP',
  'mcp.response': 'MCP',
  'net.request': 'NET',
  'net.response': 'NET',
  error: 'ERROR',
  divergence: 'DIVERGE',
  note: 'NOTE',
  'route.decision': 'ROUTE',
  'run.start': 'RUN',
  'run.end': 'RUN',
  checkpoint: 'CKPT',
  fork: 'FORK',
};

const LABEL_MAX = 120;
const DETAIL_MAX = 160;
const META_MAX = 48;

/**
 * A short uppercase token for the row chip. Unknown types get a token derived from their
 * first segment rather than being dropped — spec §2.3 requires readers to tolerate types
 * they do not know.
 */
export function kindForType(type: string): string {
  const known = KIND_BY_TYPE[type];
  if (known) return known;
  const head = String(type ?? '').split('.')[0] ?? '';
  const token = head.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return token === '' ? 'EVENT' : token.slice(0, 7);
}

function attrs(event: TraceEvent): Record<string, unknown> {
  const value = event.attrs;
  return value && typeof value === 'object' ? value : {};
}

/** Collapse to one line; a row is one line and must stay one line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Render an arbitrary attr value as one line of display text. */
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return oneLine(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return oneLine(JSON.stringify(value) ?? '');
  } catch {
    return '';
  }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** First non-empty rendering among the named attrs. */
function pick(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const rendered = text(source[key]);
    if (rendered !== '') return rendered;
  }
  return '';
}

function humanize(type: string): string {
  return oneLine(String(type ?? 'event').replace(/[._]/g, ' ')) || 'event';
}

interface RowParts {
  label?: string;
  detail?: string;
  meta?: string;
  tone?: Tone;
}

function parts(event: TraceEvent): RowParts {
  const a = attrs(event);
  switch (event.type) {
    case 'run.start':
      return { label: 'run started', detail: pick(a, 'adapter', 'argv', 'cwd') };
    case 'run.end': {
      const code = num(a['exit_code']);
      return {
        label: 'run ended',
        detail: code === undefined ? pick(a, 'reason') : `exit ${code}`,
        tone: code !== undefined && code !== 0 ? 'attention' : 'normal',
      };
    }
    case 'model.request': {
      const messages = num(a['messages']) ?? num(a['message_count']);
      return {
        label: pick(a, 'model'),
        detail: messages === undefined ? pick(a, 'endpoint', 'url') : `${messages} messages`,
      };
    }
    case 'model.response': {
      const usage = usageOf(a);
      return {
        label: pick(a, 'model'),
        detail: pick(a, 'stop_reason', 'finish_reason')
          ? `stop: ${pick(a, 'stop_reason', 'finish_reason')}`
          : '',
        meta:
          usage.input || usage.output
            ? `${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out`
            : '',
      };
    }
    case 'tool.call':
      return {
        label: pick(a, 'name', 'tool'),
        detail: pick(a, 'summary', 'args', 'input'),
        meta: pick(a, 'id', 'call_id'),
      };
    case 'tool.result': {
      // `is_error` is what the recorder writes, from the provider's own tool_result flag. The other
      // two are accepted so a hand-written or third-party trace still renders; checking only those
      // meant a failed call showed the word "ok" in a normal tone, which is worse than showing
      // nothing — the timeline is where you go to find the failure.
      const failed = a['is_error'] === true || a['error'] !== undefined || a['ok'] === false;
      return {
        label: pick(a, 'name', 'tool'),
        detail: failed ? pick(a, 'error') || 'failed' : pick(a, 'summary') || 'ok',
        meta: pick(a, 'id', 'call_id'),
        tone: failed ? 'attention' : 'normal',
      };
    }
    case 'shell.exec':
      return { label: pick(a, 'command', 'cmd', 'argv'), detail: pick(a, 'cwd') };
    case 'shell.result': {
      const code = num(a['exit_code']) ?? num(a['code']);
      const ms = num(a['duration_ms']);
      return {
        label: pick(a, 'command', 'cmd'),
        detail: code === undefined ? pick(a, 'signal') : `exit ${code}`,
        meta: ms === undefined ? '' : formatDuration(ms),
        tone: code !== undefined && code !== 0 ? 'attention' : 'normal',
      };
    }
    case 'fs.snapshot': {
      const tree = pick(a, 'tree');
      const files = num(a['changes']) ?? num(a['files']);
      return {
        label: tree ? `tree ${tree}` : '',
        // `changes` is the writer's name; `files` kept for traces from an older build.
        detail: files === undefined ? '' : `${files} changed`,
        tone: 'quiet',
      };
    }
    case 'fs.change': {
      // `insertions`/`deletions` are what `orca record` writes; `added`/`removed` are accepted so
      // a trace from an older build still renders rather than silently losing its counts.
      const files = num(a['files']) ?? num(a['changes']);
      const added = num(a['insertions']) ?? num(a['added']);
      const removed = num(a['deletions']) ?? num(a['removed']);
      const counts = [
        pick(a, 'status'),
        added === undefined ? '' : `+${added}`,
        removed === undefined ? '' : `−${removed}`,
        // Without this, a tool that rewrote a CRLF file with LF reports every line as changed and
        // there is nothing to say the content is the same.
        a['eol_only'] === true ? '(line endings only)' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return {
        label: pick(a, 'path') || (files === undefined ? '' : `${files} files changed`),
        detail: counts,
      };
    }
    case 'mcp.request':
      return { label: pick(a, 'method'), detail: pick(a, 'server', 'transport') };
    case 'mcp.response': {
      const failed = a['error'] !== undefined;
      return {
        label: pick(a, 'method'),
        detail: failed ? pick(a, 'error') || 'failed' : pick(a, 'server', 'transport'),
        tone: failed ? 'attention' : 'normal',
      };
    }
    case 'net.request':
      return { label: pick(a, 'url', 'host'), detail: pick(a, 'method') };
    case 'net.response': {
      const status = num(a['status']);
      return {
        label: pick(a, 'url', 'host'),
        detail: status === undefined ? '' : `status ${status}`,
        tone: status !== undefined && status >= 400 ? 'attention' : 'normal',
      };
    }
    case 'error':
      return {
        label: pick(a, 'message', 'error', 'reason'),
        detail: pick(a, 'code', 'source'),
        tone: 'attention',
      };
    case 'divergence': {
      const level = pick(a, 'level') || 'divergence';
      const rung = num(a['rung']);
      return {
        label: `${level} divergence`,
        detail: rung === undefined ? pick(a, 'reason') : `rung ${rung}`,
        tone: 'attention',
      };
    }
    case 'checkpoint':
      return { label: 'checkpoint', detail: pick(a, 'reason'), tone: 'quiet' };
    case 'fork': {
      const child = pick(a, 'child_run', 'run_id', 'child');
      const from = num(a['from_seq']) ?? num(a['fork_point']);
      return {
        label: child ? `fork → ${child}` : 'fork',
        detail: from === undefined ? '' : `from seq ${from}`,
      };
    }
    case 'route.decision':
      return { label: pick(a, 'model', 'target'), detail: pick(a, 'reason', 'rule') };
    case 'note':
      return {
        label: pick(a, 'text', 'message', 'note'),
        detail: pick(a, 'analyzer'),
        tone: 'quiet',
      };
    default:
      return { detail: pick(a, 'message', 'name', 'summary') };
  }
}

/**
 * Nesting depth per seq, from the delegation calls open in the trace at that point.
 *
 * Read off `causes` rather than guessed from ordering: the result event of a delegation names the
 * call it answers, so the span is exactly [call, result] and survives interleaving, background
 * tasks and delegations inside delegations.
 */
function depthBySeq(events: TraceEvent[]): Map<number, number> {
  const closesAt = new Map<number, number>();
  for (const event of events) {
    if (event.type !== 'tool.result') continue;
    for (const cause of event.causes ?? []) closesAt.set(cause, event.seq);
  }

  const open: number[] = [];
  const depth = new Map<number, number>();
  for (const event of events) {
    while (open.length > 0 && event.seq > open[open.length - 1]!) open.pop();
    // The opening call sits at the parent's level; everything up to and including the result
    // that closes it is nested, so the block reads as one piece.
    depth.set(event.seq, open.length);
    if (isDelegation(event)) {
      const closes = closesAt.get(event.seq);
      if (closes !== undefined) open.push(closes);
    }
  }
  return depth;
}

/** One display row per event, in trace order. */
export function buildTimeline(events: TraceEvent[]): TimelineRow[] {
  const depth = depthBySeq(events);
  return events.map((event) => {
    const derived = parts(event);
    return {
      seq: event.seq,
      monoUs: event.mono_us,
      turn: event.turn,
      depth: depth.get(event.seq) ?? 0,
      kind: kindForType(event.type),
      label: clamp(oneLine(derived.label || humanize(event.type)), LABEL_MAX),
      detail: clamp(oneLine(derived.detail ?? ''), DETAIL_MAX),
      meta: clamp(oneLine(derived.meta ?? ''), META_MAX),
      tone: derived.tone ?? 'normal',
    };
  });
}

function usageOf(a: Record<string, unknown>): { input: number; output: number } {
  const raw = a['usage'];
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : a;
  const input =
    num(source['input_tokens']) ?? num(source['input']) ?? num(source['prompt_tokens']) ?? 0;
  const output =
    num(source['output_tokens']) ?? num(source['output']) ?? num(source['completion_tokens']) ?? 0;
  return { input, output };
}

/** Walk a payload (bounded) collecting every blob digest it references. Spec §2.2. */
function collectBlobs(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectBlobs(item, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['$blob'] === 'string') {
    into.add(record['$blob']);
    return;
  }
  for (const item of Object.values(record)) collectBlobs(item, into, depth + 1);
}

/** Every blob digest referenced by these events, deduplicated. */
export function referencedBlobs(events: TraceEvent[]): string[] {
  const found = new Set<string>();
  for (const event of events) collectBlobs(event.payload, found);
  return [...found];
}

export function summarize(manifest: Manifest, events: TraceEvent[]): RunSummary {
  const turns = new Set<number>();
  let errorCount = 0;
  let divergenceCount = 0;
  let input = 0;
  let output = 0;
  let lastMonoUs = 0;
  let exitFromEvents: number | null = null;

  for (const event of events) {
    turns.add(event.turn);
    if (typeof event.mono_us === 'number' && event.mono_us > lastMonoUs) lastMonoUs = event.mono_us;
    if (event.type === 'error') errorCount += 1;
    if (event.type === 'divergence') divergenceCount += 1;
    if (event.type === 'model.response') {
      const usage = usageOf(attrs(event));
      input += usage.input;
      output += usage.output;
    }
    if (event.type === 'run.end') {
      const code = num(attrs(event)['exit_code']);
      if (code !== undefined) exitFromEvents = code;
    }
  }

  const adapter = manifest.adapter ?? { id: 'unknown' };
  const wallMs =
    manifest.ended_at && manifest.created_at
      ? Date.parse(manifest.ended_at) - Date.parse(manifest.created_at)
      : 0;

  return {
    runId: manifest.run_id,
    adapter: adapter.version ? `${adapter.id}@${adapter.version}` : adapter.id,
    // mono_us is authoritative for duration (spec §2.1); wall clock is only a fallback.
    durationMs: events.length > 0 ? Math.round(lastMonoUs / 1000) : Math.max(0, wallMs || 0),
    eventCount: events.length,
    turnCount: turns.size,
    exitCode: manifest.exit_code ?? exitFromEvents ?? null,
    errorCount,
    divergenceCount,
    totalUsage: { input, output },
    blobCount:
      manifest.integrity?.blob_count ?? manifest.counts?.blobs ?? referencedBlobs(events).length,
  };
}

/**
 * Three or more consecutive snapshot-bearing turns that end on the same tree: the agent is
 * working but the workspace is not moving. A derived analyzer of the kind spec §2.3 anticipates
 * with the `note` event type — proof the format is useful to a reader that did not write it.
 *
 * "Consecutive" means consecutive among the turns that carry an `fs.snapshot`; a turn that
 * emitted no snapshot says nothing about the tree either way. Where a turn carries several
 * snapshots, the last one is that turn's end state.
 */
/**
 * Loops, meaning the agent is going round rather than getting somewhere.
 *
 * The first version of this asked whether the filesystem tree had changed, and called three turns
 * on one tree a loop. That is not what a loop is. It fires on any conversation that runs three
 * turns without writing a file — a question answered in prose, a plan discussed before any edit —
 * so a real agent session raised it almost every time and the finding meant nothing. What makes a
 * loop a loop is the agent *repeating itself*, so that is what is looked for here.
 *
 * Two shapes, because agents get stuck in two ways:
 *
 *   - **repeated-action** — the same tool call, or the same short cycle of them, over and over.
 *     Three repetitions, since two of anything is a retry and retries are how agents work.
 *   - **error-spin** — turns that call the model and then do nothing at all, after something has
 *     already failed. Two is enough here: the error is the evidence that the agent was trying,
 *     which is exactly what an ordinary conversation lacks and why this does not fire on one.
 */
export function detectLoops(events: TraceEvent[]): LoopFinding[] {
  return [...repeatedActions(events), ...errorSpins(events)].sort(
    (a, b) => a.fromTurn - b.fromTurn,
  );
}

/** Identity of a tool call: the same tool with the same arguments is the same action. */
function actionSignature(event: TraceEvent): string {
  const a = attrs(event);
  const name = typeof a['name'] === 'string' ? a['name'] : 'tool';
  let input = '';
  try {
    input = JSON.stringify(event.payload ?? a['input'] ?? '');
  } catch {
    // A payload that will not serialise still identifies the tool it belongs to.
  }
  // Bounded so one enormous argument cannot dominate the comparison or the memory.
  return `${name}:${input.slice(0, 512)}`;
}

const MAX_CYCLE = 4;
const MIN_REPEATS = 3;

function repeatedActions(events: TraceEvent[]): LoopFinding[] {
  const calls = events
    .filter((e) => e.type === 'tool.call')
    .map((e) => ({ turn: e.turn, sig: actionSignature(e) }));

  const findings: LoopFinding[] = [];
  let i = 0;
  while (i < calls.length) {
    let best: { period: number; repeats: number } | undefined;
    // Shortest cycle first: a run of one repeated call is that, not a 2-cycle of it with itself.
    for (let period = 1; period <= MAX_CYCLE; period += 1) {
      if (i + period * MIN_REPEATS > calls.length) break;
      let repeats = 1;
      while (
        i + period * (repeats + 1) <= calls.length &&
        matchesCycle(calls, i, period, repeats)
      ) {
        repeats += 1;
      }
      if (repeats >= MIN_REPEATS) {
        best = { period, repeats };
        break;
      }
    }
    if (best === undefined) {
      i += 1;
      continue;
    }
    const span = calls.slice(i, i + best.period * best.repeats);
    const turns = [...new Set(span.map((c) => c.turn))].sort((a, b) => a - b);
    findings.push({
      fromTurn: turns[0]!,
      toTurn: turns[turns.length - 1]!,
      turns,
      kind: 'repeated-action',
      signature: span[0]!.sig.slice(0, 120),
      repeats: best.repeats,
    });
    i += best.period * best.repeats;
  }
  return findings;
}

/** Whether the `repeats`-th repetition of a `period`-length cycle starting at `i` matches. */
function matchesCycle(
  calls: { sig: string }[],
  i: number,
  period: number,
  repeats: number,
): boolean {
  for (let k = 0; k < period; k += 1) {
    if (calls[i + k]!.sig !== calls[i + repeats * period + k]!.sig) return false;
  }
  return true;
}

const MIN_SPIN_TURNS = 2;

function errorSpins(events: TraceEvent[]): LoopFinding[] {
  const turns = [...new Set(events.map((e) => e.turn))].sort((a, b) => a - b);
  const called = new Set<number>();
  const modelled = new Set<number>();
  const changed = new Set<number>();
  let firstErrorTurn: number | undefined;

  for (const event of events) {
    if (event.type === 'tool.call') called.add(event.turn);
    if (event.type === 'model.request') modelled.add(event.turn);
    if (event.type === 'fs.snapshot' && Number(attrs(event)['changes'] ?? 0) > 0) {
      changed.add(event.turn);
    }
    const isError =
      event.type === 'error' || (event.type === 'tool.result' && attrs(event)['is_error'] === true);
    if (isError && firstErrorTurn === undefined) firstErrorTurn = event.turn;
  }

  /** A turn that asked the model something and then did nothing with the answer. */
  const spinning = (turn: number): boolean =>
    modelled.has(turn) && !called.has(turn) && !changed.has(turn);

  const findings: LoopFinding[] = [];
  let start = 0;
  while (start < turns.length) {
    if (!spinning(turns[start]!)) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < turns.length && spinning(turns[end + 1]!)) end += 1;
    const run = turns.slice(start, end + 1);
    // Only after something has failed. Without that, turns like these are a conversation.
    const afterError = firstErrorTurn !== undefined && run[0]! >= firstErrorTurn;
    if (run.length >= MIN_SPIN_TURNS && afterError) {
      findings.push({
        fromTurn: run[0]!,
        toTurn: run[run.length - 1]!,
        turns: run,
        kind: 'error-spin',
        tree: treeAt(events, run[run.length - 1]!),
      });
    }
    start = end + 1;
  }
  return findings;
}

/** The last filesystem tree seen in a turn, as context on a finding. */
function treeAt(events: TraceEvent[], turn: number): string | undefined {
  let tree: string | undefined;
  for (const event of events) {
    if (event.type !== 'fs.snapshot' || event.turn !== turn) continue;
    const value = attrs(event)['tree'];
    if (typeof value === 'string' && value !== '') tree = value;
  }
  return tree;
}

/** `842ms`, `9.4s`, `42s`, `4m 51s`, `2h 14m`. Fixed shapes so columns line up. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 9950) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** `512 B`, `20 KB`, `1.2 MB`. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${shown} ${BYTE_UNITS[unit]}`;
}

/** `8,412`. Grouped by hand rather than by locale so exports look the same everywhere. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n);
  const grouped = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rounded < 0 ? `-${grouped}` : grouped;
}

/** Playback rates offered by the viewer. Real time first — it is the honest default. */
export const PLAYBACK_SPEEDS = [1, 4, 16] as const;

/** Shortest pause that still reads as a distinct step rather than a flicker. */
const MIN_STEP_MS = 60;
/** Longest pause worth watching. A ten-minute stall should register, not be endured. */
const MAX_STEP_MS = 1000;

/**
 * How long to hold on each row when playing a trace back.
 *
 * The recorded gaps are the only thing playback adds over pressing `j` repeatedly — they are what
 * makes a stall or a tight retry loop *feel* different. So the shape is preserved and merely
 * compressed: a square-root curve keeps small gaps distinguishable while stopping a long wait
 * from becoming a long animation. A uniform tick would be simpler and would say nothing.
 */
export function playbackDelays(rows: Array<{ monoUs: number }>, speed: number): number[] {
  const rate = speed > 0 ? speed : 1;
  return rows.map((row, i) => {
    if (i === 0) return 0;
    const previous = rows[i - 1];
    // A trace is external input; a clock that went backwards must not produce a negative wait.
    const gapMs = Math.max(0, (row.monoUs - (previous?.monoUs ?? row.monoUs)) / 1000);
    const compressed = Math.sqrt(gapMs / rate) * 24;
    return Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, Math.round(compressed)));
  });
}
