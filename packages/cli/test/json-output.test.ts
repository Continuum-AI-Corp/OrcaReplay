import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orca } from '../src/api.js';
import { main } from '../src/main.js';
import { startResponsesModel } from './fixtures/responses-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const AGENT = join(here, 'fixtures', 'responses-agent.mjs');

/**
 * `--json`: one JSON document on stdout, diagnostics on stderr.
 *
 * Without it the only way to read a result is to scrape prose — `info replay.done reused=2/2
 * exact=2 divergences=0` — which is a format nobody promised to keep. One document rather than a
 * stream of log objects because a caller wants the answer, and `orca show last --json | jq` should
 * work without a `select(.type=="result")` in front of it.
 *
 * Diagnostics move to stderr so stdout stays parseable even when a run warns.
 */
describe('orca --json', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startResponsesModel>>;
  let stdout: string[];
  let stderr: string[];
  let realOut: typeof process.stdout.write;
  let realErr: typeof process.stderr.write;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-json-'));
    model = await startResponsesModel();
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');

    stdout = [];
    stderr = [];
    realOut = process.stdout.write;
    realErr = process.stderr.write;
    process.stdout.write = ((s: string) => (stdout.push(String(s)), true)) as never;
    process.stderr.write = ((s: string) => (stderr.push(String(s)), true)) as never;
  });

  afterEach(async () => {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const cli = (argv: string[]) => main(argv, workspace);
  const out = () => stdout.join('');
  const err = () => stderr.join('');

  async function seed(agent = AGENT) {
    const orca = new Orca({ cwd: workspace });
    return orca.record({
      adapter: 'generic-openai',
      command: [process.execPath, agent],
      upstream: { openai: model.url },
    });
  }

  it('prints exactly one JSON document for `show`, and nothing else', async () => {
    const recorded = await seed();
    await cli(['show', recorded.runId, '--json']);

    const doc = JSON.parse(out());
    expect(doc.runId).toBe(recorded.runId);
    expect(Array.isArray(doc.events)).toBe(true);
    expect(doc.events.some((e: { kind: string }) => e.kind === 'TOOL')).toBe(true);
  });

  it('prints an array for `list`, empty when there is nothing', async () => {
    await cli(['list', '--json']);
    expect(JSON.parse(out())).toEqual([]);

    stdout.length = 0;
    const recorded = await seed();
    await cli(['list', '--json']);
    const runs = JSON.parse(out());
    expect(runs.map((r: { runId: string }) => r.runId)).toContain(recorded.runId);
  });

  it('prints the checkpoints a fork can start from', async () => {
    const recorded = await seed();
    await cli(['checkpoints', recorded.runId, '--json']);
    const doc = JSON.parse(out());
    expect(Array.isArray(doc)).toBe(true);
    expect(doc[0]).toMatchObject({ seq: expect.any(Number), turn: expect.any(Number) });
  });

  it('prints the replay result, so nothing has to be scraped from a log line', async () => {
    const recorded = await seed();
    stdout.length = 0;
    stderr.length = 0;

    await cli(['replay', recorded.runId, '--json']);

    expect(JSON.parse(out())).toMatchObject({
      runId: recorded.runId,
      mode: 'exact',
      matchedExact: 2,
      divergences: 0,
      unmatched: 0,
      exitCode: 0,
    });
  });

  it('keeps stdout parseable when the run warns, by putting diagnostics on stderr', async () => {
    // The case that decides the design: a warning interleaved into stdout breaks every consumer.
    stdout.length = 0;
    stderr.length = 0;
    await cli([
      'record',
      'generic-openai',
      '--upstream-openai',
      model.url,
      '--json',
      '--',
      process.execPath,
      join(here, 'fixtures', 'deaf-agent.mjs'),
    ]);

    const doc = JSON.parse(out());
    expect(doc.modelExchanges).toBe(0);
    // The warning is still emitted — just not into the document.
    expect(err()).toContain('capture.empty');
  });

  it('reports a failure as JSON on stdout too, rather than prose', async () => {
    // An agent that only handles the happy path is an agent that hangs on the first bad run.
    const code = await cli(['show', 'run_doesnotexist', '--json']);
    expect(code).not.toBe(0);
    const doc = JSON.parse(out());
    expect(doc.error).toBeDefined();
    expect(JSON.stringify(doc)).toContain('run_doesnotexist');
  });

  it('leaves the human output alone when --json is absent', async () => {
    const recorded = await seed();
    stdout.length = 0;
    await cli(['show', recorded.runId]);
    expect(out()).toContain('SEQ');
    expect(() => JSON.parse(out())).toThrow();
  });

  it('emits the agent output on stderr during a recording, keeping stdout one document', async () => {
    stdout.length = 0;
    await cli([
      'record',
      'generic-openai',
      '--upstream-openai',
      model.url,
      '--json',
      '--',
      process.execPath,
      AGENT,
    ]);
    const doc = JSON.parse(out());
    expect(doc).toMatchObject({ runId: expect.any(String), exitCode: 0, modelExchanges: 2 });
  });

  /**
   * As a real subprocess, which is the only way to see this.
   *
   * The recorded agent is spawned with `stdio: 'inherit'`, so its stdout is orca's stdout — the
   * file descriptor, not the `process.stdout.write` an in-process test can replace. Every
   * assertion above passed while `orca record --json` was in fact emitting the agent's own chatter
   * ahead of the document, which is exactly what a caller piping into `jq` would choke on.
   */
  it('keeps stdout parseable when the recorded agent prints, as a real process', async () => {
    const cliPath = join(here, '..', 'dist', 'cli.js');
    const { stdout: piped, stderr: diagnostics } = await run(
      process.execPath,
      [
        cliPath,
        'record',
        'generic-openai',
        '--upstream-openai',
        model.url,
        '--json',
        '--',
        process.execPath,
        AGENT,
      ],
      { cwd: workspace, env: { ...process.env, NO_COLOR: '1' } },
    );

    // The agent really does print — that is the point of the test.
    expect(diagnostics).toContain('responses-agent: completed');
    // And stdout is still exactly one document.
    const doc = JSON.parse(piped);
    expect(doc).toMatchObject({ exitCode: 0, modelExchanges: 2 });
  });

  it('keeps replay stdout parseable too, since a replay launches the agent again', async () => {
    // Same hazard, second code path: an exact replay really re-runs the harness, so its output
    // reaches the same inherited descriptor.
    const cliPath = join(here, '..', 'dist', 'cli.js');
    const recorded = await seed();
    const { stdout: piped, stderr: diagnostics } = await run(
      process.execPath,
      [cliPath, 'replay', recorded.runId, '--json'],
      { cwd: workspace, env: { ...process.env, NO_COLOR: '1' } },
    );

    expect(diagnostics).toContain('responses-agent: completed');
    expect(JSON.parse(piped)).toMatchObject({
      runId: recorded.runId,
      matchedExact: 2,
      unmatched: 0,
    });
  });
});
