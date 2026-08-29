import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader, listRuns, resolveRunSelector } from '@orcareplay/core';
import { validateEvent, validateManifest, type TraceEvent } from '@orcareplay/schema';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { replayCommand } from '../src/commands/replay.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);
const FAKE_AGENT = join(import.meta.dirname, 'fixtures', 'fake-agent.mjs');

/**
 * Spec §4: "Replay MUST NOT silently approximate. Every inexact match is an event in the trace."
 *
 * The fork path honoured that and the exact path did not — divergences went to a local array, got
 * printed, and were gone with the scrollback. So an exact replay now writes its own run, and these
 * tests are about the two halves of that: the findings actually land on disk, and the run being
 * replayed is not touched to get them there.
 */
describe('exact replay writes a trace of itself', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-rtrace-'));
    model = await startFakeModel();
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 't@e.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'T'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
    process.env.FAKE_AGENT_TURNS = '3';
    // The agent must run in the directory the replay puts it in, exactly as a real harness does.
    delete process.env.FAKE_AGENT_CWD;
  });

  afterEach(async () => {
    delete process.env.FAKE_AGENT_PAD;
    delete process.env.FAKE_AGENT_PROMPT;
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

  async function eventsOf(runId: string): Promise<TraceEvent[]> {
    const dir = (await resolveRunSelector(workspace, runId)).dir;
    return (await TraceReader.open(dir)).events();
  }

  async function manifestOf(runId: string) {
    const dir = (await resolveRunSelector(workspace, runId)).dir;
    return (await TraceReader.open(dir)).manifest();
  }

  it('produces a second run whose manifest names the run it replayed', async () => {
    const recorded = await record();

    const result = await replayCommand(parseArgs(['replay', 'last']), out, workspace);

    expect(result.traceRunId, 'the replay must report the run it wrote').toBeTruthy();
    expect(result.traceRunId).not.toBe(recorded.runId);
    expect((await listRuns(workspace)).length).toBe(2);

    const manifest = await manifestOf(result.traceRunId!);
    expect(manifest.parent_run).toBe(recorded.runId);
    // An exact replay has no checkpoint it forked at, so inventing one would be a lie that
    // `orca list` and `orca show` would both print.
    expect(manifest.fork_point).toBeUndefined();
    expect(validateManifest(manifest).valid).toBe(true);
  });

  it('writes one divergence event per divergence, valid against the normative schema', async () => {
    await record();

    // Same conversation, a system prompt that was not there when it was recorded: the trailing
    // message still matches, so every request matches inexactly rather than halting. That is
    // precisely the case §4 exists for — served from the recording, but not the same request.
    process.env.FAKE_AGENT_PAD = '1';
    const result = await replayCommand(parseArgs(['replay', 'last']), out, workspace);

    expect(result.divergences, 'fixture must actually diverge').toBeGreaterThan(0);

    const events = await eventsOf(result.traceRunId!);
    const divergences = events.filter((e) => e.type === 'divergence');
    expect(divergences.length).toBe(result.divergences);

    for (const d of divergences) {
      expect(d.attrs?.level).toMatch(/^(minor|major)$/);
      expect(d.attrs?.rung).toBeTypeOf('number');
      expect(d.attrs?.detail).toBeTypeOf('string');
      // The seq in the run being replayed, which is the only way back to what was recorded.
      expect(d.attrs?.source_seq).toBeTypeOf('number');
    }

    for (const event of events) {
      const r = validateEvent(event);
      expect(r.valid, `seq ${event.seq}: ${r.errors.join(', ')}`).toBe(true);
    }
  });

  it('still writes a trace when the replay was clean — an empty finding is a finding', async () => {
    await record();

    const result = await replayCommand(parseArgs(['replay', 'last']), out, workspace);
    expect(result.divergences).toBe(0);

    const events = await eventsOf(result.traceRunId!);
    expect(events.some((e) => e.type === 'run.start')).toBe(true);
    expect(events.some((e) => e.type === 'run.end')).toBe(true);
    expect(events.filter((e) => e.type === 'divergence')).toHaveLength(0);

    const end = events.find((e) => e.type === 'run.end');
    expect(end?.attrs?.exit_code).toBe(result.exitCode);
  });

  it('names the run it wrote on the replay.done line', async () => {
    // A run nobody can find is a run nobody reads. This line is the only place the id appears.
    await record();
    const result = await replayCommand(parseArgs(['replay', 'last']), out, workspace);

    const done = lines.find((l) => l.includes('replay.done')) ?? '';
    expect(done, `no replay.done line in:\n${lines.join('\n')}`).toContain(
      `trace=${result.traceRunId}`,
    );
  });

  it('records why it halted, which is the one finding that is nowhere else', async () => {
    // A matched exchange is already in the parent trace. A request the recording cannot answer is
    // not — it existed only in the terminal, and the terminal is where debugging sessions go to
    // die. It is an `error` rather than a `divergence` because nothing was served at all.
    await record();

    process.env.FAKE_AGENT_PROMPT = 'ask something else entirely';
    const result = await replayCommand(parseArgs(['replay', 'last']), out, workspace);
    expect(result.exitCode).not.toBe(0);

    const events = await eventsOf(result.traceRunId!);
    const halt = events.find((e) => e.type === 'error');
    expect(halt, `no halt recorded in:\n${JSON.stringify(events, null, 2)}`).toBeDefined();
    expect(halt?.attrs?.rule).toBe('replay_unmatched');
    expect(String(halt?.attrs?.reason)).toContain('does not match the recording');
    expect(events.find((e) => e.type === 'run.end')?.attrs?.exit_code).toBe(result.exitCode);
    for (const event of events) {
      const r = validateEvent(event);
      expect(r.valid, `seq ${event.seq}: ${r.errors.join(', ')}`).toBe(true);
    }
  });

  it('writes nothing at all under --no-trace', async () => {
    await record();
    const before = await listRuns(workspace);

    const result = await replayCommand(parseArgs(['replay', 'last', '--no-trace']), out, workspace);

    expect(result.traceRunId).toBeUndefined();
    expect((await listRuns(workspace)).map((r) => r.runId)).toEqual(before.map((r) => r.runId));
  });

  it('leaves the replayed run byte-identical, integrity included', async () => {
    // The one that matters most. The run being replayed is append-only and carries a digest over
    // events.jsonl; a replay that wrote so much as a newline into it would invalidate every trace
    // anyone had ever verified.
    const recorded = await record();
    const eventsPath = join(recorded.runDir, 'events.jsonl');
    const before = await readFile(eventsPath);
    const manifestBefore = await readFile(join(recorded.runDir, 'manifest.json'));

    process.env.FAKE_AGENT_PAD = '1';
    await replayCommand(parseArgs(['replay', recorded.runId]), out, workspace);

    expect(await readFile(eventsPath)).toEqual(before);
    expect(await readFile(join(recorded.runDir, 'manifest.json'))).toEqual(manifestBefore);
    expect((await (await TraceReader.open(recorded.runDir)).verifyIntegrity()).ok).toBe(true);
  });
});
