import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader } from '@orcareplay/core';
import { validateEvent } from '@orcareplay/schema';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { replayCommand } from '../src/commands/replay.js';
import { startResponsesModel } from './fixtures/responses-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const AGENT = join(here, 'fixtures', 'vercel-agent.mjs');

/**
 * An agent that reads no base-URL variable, recorded anyway.
 *
 * This is the last of the five named integrations, and the only one that could not be reached by
 * setting an environment variable — `@ai-sdk/openai` takes its origin as a constructor argument.
 * The pair of tests below is the whole point: the same agent, the same fixture, one adapter that
 * captures it and one that cannot.
 */
describe('end to end: an agent with a hardcoded provider origin', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startResponsesModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-vercel-'));
    model = await startResponsesModel();
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
    process.env.VERCEL_AGENT_TIMEOUT_MS = '1500';
  });

  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
    delete process.env.VERCEL_AGENT_TIMEOUT_MS;
  });

  const record = (adapter: string) =>
    recordCommand(
      parseArgs(['record', adapter, '--upstream-openai', model.url, '--', process.execPath, AGENT]),
      out,
      workspace,
    );

  it('captures nothing under an adapter that only sets environment variables', async () => {
    // The control. Not a strawman: this is what `orca record` did for every AI SDK agent.
    await record('generic-openai');

    expect(model.calls).toHaveLength(0);
    const warning = lines.find((l) => l.includes('capture.empty'));
    expect(warning).toBeDefined();
  });

  it('captures the run under the node adapter', async () => {
    const result = await record('node');

    expect(model.calls.length).toBeGreaterThan(0);
    expect(model.calls[0]!.url).toBe('/v1/responses');
    expect(lines.find((l) => l.includes('capture.empty'))).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it('captures the turn the agent made through a Request object, not just the string one', async () => {
    // Two turns: the first passes a URL string, the second a Request. A hook that rewrites only
    // strings captures exactly half a run and looks like it worked.
    await record('node');
    expect(model.calls.length).toBe(2);
  });

  it('writes a schema-valid trace with the tool call and the file it changed', async () => {
    const result = await record('node');
    const events = await (await TraceReader.open(result.runDir)).events();
    for (const event of events) {
      expect(validateEvent(event).valid, JSON.stringify(event).slice(0, 160)).toBe(true);
    }
    expect(events.filter((e) => e.type === 'tool.call')[0]?.attrs?.name).toBe('edit_file');
    expect(await readFile(join(workspace, 'auth.ts'), 'utf8')).toContain('fixed = true');
  });

  it('replays offline, which is the whole reason to have captured it', async () => {
    const result = await record('node');
    const before = model.calls.length;

    const replay = await replayCommand(parseArgs(['replay', result.runId]), out, workspace);

    expect(replay.exitCode).toBe(0);
    expect(replay.matchedExact).toBe(2);
    expect(replay.liveCalls).toBe(0);
    expect(model.calls.length).toBe(before);
  });
});
