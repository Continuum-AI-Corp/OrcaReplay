import { describe, expect, it } from 'vitest';
import { runGraph, chainTo, type RunGraph } from '@orcareplay/core';
import type { EventType, TraceEvent } from '@orcareplay/schema';
import { CREDIT_MADE_BY } from '@orcareplay/viewer';
import { renderGraphCard, scopeForCard } from '../src/share-card.js';

function ev(seq: number, type: EventType, over: Partial<TraceEvent> = {}): TraceEvent {
  return {
    seq,
    ts: '2026-08-30T10:00:00.000Z',
    mono_us: seq,
    turn: 1,
    type,
    actor: 'orca',
    ...over,
  };
}

/** Two turns of the loop: an edit, then a check that fails. */
const events: TraceEvent[] = [
  ev(0, 'run.start', { turn: 0 }),
  ev(1, 'fs.snapshot', { turn: 0, attrs: { tree: 'a'.repeat(40) } }),
  ev(2, 'model.request', { turn: 1 }),
  ev(3, 'model.response', { turn: 1, attrs: { stop_reason: 'tool_use' } }),
  ev(4, 'tool.call', { turn: 1, causes: [3], attrs: { name: 'edit', input: { path: 'auth.ts' } } }),
  ev(5, 'fs.change', { turn: 1, attrs: { path: 'auth.ts' } }),
  ev(6, 'tool.result', { turn: 2, causes: [4], attrs: { is_error: false } }),
  ev(7, 'model.request', { turn: 2, causes: [6] }),
  ev(8, 'model.response', { turn: 2, attrs: { stop_reason: 'tool_use' } }),
  ev(9, 'tool.call', {
    turn: 2,
    causes: [8],
    attrs: { name: 'bash', input: { command: 'npm test' } },
  }),
  ev(10, 'shell.exec', { turn: 2, attrs: { argv: ['sh', '-c', 'npm test'] } }),
  ev(11, 'shell.result', { turn: 2, causes: [10], attrs: { exit_code: 1 } }),
];

const graph = runGraph(events);
const highlight = new Set(chainTo(graph, 11).nodes.map((n) => n.seq));
const card = (g: RunGraph = graph, hl = highlight) =>
  renderGraphCard(g, { runId: 'run_6473f858b59e', highlight: hl });

/** y of the first node in each lane, so lane separation can be asserted without pixel-pinning. */
function laneYs(svg: string): number[] {
  return [...new Set([...svg.matchAll(/<circle[^>]*cy="(\d+)"/g)].map((m) => Number(m[1])))].sort(
    (a, b) => a - b,
  );
}

describe('renderGraphCard', () => {
  it('is a standalone SVG with no external reference', () => {
    expect(card().trimStart().startsWith('<svg')).toBe(true);
    expect(card()).not.toMatch(/<image|href=|<script/i);
  });

  it('separates model, tool and effect into their own lanes', () => {
    expect(laneYs(card())).toHaveLength(3);
  });

  it('labels the lanes, or the rows mean nothing', () => {
    const svg = card();
    for (const lane of ['MODEL', 'TOOL', 'EFFECT']) expect(svg).toContain(lane);
  });

  it('marks the turns, because the repeating shape is the thing worth seeing', () => {
    expect(card()).toContain('TURN 1');
    expect(card()).toContain('TURN 2');
  });

  it('draws inferred hops dashed and recorded ones solid', () => {
    const svg = card();
    const edges = svg.match(/<line[^>]*class="e"[^>]*>/g) ?? [];
    expect(edges.filter((l) => l.includes('stroke-dasharray')).length).toBeGreaterThan(0);
    expect(edges.filter((l) => !l.includes('stroke-dasharray')).length).toBeGreaterThan(0);
  });

  it('lights the selected chain so the eye lands on the claim', () => {
    const lit = card().match(/<circle[^>]*class="n on"/g) ?? [];
    expect(lit).toHaveLength(highlight.size);
  });

  it('says how many events it left out, rather than quietly dropping them', () => {
    // run.start and fs.snapshot belong to no lane and are not drawn.
    expect(card()).toMatch(/2 (events )?not shown|2 omitted/i);
  });

  it('signs itself like every other artefact orca hands out', () => {
    expect(card()).toContain(CREDIT_MADE_BY);
  });

  it('escapes hostile text rather than letting it close a tag', () => {
    const hostile = runGraph([
      ev(1, 'tool.call', { attrs: { name: '</text><script>x</script>', input: {} } }),
    ]);
    const svg = renderGraphCard(hostile, { runId: 'r', highlight: new Set() });
    expect(svg).not.toContain('<script>');
  });

  it('renders an empty graph without producing broken markup', () => {
    const svg = renderGraphCard({ nodes: [], edges: [] }, { runId: 'r', highlight: new Set() });
    expect(svg.trimStart().startsWith('<svg')).toBe(true);
    expect(svg).toMatch(/nothing to show|no events/i);
  });
});

/**
 * A graph pane that draws all 400 events of a real run is a hairball, and strictly worse than the
 * list it sits beside. Narrowing to the turns the chain touches keeps the picture readable.
 */
describe('scopeForCard', () => {
  it('narrows nothing in a small run, keeping every event that belongs to a lane', () => {
    const scoped = scopeForCard(graph, highlight, 20);
    expect(scoped.narrowed).toBe(false);
    // run.start and fs.snapshot are not part of the loop and are never drawn; they are counted.
    expect(scoped.nodes.length).toBe(graph.nodes.length - 2);
    expect(scoped.omitted).toBe(2);
    expect(scoped.turns).toEqual([1, 2]);
  });

  it('narrows a wide run to the turns the highlighted chain touches', () => {
    const scoped = scopeForCard(graph, new Set([10, 11]), 4);
    expect(scoped.narrowed).toBe(true);
    expect(scoped.nodes.every((n) => n.turn === 2)).toBe(true);
  });

  it('keeps only edges whose both ends survived, so no edge dangles', () => {
    const scoped = scopeForCard(graph, new Set([10, 11]), 4);
    const kept = new Set(scoped.nodes.map((n) => n.seq));
    for (const e of scoped.edges) {
      expect(kept.has(e.from) && kept.has(e.to)).toBe(true);
    }
  });

  it('says on the card that it narrowed, so the picture is not mistaken for the whole run', () => {
    const scoped = scopeForCard(graph, new Set([10, 11]), 4);
    expect(renderGraphCard(scoped, { runId: 'r', highlight: new Set([10, 11]) })).toMatch(
      /turn 2 of|narrowed/i,
    );
  });
});

/**
 * Seen in a rendered card: a model node's label sat below it, directly under the edge descending
 * to the tool lane, so the line struck through the text. Model edges always descend, so the label
 * belongs above.
 */
describe('renderGraphCard labels', () => {
  it('puts model-lane labels above the node, clear of the edge leaving it', () => {
    const svg = card();
    const node = /<circle[^>]*cx="(\d+)" cy="118"/.exec(svg);
    expect(node).not.toBeNull();
    const cx = node![1];
    const labelY = new RegExp(
      `<text x="${cx}" y="(\\d+(?:\\.\\d+)?)"[^>]*>(?:req|tool_use)</text>`,
    );
    const y = Number(labelY.exec(svg)?.[1]);
    expect(y).toBeLessThan(118);
  });

  it('keeps other lanes labelled below, where nothing crosses them', () => {
    const svg = card();
    const cx = /<circle[^>]*cx="(\d+)" cy="270"/.exec(svg)?.[1];
    const y = Number(
      new RegExp(`<text x="${cx}" y="(\\d+(?:\\.\\d+)?)"[^>]*>auth\\.ts</text>`).exec(svg)?.[1],
    );
    expect(y).toBeGreaterThan(270);
  });
});

/**
 * Found in review. Shell and MCP frames are drained after the agent exits and written with their
 * original turn numbers, so a turn's events are not contiguous in seq. Laying nodes out by seq
 * alone therefore interleaved two turns and drew their bands on top of each other, with both
 * labels inside the overlap.
 */
describe('renderGraphCard turn bands', () => {
  const interleaved: TraceEvent[] = [
    ev(2, 'model.request', { turn: 1 }),
    ev(3, 'model.response', { turn: 1, attrs: { stop_reason: 'tool_use' } }),
    ev(4, 'tool.call', {
      turn: 1,
      causes: [3],
      attrs: { name: 'bash', input: { command: 'npm test' } },
    }),
    ev(5, 'model.request', { turn: 2 }),
    ev(6, 'model.response', { turn: 2, attrs: { stop_reason: 'end_turn' } }),
    // Drained after the agent exited, so it lands late in seq but belongs to turn 1.
    ev(7, 'shell.exec', { turn: 1, attrs: { argv: ['sh', '-c', 'npm test'] } }),
    ev(8, 'shell.result', { turn: 1, causes: [7], attrs: { exit_code: 1 } }),
  ];

  function bands(svg: string): Array<{ x: number; w: number }> {
    return [...svg.matchAll(/<rect x="(-?[\d.]+)" y="84" width="([\d.]+)"/g)].map((m) => ({
      x: Number(m[1]),
      w: Number(m[2]),
    }));
  }

  it('draws turn bands that do not overlap each other', () => {
    const g = runGraph(interleaved);
    const svg = renderGraphCard(scopeForCard(g, new Set()), { runId: 'r', highlight: new Set() });
    const [a, b] = bands(svg).sort((p, q) => p.x - q.x);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.x + a!.w).toBeLessThanOrEqual(b!.x);
  });

  it('keeps a turn together, so a late-drained frame sits with its own turn', () => {
    const g = runGraph(interleaved);
    const svg = renderGraphCard(scopeForCard(g, new Set()), { runId: 'r', highlight: new Set() });
    // seq 7 belongs to turn 1, so it must be drawn left of turn 2's seq 5.
    const x = (seq: number) =>
      Number(
        new RegExp(
          `<circle[^>]*cx="([\\d.]+)" cy="\\d+" r="\\d+"[^>]*/><text x="\\1"[^>]*>${seq}</text>`,
        ).exec(svg)?.[1],
      );
    expect(x(7)).toBeLessThan(x(5));
  });
});

/**
 * Found in review. `pickChainTarget` can name an `error` or a `divergence`, and neither had a lane,
 * so the graph card dropped the very event it was drawn about.
 */
describe('renderGraphCard covers every event a card can be about', () => {
  it('draws an error, rather than silently omitting the subject', () => {
    const g = runGraph([
      ev(1, 'model.response', { attrs: { stop_reason: 'tool_use' } }),
      ev(2, 'error', { causes: [1], attrs: { message: 'boom' } }),
    ]);
    const svg = renderGraphCard(scopeForCard(g, new Set([2])), {
      runId: 'r',
      highlight: new Set([2]),
    });
    expect(svg).toMatch(/<circle[^>]*class="n on"/);
    expect(svg).not.toContain('not shown');
  });

  it('draws a divergence too, which is what a replay trace is about', () => {
    const g = runGraph([ev(1, 'model.request'), ev(2, 'divergence', { causes: [1] })]);
    const svg = renderGraphCard(scopeForCard(g, new Set([2])), {
      runId: 'r',
      highlight: new Set([2]),
    });
    expect(svg).not.toContain('not shown');
  });
});
