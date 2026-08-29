import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader } from '@orcareplay/core';
import { validateEvent } from '@orcareplay/schema';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);

/**
 * Shell capture exists for exactly the facts the protocol layer cannot recover: an exit code, a
 * real duration, and a stdout/stderr split. The model only ever sees the harness's rendering of
 * the output, one turn late.
 */
describe('shell capture', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-shell-e2e-'));
    model = await startFakeModel();
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 't@e.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'T'], { cwd: workspace });

    // An agent that shells out: the shim is the only thing that can see how that went.
    const agent = join(workspace, 'shelling-agent.mjs');
    await writeFile(
      agent,
      [
        "import { execFileSync } from 'node:child_process';",
        "try { execFileSync('sh', ['-c', 'printf hello; printf boom 1>&2; exit 4'], { stdio: 'pipe' }); }",
        'catch { /* the non-zero exit is the point */ }',
        // Then keep running. Frames are drained after the agent exits, so a command that ran and a
        // command that was *stamped* at the drain are indistinguishable unless there is measurable
        // time between them — without this gap the timestamp test passes either way.
        'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);',
        "console.log('agent done');",
      ].join('\n'),
    );
    await chmod(agent, 0o755);
    process.env.FAKE_AGENT_TURNS = '1';
  });

  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  async function record(flags: string[] = []) {
    return recordCommand(
      parseArgs([
        'record',
        'generic-openai',
        '--upstream-anthropic',
        model.url,
        ...flags,
        '--',
        'node',
        join(workspace, 'shelling-agent.mjs'),
      ]),
      out,
      workspace,
    );
  }

  it('timestamps a shell command when it ran, not when the file was drained', async () => {
    // Shell frames are read off disk after the agent exits. Stamping them at write time put every
    // command at the very end of the run, so `mono_us` — which spec §2.1 calls authoritative for
    // duration — described the drain rather than the command, and a command could never be seen to
    // have happened between the model turns it actually sat between.
    const result = await record();
    const events = await (await TraceReader.open(result.runDir)).events();
    const exec = events.find((e) => e.type === 'shell.exec');
    const runEnd = events.find((e) => e.type === 'run.end');
    expect(exec, 'no shell.exec event was recorded').toBeDefined();

    // It ran during the run, not after it — and by a margin the drain cannot fake. The agent sits
    // for 400ms after the command finishes, so a timestamp taken at the drain lands within a few
    // milliseconds of `run.end` while a timestamp taken when the command ran is 400ms clear of it.
    // `toBeLessThanOrEqual` was true of both, which is why the bug survived a passing test.
    expect(Date.parse(runEnd!.ts) - Date.parse(exec!.ts)).toBeGreaterThan(300);
    expect(runEnd!.mono_us - exec!.mono_us).toBeGreaterThan(300_000);
  });

  it('attributes a shell command to the turn it happened during', async () => {
    // The turn used to be whichever one was current when the frames file was drained — always the
    // last — so every shell command in a run claimed to belong to the final turn, and `causes`
    // could never link a tool call to the command it produced.
    //
    // This agent shells out *between* two model calls, so there is a right answer and a wrong one:
    // turn 1, not turn 2.
    const agent = join(workspace, 'interleaving-agent.mjs');
    await writeFile(
      agent,
      [
        "import { execFileSync } from 'node:child_process';",
        'const base = process.env.OPENAI_BASE_URL ?? process.env.ANTHROPIC_BASE_URL;',
        'const call = async () => {',
        '  const res = await fetch(`${base}/chat/completions`, {',
        "    method: 'POST',",
        "    headers: { 'content-type': 'application/json' },",
        "    body: JSON.stringify({ model: 'gpt-5.2', messages: [{ role: 'user', content: 'hi' }] }),",
        '  });',
        '  await res.text();',
        '};',
        'await call();',
        "execFileSync('sh', ['-c', 'exit 0'], { stdio: 'pipe' });",
        'await call();',
      ].join('\n'),
    );

    const result = await recordCommand(
      parseArgs(['record', 'generic-openai', '--upstream-openai', model.url, '--', 'node', agent]),
      out,
      workspace,
    );

    const events = await (await TraceReader.open(result.runDir)).events();
    const turns = events.filter((e) => e.type === 'model.request').map((e) => e.turn);
    const exec = events.find((e) => e.type === 'shell.exec');
    expect(exec, 'no shell.exec event was recorded').toBeDefined();
    expect(turns, 'the fixture must make two model calls for this to mean anything').toEqual([
      1, 2,
    ]);
    expect(exec!.turn).toBe(1);
  });

  it('records the exit code the model never sees', async () => {
    const result = await record();
    const events = await (await TraceReader.open(result.runDir)).events();
    const shellResult = events.find((e) => e.type === 'shell.result');
    expect(shellResult, 'no shell.result event was recorded').toBeDefined();
    expect(shellResult!.attrs?.exit_code).toBe(4);
  });

  it('records the stdout and stderr split', async () => {
    const result = await record();
    const events = await (await TraceReader.open(result.runDir)).events();
    const shellResult = events.find((e) => e.type === 'shell.result')!;
    expect(shellResult.attrs?.stdout_bytes).toBe(5);
    expect(shellResult.attrs?.stderr_bytes).toBe(4);
  });

  it('records the command and links the result back to it', async () => {
    const result = await record();
    const events = await (await TraceReader.open(result.runDir)).events();
    const exec = events.find((e) => e.type === 'shell.exec')!;
    const shellResult = events.find((e) => e.type === 'shell.result')!;
    expect(exec.attrs?.argv).toEqual(['sh', '-c', 'printf hello; printf boom 1>&2; exit 4']);
    expect(shellResult.causes).toContain(exec.seq);
  });

  it('keeps every event valid against the normative schema', async () => {
    const result = await record();
    for (const event of await (await TraceReader.open(result.runDir)).events()) {
      const r = validateEvent(event);
      expect(r.valid, `seq ${event.seq}: ${r.errors.join(', ')}`).toBe(true);
    }
  });

  it('does not change what the agent itself observes', async () => {
    // The shim is in the agent's PATH during this run; the agent still completes normally.
    const result = await record();
    expect(result.exitCode).toBe(0);
  });

  it('can be turned off, and then records no shell events', async () => {
    const result = await record(['--no-shell']);
    const events = await (await TraceReader.open(result.runDir)).events();
    expect(events.some((e) => e.type === 'shell.exec')).toBe(false);
    expect(lines.join('')).toContain('shell=off');
  });
});
