import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader, deriveCheckpoints, resolveRunSelector } from '@orcareplay/core';
import { validateManifest } from '@orcareplay/schema';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { replayCommand } from '../src/commands/replay.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);
const FAKE_AGENT = join(import.meta.dirname, 'fixtures', 'fake-agent.mjs');

/**
 * The spec gives the manifest `parent_run`, `fork_point` and `fork_model`, and they were dead:
 * fork provenance existed only as an event attribute. Anything reading a fork's manifest — `orca
 * gc` deciding what it may delete, a third-party tool, the Python SDK — saw an orphan.
 */
describe('fork provenance in the manifest', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-prov-'));
    model = await startFakeModel();
    out = new Output({ write: () => {}, isTTY: false });
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

  async function recordThenFork(extra: string[] = []) {
    const parent = await recordCommand(
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
    const events = await (await TraceReader.open(parent.runDir)).events();
    const from = deriveCheckpoints(events)[0]!.seq;
    const fork = await replayCommand(
      parseArgs([
        'replay',
        parent.runId,
        '--from',
        String(from),
        '--upstream-anthropic',
        model.url,
        ...extra,
      ]),
      out,
      workspace,
    );
    const forkDir = (await resolveRunSelector(workspace, fork.forkRunId!)).dir;
    return { parent, fork, from, manifest: (await TraceReader.open(forkDir)).manifest() };
  }

  it("writes the parent run id into the fork's manifest", async () => {
    const { parent, manifest } = await recordThenFork();
    expect(manifest.parent_run).toBe(parent.runId);
  });

  it('writes the fork point', async () => {
    const { from, manifest } = await recordThenFork();
    expect(manifest.fork_point).toBe(from);
  });

  it('writes the substituted model when one was given', async () => {
    const { manifest } = await recordThenFork(['--model', 'glm-5.3-flash']);
    expect(manifest.fork_model).toBe('glm-5.3-flash');
  });

  it('leaves all three absent on a plain recording, not null or empty', async () => {
    const parent = await recordCommand(
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
    const manifest = (await TraceReader.open(parent.runDir)).manifest();
    expect(manifest.parent_run).toBeUndefined();
    expect(manifest.fork_point).toBeUndefined();
    expect(manifest.fork_model).toBeUndefined();
  });

  it('keeps the manifest valid against the normative schema', async () => {
    const { manifest } = await recordThenFork(['--model', 'glm-5.3-flash']);
    const result = validateManifest(manifest);
    expect(result.valid, result.errors.join(', ')).toBe(true);
  });

  it('reports the run it wrote under the name both replay modes share', async () => {
    // An exact replay writes a trace of its own findings and reports it as `traceRunId`. A fork
    // writes a run too, so the field has to mean the same thing here — otherwise a caller asking
    // "what did this invocation produce" gets an answer only half the time. `forkRunId` stays as
    // the narrower claim: there is a *fork*, with a worktree and exchanges of its own.
    const { fork } = await recordThenFork();
    expect(fork.traceRunId).toBe(fork.forkRunId);
  });

  it('still records the fork event, so both sources agree', async () => {
    const { parent, fork, from } = await recordThenFork();
    const forkDir = (await resolveRunSelector(workspace, fork.forkRunId!)).dir;
    const events = await (await TraceReader.open(forkDir)).events();
    const forkEvent = events.find((e) => e.type === 'fork')!;
    expect(forkEvent.attrs?.parent_run).toBe(parent.runId);
    expect(forkEvent.attrs?.fork_point).toBe(from);
  });
});

/**
 * A fork records its own conversation, so it is a run you can read, fork again and graph — and it
 * was writing every model exchange with no `causes` at all. The recorder resolved them and the
 * fork path, a second call site of the same deriver, silently did not.
 */
describe('a fork carries the same causal edges a recording does', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-fork-edges-'));
    model = await startFakeModel();
    out = new Output({ write: () => {}, isTTY: false });
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

  async function forkEvents() {
    const parent = await recordCommand(
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
    const events = await (await TraceReader.open(parent.runDir)).events();
    const from = deriveCheckpoints(events)[0]!.seq;
    const fork = await replayCommand(
      parseArgs([
        'replay',
        parent.runId,
        '--from',
        String(from),
        '--upstream-anthropic',
        model.url,
      ]),
      out,
      workspace,
    );
    const dir = (await resolveRunSelector(workspace, fork.forkRunId!)).dir;
    return (await TraceReader.open(dir)).events();
  }

  it('points a tool.call at the model.response that emitted it', async () => {
    const events = await forkEvents();
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    const calls = events.filter((e) => e.type === 'tool.call');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.causes, `tool.call seq ${call.seq} names no cause`).toHaveLength(1);
      expect(bySeq.get(call.causes![0]!)?.type).toBe('model.response');
    }
  });

  it('points a tool.result back at its call, which it never did either', async () => {
    const events = await forkEvents();
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    const results = events.filter((e) => e.type === 'tool.result');
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.causes).toHaveLength(1);
      expect(bySeq.get(result.causes![0]!)?.type).toBe('tool.call');
    }
  });

  it('keeps every edge pointing backwards, as spec §2.1 requires', async () => {
    for (const event of await forkEvents()) {
      for (const cause of event.causes ?? []) expect(cause).toBeLessThan(event.seq);
    }
  });
});
