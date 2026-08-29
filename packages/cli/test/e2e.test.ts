import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader, deriveCheckpoints, listRuns, resolveRunSelector } from '@orcareplay/core';
import { isBlobRef, validateEvent, validateManifest } from '@orcareplay/schema';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { replayCommand } from '../src/commands/replay.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, 'fixtures', 'fake-agent.mjs');

/**
 * The acceptance test for the whole project.
 *
 *   orca record <agent>
 *   orca replay last
 *   orca replay last --from N --model <other>
 *
 * If these three work against a real child process, a real proxy and a real trace on disk, the
 * mechanism is proven. Everything else is refinement.
 */
describe('end to end: record → replay → fork', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-e2e-'));
    model = await startFakeModel();
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    // A git repo so the shadow index has something to work with.
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
  });

  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  async function record(turns = 3) {
    const args = parseArgs([
      'record',
      'generic-openai',
      '--upstream-anthropic',
      model.url,
      '--',
      'node',
      FAKE_AGENT,
    ]);
    process.env.FAKE_AGENT_TURNS = String(turns);
    process.env.FAKE_AGENT_CWD = workspace;
    return recordCommand(args, out, workspace);
  }

  it('records a run that validates against the normative schema', async () => {
    const result = await record();

    expect(result.events).toBeGreaterThan(4);

    const reader = await TraceReader.open(result.runDir);
    expect(validateManifest(reader.manifest()).valid).toBe(true);
    for (const event of await reader.events()) {
      const r = validateEvent(event);
      expect(r.valid, `seq ${event.seq}: ${r.errors.join(', ')}`).toBe(true);
    }
  });

  it('captures the tool loop the agent actually ran', async () => {
    const result = await record();
    const reader = await TraceReader.open(result.runDir);
    const events = await reader.events();
    const types = events.map((e) => e.type);

    expect(types).toContain('model.request');
    expect(types).toContain('model.response');
    // The whole thesis: a proxy that only sees model traffic still recovers the tool loop.
    expect(types).toContain('tool.call');
    expect(types).toContain('tool.result');

    const call = events.find((e) => e.type === 'tool.call');
    expect(call?.attrs?.name).toBe('edit_file');
  });

  it('captures the filesystem change the agent made', async () => {
    const result = await record();
    const events = await (await TraceReader.open(result.runDir)).events();
    const changes = events.filter((e) => e.type === 'fs.change');
    expect(changes.some((c) => String(c.attrs?.path).endsWith('auth.ts'))).toBe(true);
    expect(await readFile(join(workspace, 'auth.ts'), 'utf8')).toContain('fixed = true');
  });

  it('verifies its own integrity digest', async () => {
    const result = await record();
    expect((await (await TraceReader.open(result.runDir)).verifyIntegrity()).ok).toBe(true);
  });

  it('replays exactly, with the model server never contacted again', async () => {
    await record();
    const callsAfterRecording = model.calls.length;
    expect(callsAfterRecording).toBeGreaterThan(0);

    const result = await replayCommand(parseArgs(['replay', 'last']), out, workspace);

    expect(result.mode).toBe('exact');
    expect(result.matchedExact).toBeGreaterThan(0);
    expect(result.divergences).toBe(0);
    expect(result.liveCalls).toBe(0);
    expect(model.calls.length, 'exact replay must not reach the network at all').toBe(
      callsAfterRecording,
    );
  });

  it('replays exactly when the recorded bodies are large enough to spill to blobs', async () => {
    // The size is the test. Under the inline limit a body is stored as itself; over it, the writer
    // spills `JSON.stringify(payload)` and the body becomes a quoted, escaped JSON string literal.
    // Replay read those bytes back without undoing the encoding, so it canonicalized an escaped
    // copy — `model: ''`, `messages: []` — and matched nothing against any real harness, which all
    // send a system prompt big enough to spill on turn one. Every other test here stayed under the
    // limit, so all of them passed while replay was completely broken in practice.
    process.env.FAKE_AGENT_PAD = '400';
    try {
      const recorded = await record();
      const events = await (await TraceReader.open(recorded.runDir)).events();
      const request = events.find((e) => e.type === 'model.request');
      expect(isBlobRef(request?.payload), 'fixture must cross the spill boundary').toBe(true);

      const result = await replayCommand(parseArgs(['replay', 'last']), out, workspace);

      expect(result.matchedExact).toBeGreaterThan(0);
      expect(result.divergences).toBe(0);
      expect(result.liveCalls).toBe(0);
    } finally {
      delete process.env.FAKE_AGENT_PAD;
    }
  });

  it('halts with a reason, not a hang, when the agent asks something else', async () => {
    await record();

    // Same recording, different question: nothing can match, and the operator has to be told why.
    process.env.FAKE_AGENT_PROMPT = 'do something completely different';
    try {
      const result = await replayCommand(parseArgs(['replay', 'last']), out, workspace);

      expect(result.matchedExact).toBe(0);
      expect(result.exitCode, 'a halted replay must not look like a clean run').not.toBe(0);
      const halt = lines.find((l) => l.includes('replay.unmatched'));
      expect(halt, `no halt reason in output:\n${lines.join('\n')}`).toBeDefined();
      expect(halt).toContain('does not match the recording');
    } finally {
      delete process.env.FAKE_AGENT_PROMPT;
    }
  });

  it('derives checkpoints you can fork from', async () => {
    const result = await record();
    const events = await (await TraceReader.open(result.runDir)).events();
    const checkpoints = deriveCheckpoints(events);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints[0]!.fsTree).toBeTruthy();
  });

  it('forks from a checkpoint and continues live on a different model', async () => {
    const first = await record();
    const events = await (await TraceReader.open(first.runDir)).events();
    const checkpoint = deriveCheckpoints(events)[0]!;
    const callsBefore = model.calls.length;

    const result = await replayCommand(
      parseArgs([
        'replay',
        'last',
        '--from',
        String(checkpoint.seq),
        '--model',
        'glm-5.3-flash',
        '--upstream-anthropic',
        model.url,
      ]),
      out,
      workspace,
    );

    expect(result.mode).toBe('fork');
    expect(result.forkRunId).toBeTruthy();
    expect(result.forkRunId).not.toBe(first.runId);
    // Live calls happened past the fork point — that is what makes it a fork rather than a replay.
    expect(result.liveCalls).toBeGreaterThan(0);
    expect(model.calls.length).toBeGreaterThan(callsBefore);

    // And the substituted model actually reached the upstream.
    const forkedCalls = model.calls.slice(callsBefore);
    expect(forkedCalls.some((c) => c.body?.model === 'glm-5.3-flash')).toBe(true);
  });

  it('records the fork with provenance pointing back at its parent', async () => {
    const first = await record();
    const events = await (await TraceReader.open(first.runDir)).events();
    const checkpoint = deriveCheckpoints(events)[0]!;

    const result = await replayCommand(
      parseArgs([
        'replay',
        'last',
        '--from',
        String(checkpoint.seq),
        '--model',
        'glm-5.3-flash',
        '--upstream-anthropic',
        model.url,
      ]),
      out,
      workspace,
    );

    const forkDir = (await resolveRunSelector(workspace, result.forkRunId!)).dir;
    const forkEvents = await (await TraceReader.open(forkDir)).events();
    const forkEvent = forkEvents.find((e) => e.type === 'fork');
    expect(forkEvent?.attrs?.parent_run).toBe(first.runId);
    expect(forkEvent?.attrs?.fork_point).toBe(checkpoint.seq);
  });

  it('lists both runs afterwards, newest first', async () => {
    await record();
    const before = (await listRuns(workspace)).length;
    const events = await (await TraceReader.open((await listRuns(workspace))[0]!.dir)).events();
    await replayCommand(
      parseArgs([
        'replay',
        'last',
        '--from',
        String(deriveCheckpoints(events)[0]!.seq),
        '--upstream-anthropic',
        model.url,
      ]),
      out,
      workspace,
    );
    expect((await listRuns(workspace)).length).toBe(before + 1);
  });

  it('never writes the agent api key into the trace', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-e2e-secret-key-should-never-appear-anywhere';
    try {
      const result = await record();
      const raw = await readFile(join(result.runDir, 'events.jsonl'), 'utf8');
      expect(raw).not.toContain('sk-e2e-secret-key-should-never-appear-anywhere');
      const manifest = await readFile(join(result.runDir, 'manifest.json'), 'utf8');
      expect(manifest).not.toContain('sk-e2e-secret-key-should-never-appear-anywhere');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
