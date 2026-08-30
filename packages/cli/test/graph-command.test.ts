import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TraceWriter } from '@orcareplay/core';
import { parseArgs } from '../src/args.js';
import { Output, stripAnsi } from '../src/out.js';
import { graphCommand } from '../src/commands/inspect.js';
import { Orca } from '../src/api.js';

interface Seed {
  type: string;
  turn?: number;
  causes?: number[];
  attrs?: Record<string, unknown>;
}

/** The README's bug: the check failed and the run exited 0 anyway. */
const RUN: Seed[] = [
  { type: 'run.start', turn: 0 },
  { type: 'fs.snapshot', turn: 0, attrs: { tree: 'a'.repeat(40), changes: 0 } },
  { type: 'model.request', turn: 1 },
  { type: 'model.response', turn: 1, attrs: { stop_reason: 'tool_use' } },
  {
    type: 'tool.call',
    turn: 1,
    causes: [3],
    attrs: { name: 'bash', input: { command: 'node --check auth.ts' } },
  },
  { type: 'shell.exec', turn: 1, attrs: { argv: ['sh', '-c', 'node --check auth.ts'] } },
  { type: 'shell.result', turn: 1, causes: [5], attrs: { exit_code: 1 } },
  { type: 'run.end', turn: 1, attrs: { exit_code: 0 } },
];

async function seed(events: Seed[] = RUN) {
  const dir = await mkdtemp(join(tmpdir(), 'orca-graph-'));
  const writer = await TraceWriter.create(join(dir, '.orca', 'runs'), {
    adapter: { id: 'claude-code', version: '0.0.0' },
    argv: ['claude-code'],
    cwd: dir,
    orcaVersion: '0.0.0',
  });
  for (const e of events) {
    await writer.append({
      type: e.type as never,
      actor: 'agent',
      turn: e.turn ?? 0,
      ...(e.causes ? { causes: e.causes } : {}),
      ...(e.attrs ? { attrs: e.attrs } : {}),
    });
  }
  await writer.close(0);
  return { dir, runId: writer.runId };
}

async function render(argv: string[], dir: string) {
  const lines: string[] = [];
  const out = new Output({ write: (l) => void lines.push(l), isTTY: false });
  await graphCommand(parseArgs(argv), out, dir);
  return stripAnsi(lines.join('\n'));
}

describe('orca graph', () => {
  it('prints every edge with the event either end, so a row reads on its own', async () => {
    const { dir, runId } = await seed();
    const text = await render(['graph', runId], dir);
    expect(text).toContain('model.response');
    expect(text).toContain('tool.call');
    expect(text).toContain('shell.exec');
    await rm(dir, { recursive: true, force: true });
  });

  // The distinction is the whole honesty mechanism, so it has to survive into what a person reads.
  it('marks which edges the trace vouches for and which it derived', async () => {
    const { dir, runId } = await seed();
    const text = await render(['graph', runId], dir);
    expect(text).toContain('recorded');
    expect(text).toContain('inferred');
    await rm(dir, { recursive: true, force: true });
  });

  it('names the rule behind an inferred edge, so it can be argued with', async () => {
    const { dir, runId } = await seed();
    const text = await render(['graph', runId], dir);
    expect(text).toContain('argv matches tool input');
    await rm(dir, { recursive: true, force: true });
  });

  it('narrows to one chain with --to, which is what a shareable claim needs', async () => {
    const { dir, runId } = await seed();
    const text = await render(['graph', runId, '--to', '6'], dir);
    expect(text).toContain('shell.result');
    // run.start and the snapshot did not contribute, so they are not part of the claim.
    expect(text).not.toContain('run.start');
    await rm(dir, { recursive: true, force: true });
  });

  it('says so plainly when a run has no edges at all', async () => {
    const { dir, runId } = await seed([{ type: 'run.start' }, { type: 'run.end' }]);
    const text = await render(['graph', runId], dir);
    expect(text).toMatch(/no causal edges/i);
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a --to that names no event, rather than printing an empty graph', async () => {
    const { dir, runId } = await seed();
    await expect(render(['graph', runId, '--to', '999'], dir)).rejects.toThrow(/999/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('Orca.graph', () => {
  it('answers as data, since the first consumer is an agent asking why a run failed', async () => {
    const { dir, runId } = await seed();
    const graph = await new Orca({ cwd: dir }).graph(runId);
    expect(graph.edges).toContainEqual({
      from: 3,
      to: 4,
      kind: 'recorded',
      rule: 'tool_use block in the response',
    });
    expect(graph.nodes.map((n) => n.seq)).toContain(0);
    await rm(dir, { recursive: true, force: true });
  });

  it('narrows to the chain that produced one event', async () => {
    const { dir, runId } = await seed();
    const graph = await new Orca({ cwd: dir }).graph(runId, { to: 6 });
    expect(graph.nodes.map((n) => n.seq)).toEqual([3, 4, 5, 6]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('orca graph is discoverable', () => {
  it('appears in the help, or nobody finds it', async () => {
    const { main } = await import('../src/main.js');
    const written: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await main(['--help']);
    } finally {
      process.stdout.write = real;
    }
    expect(stripAnsi(written.join(''))).toContain('orca graph');
  });

  it('is offered to an agent over MCP, since that is who asks why a run failed', async () => {
    const { MCP_TOOLS } = await import('../src/mcp-server.js');
    const tool = MCP_TOOLS.find((t) => t.name === 'orca_graph');
    expect(tool).toBeDefined();
    // The model reads this string and nothing else, so it has to say what the answer means.
    expect(tool!.description).toMatch(/inferred|derived/i);
  });
});

describe('orca export --card', () => {
  async function exportCard(argv: string[], dir: string) {
    const lines: string[] = [];
    const out = new Output({ write: (l) => void lines.push(l), isTTY: false });
    const { exportCommand } = await import('../src/commands/inspect.js');
    await exportCommand(parseArgs(argv), out, dir);
    return stripAnsi(lines.join('\n'));
  }

  it('writes the chain as an SVG rather than the whole-trace page', async () => {
    const { dir, runId } = await seed();
    const text = await exportCard(['export', runId, '--card', 'chain.svg'], dir);
    const svg = await readFile(join(dir, 'chain.svg'), 'utf8');
    expect(svg.trimStart().startsWith('<svg')).toBe(true);
    expect(svg).toContain('shell.result');
    expect(text).toContain('chain.svg');
    await rm(dir, { recursive: true, force: true });
  });

  it('picks the failure without being told which event to draw', async () => {
    const { dir, runId } = await seed();
    await exportCard(['export', runId, '--card', 'chain.svg'], dir);
    const svg = await readFile(join(dir, 'chain.svg'), 'utf8');
    expect(svg).toContain('exited 1');
    await rm(dir, { recursive: true, force: true });
  });

  it('honours --to when the caller knows which event they mean', async () => {
    const { dir, runId } = await seed();
    await exportCard(['export', runId, '--card', 'chain.svg', '--to', '4'], dir);
    const svg = await readFile(join(dir, 'chain.svg'), 'utf8');
    expect(svg).toContain('--to 4');
    await rm(dir, { recursive: true, force: true });
  });

  // A card gets screenshotted whether or not it is the interesting one, so an arbitrary pick
  // travels further than no card at all.
  it('refuses rather than drawing an arbitrary chain when nothing stands out', async () => {
    const { dir, runId } = await seed([{ type: 'run.start' }, { type: 'run.end' }]);
    await expect(exportCard(['export', runId, '--card', 'chain.svg'], dir)).rejects.toThrow(/--to/);
    await rm(dir, { recursive: true, force: true });
  });

  it('still writes the HTML page when no card was asked for', async () => {
    const { dir, runId } = await seed();
    await exportCard(['export', runId, '-o', 'trace.html'], dir);
    const html = await readFile(join(dir, 'trace.html'), 'utf8');
    expect(html).toContain('<!doctype html>');
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * Asking for `--card chain.png` used to write SVG bytes into a file named .png and report
 * success. PNG is the one format that posts to X, so that is exactly the request someone makes,
 * and what they got back was a file no image viewer opens.
 */
describe('card and share filenames', () => {
  async function exportTo(name: string, dir: string) {
    const lines: string[] = [];
    const out = new Output({ write: (l) => void lines.push(l), isTTY: false });
    const { exportCommand } = await import('../src/commands/inspect.js');
    await exportCommand(parseArgs(['export', 'last', '--card', name]), out, dir);
    return stripAnsi(lines.join('\n'));
  }

  it('refuses a raster filename rather than writing SVG bytes into it', async () => {
    const { dir } = await seed();
    await expect(exportTo('chain.png', dir)).rejects.toThrow(/png/i);
    await rm(dir, { recursive: true, force: true });
  });

  it('says what it can write, so the refusal is actionable', async () => {
    const { dir } = await seed();
    await expect(exportTo('chain.gif', dir)).rejects.toThrow(/\.svg/);
    await rm(dir, { recursive: true, force: true });
  });

  it('still accepts an .svg name, in any case', async () => {
    const { dir } = await seed();
    await exportTo('Chain.SVG', dir);
    expect((await readFile(join(dir, 'Chain.SVG'), 'utf8')).startsWith('<svg')).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to an .svg name when the flag carries no value', async () => {
    const { dir } = await seed();
    const lines: string[] = [];
    const out = new Output({ write: (l) => void lines.push(l), isTTY: false });
    const { exportCommand } = await import('../src/commands/inspect.js');
    await exportCommand(parseArgs(['export', 'last', '--card']), out, dir);
    expect((await readFile(join(dir, 'chain.svg'), 'utf8')).startsWith('<svg')).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});
