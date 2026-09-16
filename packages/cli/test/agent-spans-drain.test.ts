import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The third transport, through the drain that writes it.
 *
 * `agent-spans.jsonl` is appended to by every Python process the run starts, so what the reader
 * hands the drain is whatever survived several writers sharing one file. The drain then builds a
 * `Date` out of `started_at` and gives it to `TraceWriter.append` as `occurredAt` — and that runs
 * *after* `discardAgentSpanTransport` has taken the file away, deliberately, so a throw there is
 * not one lost span: it is the run ending with no `run.end`, `verifyIntegrity` calling it tampered
 * with, and every span the run recorded already deleted.
 *
 * Planted through `installAgentSpans` so it is the real `record` path that reads it, the same way
 * `shell-frames-drain.test.ts` does for the shim's frames.
 */
const planted = vi.hoisted(() => ({ line: '' }));
vi.mock('../src/agent-spans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent-spans.js')>();
  return {
    ...actual,
    installAgentSpans: async (runDir: string) => {
      const capture = await actual.installAgentSpans(runDir);
      // After the install, so this is what the drain finds; the processor only ever appends.
      if (planted.line !== '') await writeFile(capture.spansPath, `${planted.line}\n`, 'utf8');
      return capture;
    },
  };
});
import { parseArgs } from '../src/args.js';
import { recordCommand } from '../src/commands/record.js';
import { Output } from '../src/out.js';

interface Row {
  type: string;
  ts: string;
  attrs?: Record<string, unknown>;
}

describe('a span line the drain cannot stamp', () => {
  const exec = promisify(execFile);
  let workspace: string;

  beforeEach(async () => {
    planted.line = '';
    workspace = await mkdtemp(join(tmpdir(), 'orca-spans-drain-'));
    await exec('git', ['init', '-q'], { cwd: workspace });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: workspace });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  /** One recorded run, and the events it wrote. */
  async function record(): Promise<Row[]> {
    const agent = join(workspace, 'agent.mjs');
    await writeFile(agent, "console.log('GOT: done');\n");
    const result = await recordCommand(
      parseArgs(['record', 'generic-openai', '--', process.execPath, agent]),
      new Output({ write: () => {}, isTTY: false }),
      workspace,
    );
    const events = join(workspace, '.orca', 'runs', result.runId, 'events.jsonl');
    return (await readFile(events, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Row);
  }

  /**
   * An instant a `date-time` cannot write down.
   *
   * `Date.parse` accepts far more than the schema's `ts` can express — it types `ts` as
   * `date-time`, which admits a four-digit year and nothing else. `+275760-09-13T00:00:00+00:00`
   * parses to 8640000000000000 and formats as `+275760-09-13T00:00:00.000Z`, which `assertEvent`
   * rejects inside `TraceWriter.append`. The other two transports each bound this; this one did
   * not, and the throw lands where the trace is being sealed.
   */
  it('does not take the run down with it, and the run is sealed', async () => {
    planted.line = JSON.stringify({
      kind: 'span',
      type: 'HandoffSpanData',
      span_id: 's1',
      started_at: '+275760-09-13T00:00:00+00:00',
      data: { from_agent: 'A', to_agent: 'B' },
    });

    const rows = await record();
    expect(
      rows.some((row) => row.type === 'run.end'),
      'the run was left unsealed by one span it could not stamp',
    ).toBe(true);
  }, 60_000);

  /** And one it can: the ordinary span still becomes an event, stamped from its own instant. */
  it('keeps a span whose instant the trace can hold', async () => {
    planted.line = JSON.stringify({
      kind: 'span',
      type: 'HandoffSpanData',
      span_id: 's1',
      started_at: '2026-09-12T00:00:00.000Z',
      data: { from_agent: 'A', to_agent: 'B' },
    });

    const rows = await record();
    const handoff = rows.find((row) => row.type === 'agent.handoff');
    expect(handoff, 'the span never reached the trace').toBeDefined();
    expect(handoff!.ts.startsWith('2026-09-12'), `stamped ${handoff!.ts}`).toBe(true);
  }, 60_000);

  /**
   * A record that closes something carries `ended_at` and no `started_at`.
   *
   * Reading only `started_at` left every one of them stamped from the drain's own clock, which
   * runs after the agent has exited. Measured on a three-node graph: all three `graph.node.end`
   * events landed within a millisecond of each other, 600ms after the last node actually finished,
   * so the first node appeared to close after the second had opened — a timeline saying the
   * opposite of what happened, in the one layer whose entire purpose is ordering.
   */
  it('stamps a closing record from the instant it does carry', async () => {
    planted.line = JSON.stringify({
      kind: 'span',
      type: 'LangGraphNodeEnd',
      span_id: 'r1',
      ended_at: '2026-09-12T00:00:00.000Z',
      data: { node: 'validate', step: 2 },
    });

    const rows = await record();
    const end = rows.find((row) => row.type === 'graph.node.end');
    expect(end, 'the span never reached the trace').toBeDefined();
    expect(end!.ts.startsWith('2026-09-12'), `stamped ${end!.ts}`).toBe(true);
  }, 60_000);

  /** And the bound has to cover that field too, or it is a hole the size of the one it closed. */
  it('does not take the run down with an end it cannot stamp either', async () => {
    planted.line = JSON.stringify({
      kind: 'span',
      type: 'LangGraphNodeEnd',
      span_id: 'r1',
      ended_at: '+275760-09-13T00:00:00+00:00',
      data: { node: 'validate' },
    });

    const rows = await record();
    expect(
      rows.some((row) => row.type === 'run.end'),
      'the run was left unsealed by one closing span it could not stamp',
    ).toBe(true);
  }, 60_000);
});
