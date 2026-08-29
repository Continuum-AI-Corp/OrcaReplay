import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader, resolveRunSelector } from '@orcareplay/core';
import { validateEvent } from '@orcareplay/schema';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { replayCommand } from '../src/commands/replay.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);
const FAKE_AGENT = join(import.meta.dirname, 'fixtures', 'fake-agent.mjs');

/**
 * `route.decision` — spec §2, "a gateway chose a model".
 *
 * It was declared in the schema, rendered by the viewer, and emitted by nothing, which the
 * conformance job reported run after run. On a fork orca *is* the gateway: it substitutes the
 * model, picks the wire format that serves it and picks the origin, and it was making all three
 * choices silently. A verdict table reading `claude-opus-5 vs gpt-5.2` says nothing about where
 * either one went.
 */
describe('route.decision', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-route-'));
    model = await startFakeModel();
    lines = [];
    out = new Output({ write: (l) => void lines.push(l), isTTY: false });
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
  });

  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const record = () =>
    recordCommand(
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

  const fork = (forkModel: string) =>
    replayCommand(
      parseArgs([
        'replay',
        'last',
        '--from',
        '1',
        '--model',
        forkModel,
        '--upstream-anthropic',
        model.url,
        '--upstream-openai',
        model.url,
      ]),
      out,
      workspace,
    );

  async function routesOf(runId: string) {
    const dir = (await resolveRunSelector(workspace, runId)).dir;
    const events = await (await TraceReader.open(dir)).events();
    return events.filter((e) => e.type === 'route.decision');
  }

  it('records where a cross-provider fork actually sent the request', async () => {
    await record();
    const result = await fork('gpt-5.2');

    const routes = await routesOf(result.forkRunId!);
    expect(routes.length, `no route.decision in:\n${lines.join('\n')}`).toBeGreaterThan(0);
    for (const event of routes) expect(validateEvent(event).valid).toBe(true);

    const attrs = routes[0]!.attrs!;
    expect(attrs.model).toBe('gpt-5.2');
    expect(attrs.target).toBe('openai');
    // The half that makes it legible: without the recorded dialect, "target: openai" cannot be
    // told apart from a run that was OpenAI all along.
    expect(attrs.recorded).toBe('anthropic');
    expect(attrs.crossProvider).toBe(true);
    expect(String(attrs.origin)).toContain('127.0.0.1');
    expect(routes[0]!.actor).toBe('gateway');
  });

  it('records a same-dialect substitution too, and says it did not cross', async () => {
    await record();
    const result = await fork('claude-haiku-4-5');

    const attrs = (await routesOf(result.forkRunId!))[0]?.attrs;
    expect(attrs, 'a substitution is a routing decision even inside one dialect').toBeDefined();
    expect(attrs!.target).toBe('anthropic');
    expect(attrs!.crossProvider).toBe(false);
  });

  it('says nothing on a plain recording, which chooses nothing', async () => {
    // An event announcing that no decision was taken is noise, and it would put a `route.decision`
    // in every trace orca has ever written.
    const recorded = await record();
    const events = await (await TraceReader.open(recorded.runDir)).events();
    expect(events.some((e) => e.type === 'route.decision')).toBe(false);
  });

  it('says nothing on an exact replay, which substitutes nothing', async () => {
    await record();
    const result = await replayCommand(parseArgs(['replay', 'last']), out, workspace);
    expect((await routesOf(result.traceRunId!)).length).toBe(0);
  });
});
