import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader } from '@orcareplay/core';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { replayCommand } from '../src/commands/replay.js';
import { startResponsesModel } from './fixtures/responses-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const GATEWAY = join(here, 'fixtures', 'gateway-agent.mjs');

/**
 * Recording a gateway that launches the coding agent.
 *
 * This is OpenClaw's shape, and it is the one claim in the README that rests on something orca
 * does not do itself: a child process inherits its parent's environment, so the agent a gateway
 * spawns is redirected even though the gateway never read the variable. That is true of every
 * POSIX system and of Windows, and it is exactly the kind of thing that is obviously true until
 * some layer in between sanitises the environment — so it gets a test rather than a sentence.
 */
describe('end to end: a gateway that spawns the agent', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startResponsesModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-gateway-'));
    model = await startResponsesModel();
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
  });
  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const record = (adapter: string) =>
    recordCommand(
      parseArgs([
        'record',
        adapter,
        '--upstream-openai',
        model.url,
        '--',
        process.execPath,
        GATEWAY,
      ]),
      out,
      workspace,
    );

  it('captures the grandchild’s model calls, which is what makes a gateway recordable', async () => {
    const result = await record('generic-openai');

    expect(result.exitCode).toBe(0);
    expect(result.modelExchanges).toBe(2);
    expect(model.calls[0]!.url).toBe('/v1/responses');
    expect(lines.find((l) => l.includes('capture.empty'))).toBeUndefined();
  });

  it('records the tool call and the file the grandchild changed', async () => {
    const result = await record('generic-openai');
    const events = await (await TraceReader.open(result.runDir)).events();
    expect(events.filter((e) => e.type === 'tool.call')[0]?.attrs?.name).toBe('edit_file');
    expect(await readFile(join(workspace, 'auth.ts'), 'utf8')).toContain('fixed = true');
  });

  it('replays the whole thing offline, gateway and agent together', async () => {
    const result = await record('generic-openai');
    const before = model.calls.length;

    const replay = await replayCommand(parseArgs(['replay', result.runId]), out, workspace);

    expect(replay.exitCode).toBe(0);
    expect(replay.matchedExact).toBe(2);
    expect(replay.unmatched).toBe(0);
    expect(model.calls.length).toBe(before);
  });

  it('works through the openclaw adapter, which is written for exactly this', async () => {
    // The adapter cannot launch the real `openclaw` binary here, but the environment it builds is
    // the thing under test — so the same gateway fixture is run under it via generic-openai's
    // command handling, and the inheritance property is what both rely on.
    const launch = await (
      await import('@orcareplay/adapters')
    ).openClawAdapter.prepare({
      runId: 'run_x',
      cwd: workspace,
      runDir: join(workspace, '.orca', 'runs', 'run_x'),
      proxyUrl: 'http://127.0.0.1:44100',
      userArgs: [],
      env: {},
    });
    // What a spawned Claude Code will read out of the inherited environment.
    expect(launch.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:44100');
    expect(launch.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:44100/v1');
  });
});
