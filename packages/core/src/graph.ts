import type { TraceEvent } from '@orcareplay/schema';

/** A forkable point in a run. Derived from the log, never recorded (spec §3). */
export interface Checkpoint {
  seq: number;
  turn: number;
  /** Tree id from the governing `fs.snapshot`, when it recorded one. */
  fsTree?: string;
}

export interface Turn {
  turn: number;
  startSeq: number;
  endSeq: number;
  events: TraceEvent[];
}

export interface SnapResult {
  checkpoint: Checkpoint;
  /** True when the target was not itself a checkpoint and had to move back. */
  snapped: boolean;
}

function bySeq(events: TraceEvent[]): TraceEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq);
}

/**
 * The seq of the first `model.request` with no reply, or Infinity when the conversation is whole.
 *
 * Requests and responses are paired in order, so a second request that is still in flight is not
 * excused by the first one's reply. Everything after an unanswered request is un-forkable: the
 * model's effect on the run is unknown there.
 */
function firstUnansweredRequest(events: TraceEvent[]): number {
  const requests = events.filter((e) => e.type === 'model.request');
  const responses = events.filter((e) => e.type === 'model.response');
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const response = responses[i];
    if (!request) continue;
    if (!response || response.seq <= request.seq) return request.seq;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Every seq that satisfies both checkpoint conditions of spec §3: an `fs.snapshot` at or before it
 * in the same turn, and a complete conversation prefix.
 */
export function deriveCheckpoints(events: TraceEvent[]): Checkpoint[] {
  const ordered = bySeq(events);
  const cutoff = firstUnansweredRequest(ordered);
  const checkpoints: Checkpoint[] = [];
  let snapshot: { turn: number; tree: string | undefined } | undefined;

  for (const e of ordered) {
    if (e.seq > cutoff) break;
    if (e.type === 'fs.snapshot') {
      const tree = e.attrs?.['tree'];
      snapshot = { turn: e.turn, tree: typeof tree === 'string' ? tree : undefined };
    }
    // A snapshot only vouches for the state of its own turn; work in a later turn has moved on.
    if (!snapshot || snapshot.turn !== e.turn) continue;
    const checkpoint: Checkpoint = { seq: e.seq, turn: e.turn };
    if (snapshot.tree !== undefined) checkpoint.fsTree = snapshot.tree;
    checkpoints.push(checkpoint);
  }
  return checkpoints;
}

/**
 * The checkpoint a fork of `target` must actually start from — the nearest preceding one.
 *
 * Never rounds forward. Forking from state the run had not reached yet would produce a child run
 * that silently disagrees with its parent, which is worse than refusing outright.
 */
export function snapToCheckpoint(cps: Checkpoint[], target: number): SnapResult {
  const ordered = [...cps].sort((a, b) => a.seq - b.seq);
  if (ordered.length === 0) {
    throw new Error(
      `cannot fork at seq ${target}: this run has no checkpoints — it recorded no fs.snapshot`,
    );
  }
  let found: Checkpoint | undefined;
  for (const cp of ordered) {
    if (cp.seq > target) break;
    found = cp;
  }
  if (!found) {
    throw new Error(
      `no checkpoint at or before ${target}: the earliest forkable seq is ${ordered[0]?.seq}`,
    );
  }
  return { checkpoint: found, snapped: found.seq !== target };
}

/** The events of a run grouped into model turns, in turn order. */
export function turnsOf(events: TraceEvent[]): Turn[] {
  const byTurn = new Map<number, TraceEvent[]>();
  for (const e of bySeq(events)) {
    const bucket = byTurn.get(e.turn);
    if (bucket) bucket.push(e);
    else byTurn.set(e.turn, [e]);
  }
  return [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turn, group]) => ({
      turn,
      startSeq: group[0]?.seq ?? 0,
      endSeq: group[group.length - 1]?.seq ?? 0,
      events: group,
    }));
}

/** The event at `seq` and everything transitively named by `causes`, oldest first. */
export function causalChain(events: TraceEvent[], seq: number): TraceEvent[] {
  const index = new Map(events.map((e) => [e.seq, e]));
  const start = index.get(seq);
  if (!start) throw new Error(`no event with seq ${seq} in this trace`);

  const seen = new Set<number>([seq]);
  const queue = [start];
  const chain: TraceEvent[] = [];
  while (queue.length > 0) {
    const event = queue.shift();
    if (!event) break;
    chain.push(event);
    for (const cause of event.causes ?? []) {
      // A cycle is malformed, and an ancestor may be missing because the reader skipped an
      // unknown event type. Neither may stop the walk.
      if (seen.has(cause)) continue;
      seen.add(cause);
      const parent = index.get(cause);
      if (parent) queue.push(parent);
    }
  }
  return chain.sort((a, b) => a.seq - b.seq);
}
