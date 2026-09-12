import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const DEAF_AGENT = join(here, 'fixtures', 'deaf-agent.mjs');
const FAKE_AGENT = join(here, 'fixtures', 'fake-agent.mjs');

/**
 * A recording that captured nothing must say so.
 *
 * This is the quietest way orca can fail and the most damaging. The agent runs, exits 0, and the
 * trace holds no model exchange — so every signal the operator has says the run worked, and they
 * find out otherwise minutes later when `orca replay` has nothing to replay. `contract.ts` already
 * names this shape as the thing the adapter checks exist to prevent; nothing was watching for it
 * at the end of a real run.
 */
describe('orca record — a run that captured no model traffic', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-capture-'));
    model = await startFakeModel();
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

  function record(agent: string) {
    const args = parseArgs([
      'record',
      'generic-openai',
      '--upstream-anthropic',
      model.url,
      '--',
      'node',
      agent,
    ]);
    process.env.FAKE_AGENT_TURNS = '2';
    delete process.env.FAKE_AGENT_CWD;
    return recordCommand(args, out, workspace);
  }

  it('warns rather than exiting clean', async () => {
    const result = await record(DEAF_AGENT);

    // The agent itself succeeded, which is exactly what makes this dangerous.
    expect(result.exitCode).toBe(0);
    const warning = lines.find((l) => l.includes('capture.empty'));
    expect(warning).toBeDefined();
    expect(warning).toContain('warn');
  });

  it('names the likely cause instead of only the symptom', async () => {
    await record(DEAF_AGENT);
    const warning = lines.find((l) => l.includes('capture.empty')) ?? '';
    // "0 exchanges" alone sends someone hunting through their agent. The cause is nearly always
    // the same one, and orca knows which variables it set.
    expect(warning).toMatch(/base.?url/i);
  });

  it('does not blame a base-URL variable when the adapter never set one', async () => {
    // `exec` captures at the transport, so there was never a variable to be ignored -- and the
    // same line says `set=none`. Blaming one contradicts the run's own output, and points the
    // reader at a route that was never the route.
    const args = parseArgs(['record', 'exec', '--', 'node', DEAF_AGENT]);
    process.env.FAKE_AGENT_TURNS = '2';
    delete process.env.FAKE_AGENT_CWD;
    await recordCommand(args, out, workspace);

    const warning = lines.find((l) => l.includes('capture.empty')) ?? '';
    expect(warning).toContain('set=none');
    expect(warning).not.toMatch(/base.?url/i);
    // And it names what this adapter actually depends on instead.
    expect(warning).toMatch(/transport/i);
  });

  it('points at orca doctor, which is where the answer is', async () => {
    await record(DEAF_AGENT);
    const warning = lines.find((l) => l.includes('capture.empty')) ?? '';
    expect(warning).toContain('orca doctor');
  });

  it('says nothing when the run did capture model traffic', async () => {
    await record(FAKE_AGENT);
    expect(lines.find((l) => l.includes('capture.empty'))).toBeUndefined();
  });
});

/**
 * A recording in which every model call came back an error.
 *
 * The other half of the same silence. `capture.empty` covers the run the proxy never saw; this
 * covers the run it saw all of, where every answer was a refusal — an expired gateway credential,
 * a model the account cannot reach. The harness retries, exhausts its attempts, prints its own
 * error and exits 0, so the summary reads exactly like a successful recording over a trace with no
 * model output in it. Found against a real gateway whose upstream auth had lapsed: eight recorded
 * exchanges, all 503, and `recorded events=27 exit=0` printed without a word about it.
 */
describe('orca record — a run whose every model call failed', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;
  let lines: string[];

  async function setup(failWith?: number) {
    workspace = await mkdtemp(join(tmpdir(), 'orca-errors-'));
    model = await startFakeModel(failWith === undefined ? {} : { failWith });
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
    const args = parseArgs([
      'record',
      'generic-openai',
      '--upstream-anthropic',
      model.url,
      '--',
      'node',
      FAKE_AGENT,
    ]);
    process.env.FAKE_AGENT_TURNS = '2';
    delete process.env.FAKE_AGENT_CWD;
    return recordCommand(args, out, workspace);
  }

  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  it('warns, rather than reporting a clean recording over nothing usable', async () => {
    const result = await setup(503);
    // The exchanges are all there. That is the point: nothing about the count says they failed.
    expect(result.modelExchanges).toBeGreaterThan(0);
    const warning = lines.find((l) => l.includes('capture.errors'));
    expect(warning, `no capture.errors in:\n${lines.join('\n')}`).toBeDefined();
  });

  it('names the status, so the cause is a lookup rather than an investigation', async () => {
    await setup(503);
    expect(lines.find((l) => l.includes('capture.errors')) ?? '').toContain('status=503');
  });

  it('says what the trace now holds, since a replay will reproduce it faithfully', async () => {
    await setup(401);
    const warning = lines.find((l) => l.includes('capture.errors')) ?? '';
    expect(warning).toContain('status=401');
    expect(warning).toMatch(/replay/i);
  });

  // A run that retried once and then worked is a run that worked. Warning about it would train
  // people to ignore the line that matters.
  it('says nothing when the calls succeeded', async () => {
    await setup();
    expect(lines.find((l) => l.includes('capture.errors'))).toBeUndefined();
  });
});
