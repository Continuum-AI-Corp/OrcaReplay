import { describe, expect, it } from 'vitest';
import { runGraph, chainTo, type RunGraph } from '@orcareplay/core';
import type { EventType, TraceEvent } from '@orcareplay/schema';
import { CREDIT_MADE_BY, CREDIT_REPO } from '@orcareplay/viewer';
import { renderChainCard } from '../src/share-card.js';

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

/** The README's bug: a check exited 1 and the run exited 0 anyway. */
const events: TraceEvent[] = [
  ev(3, 'model.response', { attrs: { stop_reason: 'tool_use' } }),
  ev(4, 'tool.call', {
    causes: [3],
    attrs: { name: 'bash', input: { command: 'node --check auth.ts' } },
  }),
  ev(5, 'shell.exec', { attrs: { argv: ['sh', '-c', 'node --check auth.ts'] } }),
  ev(6, 'shell.result', { causes: [5], attrs: { exit_code: 1 } }),
];

const chain: RunGraph = chainTo(runGraph(events), 6);
const card = (g: RunGraph = chain) => renderChainCard(g, { runId: 'run_6473f858b59e' });

describe('renderChainCard', () => {
  it('is a standalone SVG, so it drops into an issue with nothing installed', () => {
    expect(card().trimStart().startsWith('<svg')).toBe(true);
    expect(card()).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(card().trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('carries no external reference, which is what makes it render in five years', () => {
    expect(card()).not.toMatch(/<image|href=|<script/i);
  });

  it('names every event on the chain, since the chain is the claim', () => {
    const svg = card();
    for (const type of ['model.response', 'tool.call', 'shell.exec', 'shell.result']) {
      expect(svg).toContain(type);
    }
  });

  it('leads with what went wrong rather than with the run id', () => {
    expect(card()).toMatch(/exited 1/);
  });

  /**
   * A dashed edge in a picture that travels without its trace launders a guess into a fact. The
   * legend is not decoration — it is the only thing on the card that says so.
   */
  it('says on its face that a dashed hop was inferred', () => {
    const withInferred = chainTo(runGraph(events), 5);
    expect(renderChainCard(withInferred, { runId: 'r' })).toContain('inferred');
  });

  it('omits the legend when no hop was inferred, rather than explaining nothing', () => {
    const allRecorded = chainTo(
      runGraph([ev(5, 'shell.exec'), ev(6, 'shell.result', { causes: [5] })]),
      6,
    );
    expect(renderChainCard(allRecorded, { runId: 'r' })).not.toContain('inferred');
  });

  it('signs itself, because a card is often the first sight of the project', () => {
    expect(card()).toContain(CREDIT_MADE_BY);
    expect(card()).toContain(CREDIT_REPO);
  });

  it('prints the command that reproduces it, so the picture is checkable', () => {
    expect(card()).toContain('orca graph run_6473f858b59e --to 6');
  });

  it('grows with the chain rather than overflowing a fixed box', () => {
    const short = renderChainCard(chainTo(runGraph(events), 4), { runId: 'r' });
    const long = card();
    const h = (svg: string) => Number(/viewBox="0 0 \d+ (\d+)"/.exec(svg)?.[1]);
    expect(h(long)).toBeGreaterThan(h(short));
  });

  it('escapes a hostile argv rather than letting it close a tag', () => {
    const hostile = [
      ev(5, 'shell.exec', { attrs: { argv: ['sh', '-c', '</text><script>x</script>'] } }),
      ev(6, 'shell.result', { causes: [5], attrs: { exit_code: 1 } }),
    ];
    const svg = renderChainCard(chainTo(runGraph(hostile), 6), { runId: 'r' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;');
  });

  it('renders an empty chain without producing broken markup', () => {
    const svg = renderChainCard({ nodes: [], edges: [] }, { runId: 'r' });
    expect(svg.trimStart().startsWith('<svg')).toBe(true);
    expect(svg).toMatch(/nothing to show|no events/i);
  });
});

/**
 * Caught by looking at a rendered card rather than at its markup: the rail was one line, dashed
 * whenever *any* hop was inferred, which told the reader that every hop was a guess. The legend
 * cannot save a picture whose own lines overstate what the trace vouches for.
 */
describe('renderChainCard rail', () => {
  const mixed: TraceEvent[] = [
    ev(3, 'model.response', { attrs: { stop_reason: 'tool_use' } }),
    ev(4, 'tool.call', { causes: [3], attrs: { name: 'edit', input: { path: 'auth.ts' } } }),
    ev(10, 'fs.change', { turn: 2, attrs: { path: 'auth.ts' } }),
  ];

  it('dashes only the hops that were inferred, not the whole rail', () => {
    const svg = renderChainCard(chainTo(runGraph(mixed), 10), { runId: 'r' });
    const rails = svg.match(/<line[^>]*x1="92"[^>]*>/g) ?? [];
    // 3→4 is recorded and 4→10 is inferred: one segment dashed, one segment solid.
    expect(rails.filter((l) => l.includes('stroke-dasharray'))).toHaveLength(1);
    expect(rails.filter((l) => !l.includes('stroke-dasharray'))).toHaveLength(1);
  });

  it('draws one segment per hop, so each can say what it is', () => {
    const svg = renderChainCard(chainTo(runGraph(mixed), 10), { runId: 'r' });
    expect(svg.match(/<line[^>]*x1="92"/g) ?? []).toHaveLength(2);
  });

  it('dashes nothing when every hop was recorded', () => {
    const recorded = [ev(5, 'shell.exec'), ev(6, 'shell.result', { causes: [5] })];
    const svg = renderChainCard(chainTo(runGraph(recorded), 6), { runId: 'r' });
    expect(svg).not.toContain('stroke-dasharray');
  });
});
