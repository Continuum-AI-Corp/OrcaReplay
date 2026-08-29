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
