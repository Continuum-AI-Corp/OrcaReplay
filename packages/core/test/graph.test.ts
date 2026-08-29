import type { EventType, TraceEvent } from '@orcareplay/schema';
import { describe, expect, it } from 'vitest';
import { causalChain, deriveCheckpoints, snapToCheckpoint, turnsOf } from '../src/graph.js';

function ev(seq: number, type: EventType, over: Partial<TraceEvent> = {}): TraceEvent {
  return {
    seq,
    ts: '2026-08-29T10:00:00.000Z',
    mono_us: seq * 1000,
    turn: 0,
    type,
    actor: 'orca',
    ...over,
  };
}

/** run.start, a snapshot, then a complete model exchange, then a note. */
const simple: TraceEvent[] = [
  ev(0, 'run.start'),
  ev(1, 'fs.snapshot', { attrs: { tree: 'tree-a' } }),
  ev(2, 'model.request', { actor: 'gateway' }),
  ev(3, 'model.response', { actor: 'model' }),
  ev(4, 'note'),
];

describe('deriveCheckpoints', () => {
  it('finds nothing without an fs.snapshot — there is no state to fork from', () => {
    expect(deriveCheckpoints([ev(0, 'run.start'), ev(1, 'note')])).toEqual([]);
  });

  it('starts at the snapshot, never before it', () => {
    expect(deriveCheckpoints(simple).map((c) => c.seq)).toEqual([1, 2, 3, 4]);
  });

  it('carries the tree id from the governing snapshot', () => {
    for (const cp of deriveCheckpoints(simple)) expect(cp.fsTree).toBe('tree-a');
  });

  it('uses the most recent snapshot in the turn', () => {
    const events = [
      ev(0, 'fs.snapshot', { attrs: { tree: 'old' } }),
      ev(1, 'note'),
      ev(2, 'fs.snapshot', { attrs: { tree: 'new' } }),
      ev(3, 'note'),
    ];
    const cps = deriveCheckpoints(events);
    expect(cps.find((c) => c.seq === 1)?.fsTree).toBe('old');
    expect(cps.find((c) => c.seq === 3)?.fsTree).toBe('new');
  });

  it('leaves fsTree unset when the snapshot did not record a tree', () => {
    const cps = deriveCheckpoints([ev(0, 'fs.snapshot'), ev(1, 'note')]);
    expect(cps.map((c) => c.seq)).toEqual([0, 1]);
    expect(cps[0]?.fsTree).toBeUndefined();
  });

  it('does not carry a snapshot across a turn boundary', () => {
    const events = [
      ev(0, 'fs.snapshot', { attrs: { tree: 'tree-a' } }),
      ev(1, 'note'),
      ev(2, 'note', { turn: 1 }),
    ];
    expect(deriveCheckpoints(events).map((c) => c.seq)).toEqual([0, 1]);
  });

  it('records the turn of each checkpoint', () => {
    const events = [
      ev(0, 'fs.snapshot', { attrs: { tree: 't0' } }),
      ev(1, 'fs.snapshot', { turn: 1, attrs: { tree: 't1' } }),
      ev(2, 'note', { turn: 1 }),
    ];
    expect(deriveCheckpoints(events)).toEqual([
      { seq: 0, turn: 0, fsTree: 't0' },
      { seq: 1, turn: 1, fsTree: 't1' },
      { seq: 2, turn: 1, fsTree: 't1' },
    ]);
  });

  it('stops at an unanswered model.request — state past it is unknown', () => {
    const events = [
      ev(0, 'fs.snapshot', { attrs: { tree: 'tree-a' } }),
      ev(1, 'model.request', { actor: 'gateway' }),
      ev(2, 'note'),
      ev(3, 'note'),
    ];
    // The hung request itself is still forkable: that is the point someone wants to retry.
    expect(deriveCheckpoints(events).map((c) => c.seq)).toEqual([0, 1]);
  });

  it('resumes across turns while every exchange is answered', () => {
    const events = [
      ev(0, 'run.start'),
      ev(1, 'fs.snapshot', { attrs: { tree: 't0' } }),
      ev(2, 'model.request', { actor: 'gateway' }),
      ev(3, 'model.response', { actor: 'model' }),
      ev(4, 'fs.snapshot', { turn: 1, attrs: { tree: 't1' } }),
      ev(5, 'model.request', { turn: 1, actor: 'gateway' }),
    ];
    const cps = deriveCheckpoints(events);
    expect(cps.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(cps.at(-1)?.fsTree).toBe('t1');
  });

  it('pairs requests and responses in order, so one late reply does not unblock the next', () => {
    const events = [
      ev(0, 'fs.snapshot', { attrs: { tree: 't0' } }),
      ev(1, 'model.request', { actor: 'gateway' }),
      ev(2, 'model.response', { actor: 'model' }),
      ev(3, 'model.request', { actor: 'gateway' }),
      ev(4, 'note'),
    ];
    expect(deriveCheckpoints(events).map((c) => c.seq)).toEqual([0, 1, 2, 3]);
  });

  it('reads events that arrive out of order', () => {
    const shuffled = [simple[3]!, simple[0]!, simple[4]!, simple[2]!, simple[1]!];
    expect(deriveCheckpoints(shuffled).map((c) => c.seq)).toEqual([1, 2, 3, 4]);
  });

  it('handles an empty trace', () => {
    expect(deriveCheckpoints([])).toEqual([]);
  });
});

describe('snapToCheckpoint', () => {
  const cps = deriveCheckpoints([
    ev(0, 'run.start'),
    ev(1, 'fs.snapshot', { attrs: { tree: 't0' } }),
    ev(2, 'note'),
    ev(3, 'fs.snapshot', { turn: 1, attrs: { tree: 't1' } }),
    ev(4, 'note', { turn: 1 }),
  ]);

  it('does not move when the target is already a checkpoint', () => {
    const { checkpoint, snapped } = snapToCheckpoint(cps, 3);
    expect(checkpoint.seq).toBe(3);
    expect(snapped).toBe(false);
  });

  it('moves back to the nearest preceding checkpoint and says so', () => {
    const gapped = [
      { seq: 2, turn: 0, fsTree: 't0' },
      { seq: 7, turn: 1, fsTree: 't1' },
    ];
    const { checkpoint, snapped } = snapToCheckpoint(gapped, 5);
    expect(checkpoint.seq).toBe(2);
    expect(snapped).toBe(true);
  });

  it('never snaps forward, at any target — forking from later state is silent corruption', () => {
    const gapped = [
      { seq: 2, turn: 0 },
      { seq: 5, turn: 1 },
      { seq: 9, turn: 2 },
    ];
    for (let target = 2; target <= 14; target++) {
      const { checkpoint, snapped } = snapToCheckpoint(gapped, target);
      expect(checkpoint.seq, `target ${target}`).toBeLessThanOrEqual(target);
      const expected = Math.max(...gapped.filter((c) => c.seq <= target).map((c) => c.seq));
      expect(checkpoint.seq, `target ${target}`).toBe(expected);
      expect(snapped).toBe(checkpoint.seq !== target);
    }
  });

  it('snaps a target past the end back to the last checkpoint', () => {
    const { checkpoint, snapped } = snapToCheckpoint(cps, 9999);
    expect(checkpoint.seq).toBe(4);
    expect(snapped).toBe(true);
  });

  it('returns the checkpoint whole, including its tree', () => {
    expect(snapToCheckpoint(cps, 4).checkpoint).toEqual({ seq: 4, turn: 1, fsTree: 't1' });
  });

  it('refuses a target before the first checkpoint instead of guessing', () => {
    expect(() => snapToCheckpoint(cps, 0)).toThrow(/no checkpoint at or before 0/);
    expect(() => snapToCheckpoint(cps, 0)).toThrow(/1/);
  });

  it('refuses when the trace has no checkpoints at all', () => {
    expect(() => snapToCheckpoint([], 4)).toThrow(/no checkpoints/i);
  });

  it('tolerates an unsorted checkpoint list', () => {
    const unsorted = [
      { seq: 9, turn: 2 },
      { seq: 2, turn: 0 },
      { seq: 5, turn: 1 },
    ];
    expect(snapToCheckpoint(unsorted, 8).checkpoint.seq).toBe(5);
  });
});

describe('turnsOf', () => {
  it('groups events into turns with their span', () => {
    const events = [
      ev(0, 'run.start'),
      ev(1, 'note'),
      ev(2, 'note', { turn: 1 }),
      ev(3, 'run.end', { turn: 1 }),
    ];
    const turns = turnsOf(events);
    expect(turns.map((t) => [t.turn, t.startSeq, t.endSeq])).toEqual([
      [0, 0, 1],
      [1, 2, 3],
    ]);
    expect(turns[1]?.events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('orders turns numerically even when the log interleaves them', () => {
    const events = [
      ev(0, 'note', { turn: 2 }),
      ev(1, 'note', { turn: 1 }),
      ev(2, 'note', { turn: 2 }),
    ];
    expect(turnsOf(events).map((t) => t.turn)).toEqual([1, 2]);
    expect(turnsOf(events)[1]?.events).toHaveLength(2);
  });

  it('handles an empty trace', () => {
    expect(turnsOf([])).toEqual([]);
  });
});

describe('causalChain', () => {
  const events = [
    ev(0, 'run.start'),
    ev(1, 'model.request', { causes: [0] }),
    ev(2, 'model.response', { causes: [1] }),
    ev(3, 'tool.call', { causes: [2] }),
    ev(4, 'note'),
  ];

  it('walks causes transitively, oldest first, ending at the event asked about', () => {
    expect(causalChain(events, 3).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it('returns just the event when nothing caused it', () => {
    expect(causalChain(events, 4).map((e) => e.seq)).toEqual([4]);
  });

  it('visits a shared ancestor once', () => {
    const diamond = [
      ev(0, 'run.start'),
      ev(1, 'tool.call', { causes: [0] }),
      ev(2, 'tool.call', { causes: [0] }),
      ev(3, 'note', { causes: [1, 2] }),
    ];
    expect(causalChain(diamond, 3).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it('terminates on a malformed cycle instead of hanging', () => {
    const cyclic = [ev(0, 'note', { causes: [1] }), ev(1, 'note', { causes: [0] })];
    expect(causalChain(cyclic, 1).map((e) => e.seq)).toEqual([0, 1]);
  });

  it('skips a cause that is not in the trace, since readers may drop unknown events', () => {
    const gapped = [ev(0, 'run.start'), ev(2, 'note', { causes: [1, 0] })];
    expect(causalChain(gapped, 2).map((e) => e.seq)).toEqual([0, 2]);
  });

  it('reports a seq that is not in the trace', () => {
    expect(() => causalChain(events, 42)).toThrow(/42/);
  });
});
