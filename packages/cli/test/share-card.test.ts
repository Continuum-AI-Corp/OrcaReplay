import { describe, expect, it } from 'vitest';
import { CREDIT_MADE_BY, CREDIT_REPO } from '@orcareplay/viewer';
import { renderCompareCard } from '../src/share-card.js';
import type { CompareRow } from '../src/commands/compare.js';

const rows: CompareRow[] = [
  {
    model: 'claude-opus-5',
    verdict: 'pass',
    exitCode: 0,
    divergences: 0,
    inputTokens: 182_000,
    outputTokens: 4_100,
    cost: 5.81,
    wallMs: 312_000,
    forkRunId: 'run_a',
  },
  {
    model: 'glm-5.3-flash',
    verdict: 'pass',
    exitCode: 0,
    divergences: 0,
    inputTokens: 196_000,
    outputTokens: 4_400,
    cost: 0.61,
    wallMs: 242_000,
    forkRunId: 'run_b',
  },
  {
    model: 'qwen3-coder',
    verdict: 'fail',
    exitCode: 1,
    divergences: 2,
    inputTokens: 174_000,
    outputTokens: 3_900,
    cost: 0.29,
    wallMs: 191_000,
    forkRunId: 'run_c',
  },
];

const meta = { runId: 'run_9f2c14', forkPoint: 17, verify: 'npm test' };

describe('renderCompareCard', () => {
  it('is one self-contained SVG with no external reference', () => {
    const svg = renderCompareCard(rows, meta);
    expect(svg.trimStart().startsWith('<svg')).toBe(true);
    expect(svg).toMatch(/<\/svg>\s*$/);
    // The point of a share card is that it survives being dropped anywhere, so nothing may be
    // fetched at render time. The xmlns declaration is a namespace identifier, never a request,
    // so the assertion is about actual resource references rather than any URL-shaped string.
    expect(svg).not.toContain('<image');
    expect(svg).not.toMatch(/href\s*=/);
    expect(svg).not.toMatch(/url\(/);
    const urls = [...svg.matchAll(/https?:\/\/[^"' ]+/g)].map((m) => m[0]);
    expect(urls).toEqual(['http://www.w3.org/2000/svg']);
  });

  it('names every model, its verdict and its cost', () => {
    const svg = renderCompareCard(rows, meta);
    for (const row of rows) {
      expect(svg).toContain(row.model);
    }
    expect(svg).toContain('$5.81');
    expect(svg).toContain('$0.61');
  });

  it('states what the verdict actually measured, so the number is not free-floating', () => {
    const svg = renderCompareCard(rows, meta);
    expect(svg).toContain('npm test');
    expect(svg).toContain('17');
  });

  it('escapes trace-derived text — a model name is untrusted input', () => {
    const hostile = [{ ...rows[0]!, model: '</text><script>alert(1)</script>' }];
    const svg = renderCompareCard(hostile, meta);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;');
  });

  it('renders a dash for an unpriced model rather than implying it was free', () => {
    const svg = renderCompareCard([{ ...rows[0]!, cost: null }], meta);
    expect(svg).toContain('—');
    expect(svg).not.toMatch(/\$0\.00\b/);
  });

  it('carries the attribution line that makes sharing a conversion path', () => {
    const svg = renderCompareCard(rows, meta);
    expect(svg).toContain(CREDIT_MADE_BY);
    expect(svg).toContain(CREDIT_REPO);
  });

  // The card and the exported page are the two things a stranger sees first, and they used to
  // carry the same literal in two packages. Asserting against the constant is what keeps a change
  // to one from silently leaving the other behind.
  it('credits the team from the same constant the exported page uses', () => {
    expect(CREDIT_MADE_BY).toContain('@OrcaRouter');
    expect(renderCompareCard(rows, meta)).toContain('text-anchor="end"');
  });

  it('survives an empty comparison without producing broken markup', () => {
    const svg = renderCompareCard([], meta);
    expect(svg.trimStart().startsWith('<svg')).toBe(true);
    expect(svg).toMatch(/<\/svg>\s*$/);
  });

  it('grows its canvas with the number of rows so nothing overflows', () => {
    const short = renderCompareCard(rows.slice(0, 1), meta);
    const long = renderCompareCard([...rows, ...rows], meta);
    const height = (svg: string) => Number(/viewBox="0 0 \d+ (\d+)"/.exec(svg)?.[1]);
    expect(height(long)).toBeGreaterThan(height(short));
  });
});

describe('card geometry', () => {
  it('draws the column headers above the first row, not underneath it', () => {
    // The first version rendered the header labels behind the first row's background rect, so the
    // card shipped with an unlabelled table. Geometry is testable; eyeballing it is not.
    const svg = renderCompareCard(rows, meta);
    const headerY = Number(/<text x="28" y="(\d+)"[^>]*>MODEL</.exec(svg)?.[1]);
    const firstRowRectY = Number(/<rect x="0" y="(\d+)"/.exec(svg)?.[1]);
    expect(headerY).toBeGreaterThan(0);
    expect(firstRowRectY).toBeGreaterThan(headerY);
  });

  it('keeps every row inside the canvas', () => {
    const svg = renderCompareCard([...rows, ...rows], meta);
    const height = Number(/viewBox="0 0 \d+ (\d+)"/.exec(svg)?.[1]);
    const rowTops = [...svg.matchAll(/<rect x="0" y="(\d+)" width="720" height="30"/g)].map((m) =>
      Number(m[1]),
    );
    expect(rowTops.length).toBe(6);
    for (const top of rowTops) expect(top + 30).toBeLessThan(height);
  });
});
