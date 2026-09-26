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

describe('compare without --models', () => {
  /**
   * This test used to swap `XDG_CONFIG_HOME` itself, because `compareCommand` falls back to
   * `readConfig()` and so read the *real* `~/.config/orca`: on a machine where anyone had run
   * `orca setup`, that config has models in it and this never reached the branch it names.
   *
   * vitest.setup.ts now does that for the whole suite, and for a larger reason than this test —
   * the same fallback was sending live requests to the developer's gateway from the fork tests.
   */
  it('tells you both ways to supply models when none are available', async () => {
    const lines: string[] = [];
    const out = new Output({ write: (l) => void lines.push(l), isTTY: false });
    const home = await mkdtemp(join(tmpdir(), 'orca-cmp-cfg-'));
    try {
      await expect(compareCommand(parseArgs(['compare', 'last']), out, home)).rejects.toThrow(
        /orca setup/,
      );
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

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
    // Same reason as the block above: without an empty config this reads the developer's own
    // `orca setup` models, never reaches the branch, and fails on "no runs recorded" instead.
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(workspace, 'empty-config');
    try {
      await expect(compareCommand(parseArgs(['compare', 'last']), out, workspace)).rejects.toThrow(
        /--models/,
      );
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
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

  /**
   * A RUN CAN ARRIVE WITHOUT THE STORE ITS OWN EVENTS POINT AT.
   *
   * `orca pull` produces one unless the run was pushed with `--fs`: the archive then carries
   * manifest.json, events.jsonl, redactions.json and blobs/ — not `fs/` — so a pulled run's
   * `fs.snapshot` events name trees whose objects were never sent. The restore then died inside git with "failed to unpack tree
   * object <40 hex>", which names neither the cause nor anything to do about it, on the exact path
   * the gateway console prints under "fork it locally": `orca pull <run>`, then `orca compare`.
   *
   * Deleting the store is what the wire leaves behind, so that is what this sets up.
   */
  it('says why a run without its snapshots cannot be forked, and forks it anyway with --no-fs', async () => {
    const first = await record();
    const events = await (await TraceReader.open(first.runDir)).events();
    const from = deriveCheckpoints(events)[0]!.seq;
    await rm(join(first.runDir, 'fs'), { recursive: true, force: true });

    const argv = (extra: string[]) =>
      parseArgs([
        'compare',
        'last',
        '--from',
        String(from),
        '--models',
        'claude-opus-5',
        '--upstream-anthropic',
        model.url,
        ...extra,
      ]);

    const refused = await compareCommand(argv([]), out, workspace);
    expect(refused[0]!.verdict).toBe('fail');
    expect(refused[0]!.error, 'the error should name the missing snapshot').toMatch(
      /no workspace snapshot/,
    );
    // The detail belongs where a reader will find it. `compare` renders each leg's error in one
    // cell of a table, so the cause and the way out go in the warning rather than the message.
    const warned = lines.find((l) => l.includes('fork.no_snapshot'));
    expect(warned, 'fork.no_snapshot was not reported').toBeDefined();
    expect(warned).toMatch(/--no-fs/);

    // And the way out has to work, or the diagnosis is just a nicer dead end. This also covers the
    // forwarding: `compare` builds a fresh argv per fork, and a flag accepted here and dropped
    // there is the silent no-op that list already warns about twice.
    const forked = await compareCommand(argv(['--no-fs']), out, workspace);
    expect(forked[0]!.error, `--no-fs should have forked: ${forked[0]!.error}`).toBeUndefined();
    expect(forked[0]!.verdict).toBe('pass');
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

describe('verify command', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-verify-'));
    model = await startFakeModel();
    out = new Output({ write: () => {}, isTTY: false });
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 't@e.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'T'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
    process.env.FAKE_AGENT_TURNS = '3';
    // Deliberately NOT pinning FAKE_AGENT_CWD: the agent should write to its own working
    // directory, which is the fork worktree during a fork — that is what a real agent does, and
    // it is the only way this test can tell the worktree and the workspace apart.
    delete process.env.FAKE_AGENT_CWD;
  });

  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  async function compareWith(verify: string[]) {
    const first = await recordCommand(
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
    const events = await (await TraceReader.open(first.runDir)).events();
    const from = deriveCheckpoints(events)[0]!.seq;
    return compareCommand(
      parseArgs([
        'compare',
        'last',
        '--from',
        String(from),
        '--models',
        'claude-opus-5',
        '--upstream-anthropic',
        model.url,
        ...verify,
      ]),
      out,
      workspace,
    );
  }

  it('fails the verdict when the verify command fails, even though the agent exited 0', async () => {
    const rows = await compareWith(['--verify', 'exit 1']);
    // Without --verify, "pass" only means the agent did not crash — which is not the question
    // anyone is asking of a comparison table.
    expect(rows[0]!.verdict).toBe('fail');
    expect(rows[0]!.verifyExitCode).toBe(1);
  });

  it('passes the verdict when the verify command passes', async () => {
    const rows = await compareWith(['--verify', 'exit 0']);
    expect(rows[0]!.verdict).toBe('pass');
    expect(rows[0]!.verifyExitCode).toBe(0);
  });

  it('runs the verify command inside the fork worktree, not the original workspace', async () => {
    // auth.ts only contains "fixed = true" in the fork, where the agent wrote it.
    const rows = await compareWith(['--verify', 'grep -q "fixed = true" auth.ts']);
    expect(rows[0]!.verdict).toBe('pass');
  });

  it('falls back to the agent exit code when no verify command is given', async () => {
    const rows = await compareWith([]);
    expect(rows[0]!.verifyExitCode).toBeUndefined();
    expect(rows[0]!.verdict).toBe('pass');
  });
});
