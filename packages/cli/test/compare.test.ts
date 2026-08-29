import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader, deriveCheckpoints, listRuns } from '@orcareplay/core';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { compareCommand, formatCost } from '../src/commands/compare.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, 'fixtures', 'fake-agent.mjs');

describe('compare', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-cmp-'));
    model = await startFakeModel();
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 't@e.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'T'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
    process.env.FAKE_AGENT_TURNS = '3';
    process.env.FAKE_AGENT_CWD = workspace;
  });

  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  async function record() {
    return recordCommand(
      parseArgs([
        'record',
        'generic-openai',
        '--upstream-anthropic',
        model.url,
        '--',
        'node',
        FAKE_AGENT,
      ]),
      out,
      workspace,
    );
  }

  it('needs models, and says how to give them', async () => {
    await expect(compareCommand(parseArgs(['compare', 'last']), out, workspace)).rejects.toThrow(
      /--models/,
    );
  });

  it('forks every model from the SAME parent run, not from the previous fork', async () => {
    const first = await record();
    const events = await (await TraceReader.open(first.runDir)).events();
    const from = deriveCheckpoints(events)[0]!.seq;

    const rows = await compareCommand(
      parseArgs([
        'compare',
        'last',
        '--from',
        String(from),
        '--models',
        'claude-opus-5,glm-5.3-flash,qwen3-coder',
        '--upstream-anthropic',
        model.url,
      ]),
      out,
      workspace,
    );

    expect(rows).toHaveLength(3);
    // The bug this pins: "last" is re-resolved per fork, so after the first branch it points at
    // the fork just created — which has no checkpoints — and every later model fails.
    for (const row of rows) {
      expect(row.error, `${row.model} should not have errored: ${row.error}`).toBeUndefined();
      expect(row.verdict).toBe('pass');
      expect(row.forkRunId).toBeTruthy();
    }
    expect(new Set(rows.map((r) => r.forkRunId)).size).toBe(3);
  });

  it('creates one child run per model, all descended from the original', async () => {
    const first = await record();
    const events = await (await TraceReader.open(first.runDir)).events();
    const from = deriveCheckpoints(events)[0]!.seq;

    await compareCommand(
      parseArgs([
        'compare',
        'last',
        '--from',
        String(from),
        '--models',
        'claude-opus-5,glm-5.3-flash',
        '--upstream-anthropic',
        model.url,
      ]),
      out,
      workspace,
    );

    const runs = await listRuns(workspace);
    expect(runs).toHaveLength(3);

    for (const runRef of runs.filter((r) => r.runId !== first.runId)) {
      const forkEvents = await (await TraceReader.open(runRef.dir)).events();
      const fork = forkEvents.find((e) => e.type === 'fork');
      expect(fork?.attrs?.parent_run, 'every branch must fork the original run').toBe(first.runId);
      expect(fork?.attrs?.fork_point).toBe(from);
    }
  });

  it('prints a verdict table with a dash for an unpriced model, never $0.00', async () => {
    const first = await record();
    const events = await (await TraceReader.open(first.runDir)).events();
    const from = deriveCheckpoints(events)[0]!.seq;

    await compareCommand(
      parseArgs([
        'compare',
        'last',
        '--from',
        String(from),
        '--models',
        'claude-opus-5,not-a-real-model',
        '--upstream-anthropic',
        model.url,
      ]),
      out,
      workspace,
    );

    const text = lines.join('');
    expect(text).toMatch(/MODEL\s+VERDICT\s+TOKENS\s+COST/);
    // A confidently wrong cost is worse than an absent one when it lands in a comparison table.
    expect(text).toContain('—');
  });
});

describe('cost formatting', () => {
  it('never renders a real cost as $0.0000', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(5.8123)).toBe('$5.8123');
    // The two that matter: a cheap model is the reason the column exists.
    expect(formatCost(0.00004)).not.toMatch(/^\$0\.0000$/);
    expect(formatCost(0.000_002)).not.toMatch(/^\$0\.0000$/);
  });
});
