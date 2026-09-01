import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecordContext } from '@orcareplay/plugin-api';
import { checkAdapterContract, formatContractResult } from '../src/contract.js';
import { defaultAdapters } from '../src/registry.js';
import { execAdapter } from '../src/exec.js';

/**
 * The adapter for an agent orca knows nothing about.
 *
 * Every other adapter here names a harness and the variable that harness reads. This one names
 * neither, because the case it exists for is an agent whose model loop orca cannot see into at
 * all: a Python bot with a hardcoded xAI origin, a Go binary, an editor that spawns its own agent
 * as a child. Capture for those happens at the transport — `--tls-intercept` — and the adapter's
 * whole job is to launch the command and get out of the way.
 *
 * The interesting assertions here are therefore about what it does *not* set. `generic-openai`
 * already covers "run my command and redirect the usual variables"; if this adapter also injected
 * an origin it would be that adapter with a different name, and it would be pointing agents at a
 * provider they never asked for.
 */
describe('the exec adapter', () => {
  let root: string;
  let ctx: RecordContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-exec-'));
    ctx = {
      runId: 'run_test',
      cwd: join(root, 'work'),
      runDir: join(root, 'run'),
      proxyUrl: 'http://127.0.0.1:44100',
      userArgs: ['python', 'bot.py'],
      env: {},
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes the adapter contract', async () => {
    const result = await checkAdapterContract(execAdapter, {
      ctx: { userArgs: ['python', 'bot.py'] },
    });
    expect(result.ok, formatContractResult(result)).toBe(true);
  });

  it('answers to the names people type', () => {
    const registry = defaultAdapters();
    expect(registry.get('exec').id).toBe('exec');
    expect(registry.get('any').id).toBe('exec');
  });

  it('never claims a workspace, because it cannot know what it would launch', async () => {
    expect(await execAdapter.detect(ctx.cwd)).toBe(false);
  });

  it('launches the command from argv and forwards the rest', async () => {
    const launch = await execAdapter.prepare({
      ...ctx,
      userArgs: ['python', 'bot.py', '--task', 'fix it'],
    });
    expect(launch.command).toBe('python');
    expect(launch.args).toEqual(['bot.py', '--task', 'fix it']);
  });

  /**
   * The whole point of the adapter. An injected origin is not free: a harness that reads
   * `OPENAI_BASE_URL` and would otherwise have called xAI gets silently repointed, and the run
   * records traffic for a provider the user never chose.
   */
  it('injects no base-url variable of its own', async () => {
    const launch = await execAdapter.prepare(ctx);
    for (const name of ['OPENAI_BASE_URL', 'OPENAI_API_BASE', 'ANTHROPIC_BASE_URL']) {
      expect(launch.env[name], `${name} must not be invented`).toBeUndefined();
    }
    expect(Object.keys(launch.env).filter((n) => /_BASE_URL$|_API_BASE$/.test(n))).toEqual([]);
  });

  it('invents no credential', async () => {
    const launch = await execAdapter.prepare(ctx);
    expect(Object.keys(launch.env).filter((n) => /KEY$|TOKEN$|SECRET$/.test(n))).toEqual([]);
  });

  /**
   * The one redirect it will do, because the operator asked for it by name. This is what makes
   * `exec` useful without `--tls-intercept` for a harness that reads an unusual variable.
   */
  it('redirects a variable the operator names', async () => {
    const launch = await execAdapter.prepare({
      ...ctx,
      env: { ORCA_BASE_URL_VARS: 'GROK_BASE_URL' },
    });
    expect(launch.env.GROK_BASE_URL).toBe('http://127.0.0.1:44100/v1');
  });

  it('says what to type when the command is missing', async () => {
    await expect(execAdapter.prepare({ ...ctx, userArgs: [] })).rejects.toThrow(
      /orca record exec .*-- <command>/,
    );
  });

  /**
   * Declared rather than inferred. The contract's `redirects-model-traffic` check exists to catch
   * an adapter that points the harness nowhere — which is precisely, and deliberately, what this
   * adapter does. Marking it as transport-captured is how it opts out honestly, instead of setting
   * an inert `ORCA_PROXY_URL` to look like it installed a hook it never installed.
   */
  it('declares that it captures at the transport, not through the environment', () => {
    expect(execAdapter.capture).toBe('transport');
  });
});
