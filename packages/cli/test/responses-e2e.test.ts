import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader, deriveCheckpoints } from '@orcareplay/core';
import { validateEvent, validateManifest } from '@orcareplay/schema';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { replayCommand } from '../src/commands/replay.js';
import { startResponsesModel } from './fixtures/responses-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const AGENT = join(here, 'fixtures', 'responses-agent.mjs');

/**
 * The acceptance test for the Responses API, against a real child process, a real proxy and a
 * real trace on disk — the same bar the Anthropic path is held to.
 *
 * It matters that the agent here is a *child process talking to a base URL*, not a unit calling a
 * translator: the reason this dialect was missing for so long is that every layer looked fine on
 * its own, and the failure only appeared where they met.
 */
describe('end to end: a Responses API agent', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startResponsesModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-responses-'));
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

  function record() {
    const args = parseArgs([
      'record',
      'generic-openai',
      '--upstream-openai',
      model.url,
      '--',
      'node',
      AGENT,
    ]);
    return recordCommand(args, out, workspace);
  }

  it('records the run rather than killing the agent', async () => {
    const result = await record();

    // Exit 3 is the agent reporting a non-200 from the proxy — which is what a 404 produced.
    expect(result.exitCode).toBe(0);
    expect(model.calls.length).toBeGreaterThan(0);
    expect(model.calls[0]!.url).toBe('/v1/responses');
  });

  it('writes a trace that validates against the normative schema', async () => {
    const result = await record();
    const reader = await TraceReader.open(result.runDir);
    expect(validateManifest(reader.manifest()).valid).toBe(true);
    for (const event of await reader.events()) {
      expect(validateEvent(event).valid, JSON.stringify(event).slice(0, 200)).toBe(true);
    }
  });

  it('captures the tool call the model asked for and the file it changed', async () => {
    const result = await record();
    const events = await (await TraceReader.open(result.runDir)).events();

    const toolCalls = events.filter((e) => e.type === 'tool.call');
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolCalls[0]!.attrs?.name).toBe('edit_file');

    // The proxy sees the loop, so the edit is in the trace — and it really happened on disk.
    expect(await readFile(join(workspace, 'auth.ts'), 'utf8')).toContain('fixed = true');
    expect(events.some((e) => e.type === 'fs.change')).toBe(true);
  });

  it('does not warn about an empty capture, because the capture is not empty', async () => {
    await record();
    expect(lines.find((l) => l.includes('capture.empty'))).toBeUndefined();
  });

  it('replays offline, byte for byte, with nothing unmatched', async () => {
    const result = await record();
    const before = model.calls.length;

    const replay = await replayCommand(parseArgs(['replay', result.runId]), out, workspace);

    expect(replay.exitCode).toBe(0);
    expect(replay.mode).toBe('exact');
    expect(replay.matchedExact).toBeGreaterThan(0);
    // Nothing went live, and the whole claim behind it: the model was not asked again.
    expect(replay.liveCalls).toBe(0);
    expect(model.calls.length).toBe(before);
  });

  it('derives checkpoints, so the run can be forked', async () => {
    const result = await record();
    const reader = await TraceReader.open(result.runDir);
    const checkpoints = deriveCheckpoints(await reader.events());
    expect(checkpoints.length).toBeGreaterThan(0);
  });
});
