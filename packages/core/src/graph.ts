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

/** Where an edge came from. The distinction is the whole honesty mechanism — see `runGraph`. */
export type EdgeKind = 'recorded' | 'inferred';

export interface GraphNode {
  seq: number;
  turn: number;
  type: TraceEvent['type'];
  attrs?: Record<string, unknown>;
}

export interface GraphEdge {
  /** The cause. Always less than `to`, as spec §2.1 requires of `causes`. */
  from: number;
  to: number;
  kind: EdgeKind;
  /** Why this edge exists. For an inferred edge, the rule that produced it. */
  rule: string;
}

export interface RunGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * What a recorded pair means, when the pair is one orca itself writes.
 *
 * `causes` says *that* one event caused another and never *why*, so this is a post-hoc reading of
 * the type pair rather than anything the trace claims. An unrecognised pair says `causes` and
 * stops there, which is the honest answer for an edge written by a reader we do not know.
 */
const RECORDED_RULES: Record<string, string> = {
  'tool.call→tool.result': 'tool result answers its call',
  'shell.exec→shell.result': 'shell result answers its exec',
  'net.request→net.response': 'network response answers its request',
  'model.response→tool.call': 'tool_use block in the response',
  'tool.result→model.request': 'tool_result block in the request',
};

const ARGV_RULE = 'argv matches tool input, same or previous turn';
const PATH_RULE = 'changed path appears in tool input, same or previous turn';

/**
 * How many turns back an effect may reach for the call that caused it.
 *
 * One, not zero. A snapshot is taken when the turn's exchange is persisted, which races the agent
 * actually running the tool — an end-to-end recording produced the edit in the turn's own snapshot
 * on one run and in the next turn's on another. A same-turn rule therefore made the graph differ
 * between two identical runs. Not more than one either: an effect two turns later would have been
 * reported by the snapshot in between.
 */
const TURN_REACH = 1;

/** The longest string in an argv array — in practice the command, not the shell that ran it. */
function commandOf(argv: unknown): string {
  if (!Array.isArray(argv)) return '';
  let longest = '';
  for (const part of argv) {
    if (typeof part === 'string' && part.length > longest.length) longest = part;
  }
  return longest;
}

function inputText(call: TraceEvent): string {
  const input = (call.attrs ?? {})['input'];
  if (input === undefined) return '';
  try {
    return typeof input === 'string' ? input : (JSON.stringify(input) ?? '');
  } catch {
    return '';
  }
}

/**
 * The one tool call that can be said to have caused `effect`, or undefined when that is not
 * exactly one call.
 *
 * Candidates are calls whose input names `needle`, that happened first, and that are within
 * `TURN_REACH` turns. Of those, only the nearest turn is considered: a later call supersedes an
 * earlier one, since a file edited twice was last edited by the most recent call to name it.
 *
 * Two calls in that nearest turn is the case worth dwelling on. Picking either would produce an
 * edge indistinguishable from a true one and wrong half the time, and a wrong edge is worse than
 * a missing one because the missing one is visible. So ambiguity yields nothing.
 */
function soleMatchingCall(
  calls: TraceEvent[],
  effect: TraceEvent,
  needle: string,
): TraceEvent | undefined {
  if (needle === '') return undefined;
  const candidates = calls.filter(
    (call) =>
      call.seq < effect.seq &&
      effect.turn - call.turn >= 0 &&
      effect.turn - call.turn <= TURN_REACH &&
      inputText(call).includes(needle),
  );
  if (candidates.length === 0) return undefined;
  const nearest = Math.max(...candidates.map((c) => c.turn));
  const inNearest = candidates.filter((c) => c.turn === nearest);
  return inNearest.length === 1 ? inNearest[0] : undefined;
}

/**
 * A run as nodes and edges, with every edge saying whether the trace vouches for it.
 *
 * Two kinds, and they are not interchangeable. A `recorded` edge came out of `causes`, which the
 * recorder wrote because it watched the relationship happen. An `inferred` edge was derived here,
 * just now, by the named rule — a filesystem snapshot is taken once per turn rather than once per
 * tool call, and shell frames are bucketed into turns by wall clock, so attributing an effect to a
 * *particular* call is a guess however good the heuristic is.
 *
 * Inferred edges are therefore never written back to the trace. That is the same discipline spec
 * §3 applies to checkpoints, which are derived and never recorded, and it exists so that a field
 * a third-party reader trusts never contains something orca made up.
 */
export function runGraph(events: TraceEvent[]): RunGraph {
  const ordered = bySeq(events);
  const present = new Set(ordered.map((e) => e.seq));
  const nodes: GraphNode[] = ordered.map((e) => ({
    seq: e.seq,
    turn: e.turn,
    type: e.type,
    ...(e.attrs === undefined ? {} : { attrs: e.attrs }),
  }));

  const byType = new Map(ordered.map((e) => [e.seq, e.type]));
  const edges: GraphEdge[] = [];

  for (const event of ordered) {
    for (const cause of event.causes ?? []) {
      // A reader may have dropped an event type it did not know (spec §2.3), so an edge can name
      // an ancestor that is not here. Naming a node that does not exist is worse than no edge.
      if (!present.has(cause)) continue;
      const pair = `${byType.get(cause)}→${event.type}`;
      edges.push({
        from: cause,
        to: event.seq,
        kind: 'recorded',
        rule: RECORDED_RULES[pair] ?? 'causes',
      });
    }
  }

  const calls = ordered.filter((e) => e.type === 'tool.call');
  if (calls.length > 0) {
    for (const event of ordered) {
      const attrs = event.attrs ?? {};
      let match: TraceEvent | undefined;
      let rule = '';
      if (event.type === 'shell.exec') {
        match = soleMatchingCall(calls, event, commandOf(attrs['argv']));
        rule = ARGV_RULE;
      } else if (event.type === 'fs.change') {
        const path = attrs['path'];
        match = soleMatchingCall(calls, event, typeof path === 'string' ? path : '');
        rule = PATH_RULE;
      }
      if (match) edges.push({ from: match.seq, to: event.seq, kind: 'inferred', rule });
    }
  }

  edges.sort((a, b) => a.to - b.to || a.from - b.from);
  return { nodes, edges };
}

/**
 * The sub-graph that produced `seq`: that event and everything transitively behind it.
 *
 * `causalChain` walks `causes` alone and so stops at the first inferred hop, which in a real run
 * is the hop from a tool call to the shell command it ran — exactly the one a person following a
 * failure backwards needs. This walks the derived graph instead, so it crosses both kinds.
 */
export function chainTo(graph: RunGraph, seq: number): RunGraph {
  if (!graph.nodes.some((n) => n.seq === seq)) {
    throw new Error(`no event with seq ${seq} in this graph`);
  }
  const incoming = new Map<number, GraphEdge[]>();
  for (const edge of graph.edges) {
    const bucket = incoming.get(edge.to);
    if (bucket) bucket.push(edge);
    else incoming.set(edge.to, [edge]);
  }

  const kept = new Set<number>([seq]);
  const edges: GraphEdge[] = [];
  const queue = [seq];
  while (queue.length > 0) {
    const at = queue.shift();
    if (at === undefined) break;
    for (const edge of incoming.get(at) ?? []) {
      edges.push(edge);
      // A cycle is malformed rather than impossible, and it must not hang the walk.
      if (kept.has(edge.from)) continue;
      kept.add(edge.from);
      queue.push(edge.from);
    }
  }

  return {
    nodes: graph.nodes.filter((n) => kept.has(n.seq)),
    edges: edges.sort((a, b) => a.to - b.to || a.from - b.from),
  };
}
