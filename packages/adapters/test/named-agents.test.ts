import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecordContext } from '@orcareplay/plugin-api';
import { HOOK_FILENAME } from '@orcareplay/node-instrument';
import { checkAdapterContract, formatContractResult } from '../src/contract.js';
import { defaultAdapters } from '../src/registry.js';
import { grokAdapter } from '../src/grok.js';
import { openClawAdapter } from '../src/openclaw.js';

/**
 * Adapters for the agents people keep asking about.
 *
 * Each one is written from that project's own documentation rather than from a guess, because an
 * adapter that sets a variable the harness does not read produces the exact failure this codebase
 * fears most: a run that looks fine and a trace that is empty.
 */
describe('the grok adapter', () => {
  let root: string;
  let ctx: RecordContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-grok-'));
    ctx = {
      runId: 'run_test',
      cwd: join(root, 'work'),
      runDir: join(root, 'run'),
      proxyUrl: 'http://127.0.0.1:44100',
      userArgs: [],
      env: {},
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes the adapter contract', async () => {
    const result = await checkAdapterContract(grokAdapter, { ctx: { userArgs: [] } });
    expect(result.ok, formatContractResult(result)).toBe(true);
  });

  it('answers to the names people type', () => {
    const registry = defaultAdapters();
    expect(registry.get('grok').id).toBe('grok');
    expect(registry.get('grok-cli').id).toBe('grok');
  });

  it('redirects GROK_BASE_URL, which is the variable grok-cli documents', async () => {
    // `GROK_BASE_URL` (default https://api.x.ai/v1) — from grok-cli's own README. The `/v1` is
    // part of the default, so the replacement carries it too or every path is off by a segment.
    const launch = await grokAdapter.prepare(ctx);
    expect(launch.env.GROK_BASE_URL).toBe('http://127.0.0.1:44100/v1');
  });

  it('launches grok and forwards the user args', async () => {
    const launch = await grokAdapter.prepare({ ...ctx, userArgs: ['--prompt', 'fix it'] });
    expect(launch.command).toBe('grok');
    expect(launch.args).toEqual(['--prompt', 'fix it']);
  });

  it('passes the key through without inventing one', async () => {
    expect((await grokAdapter.prepare(ctx)).env.GROK_API_KEY).toBeUndefined();
    const carried = await grokAdapter.prepare({ ...ctx, env: { GROK_API_KEY: 'xai-real' } });
    expect(carried.env.GROK_API_KEY).toBe('xai-real');
  });

  it('installs the fetch hook with xAI on the allowlist', async () => {
    // grok-cli runs on Bun and turns sub-agents on by default; a sub-agent that builds its own
    // client would slip past a variable the parent read. `api.x.ai` is not in the hook's default
    // host list, so the adapter has to add it or the hook would be inert here.
    const launch = await grokAdapter.prepare(ctx);
    expect(launch.env.ORCA_INSTRUMENT_HOSTS).toContain('api.x.ai');
    expect(launch.env.NODE_OPTIONS).toContain(HOOK_FILENAME);
    // Bun ignores `--require` inside NODE_OPTIONS, and grok-cli is a Bun program.
    expect(launch.env.BUN_OPTIONS).toContain('--preload');
  });
});

describe('the openclaw adapter', () => {
  let root: string;
  let ctx: RecordContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-openclaw-'));
    ctx = {
      runId: 'run_test',
      cwd: join(root, 'work'),
      runDir: join(root, 'run'),
      proxyUrl: 'http://127.0.0.1:44100',
      userArgs: [],
      env: {},
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes the adapter contract', async () => {
    const result = await checkAdapterContract(openClawAdapter, { ctx: { userArgs: [] } });
    expect(result.ok, formatContractResult(result)).toBe(true);
  });

  it('is registered', () => {
    expect(defaultAdapters().get('openclaw').id).toBe('openclaw');
  });

  it('installs the fetch hook, because it reads no base-URL variable of its own', async () => {
    const launch = await openClawAdapter.prepare(ctx);
    expect(launch.env.NODE_OPTIONS).toContain(HOOK_FILENAME);
  });

  it('still sets the base-URL variables the agents it launches will read', async () => {
    // This is the point of the adapter: OpenClaw is a gateway that spawns Claude Code, Codex or
    // opencode as child processes, and a child inherits its parent's environment. Redirecting
    // here reaches the coding agent even though OpenClaw itself never reads these.
    const launch = await openClawAdapter.prepare(ctx);
    expect(launch.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:44100');
    expect(launch.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:44100/v1');
  });
});

describe('ORCA_BASE_URL_VARS — naming a base-URL variable orca does not know', () => {
  let root: string;
  let ctx: RecordContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-named-'));
    ctx = {
      runId: 'run_test',
      cwd: join(root, 'work'),
      runDir: join(root, 'run'),
      proxyUrl: 'http://127.0.0.1:44100',
      userArgs: ['my-agent'],
      env: {},
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const generic = () => defaultAdapters().get('generic-openai');

  it('points a named variable at the proxy', async () => {
    // Hermes is the case this exists for: it overrides per provider with `<NAME>_BASE_URL`, a
    // family too large and too fast-moving to enumerate here — NOVITA, GLM, KIMI, MINIMAX, HF,
    // NEBIUS and a dozen more in its own .env.example.
    const launch = await generic().prepare({
      ...ctx,
      env: { ORCA_BASE_URL_VARS: 'OPENROUTER_BASE_URL' },
    });
    expect(launch.env.OPENROUTER_BASE_URL).toBe('http://127.0.0.1:44100/v1');
  });

  it('takes several, comma separated', async () => {
    const launch = await generic().prepare({
      ...ctx,
      env: { ORCA_BASE_URL_VARS: 'GLM_BASE_URL, KIMI_BASE_URL' },
    });
    expect(launch.env.GLM_BASE_URL).toBe('http://127.0.0.1:44100/v1');
    expect(launch.env.KIMI_BASE_URL).toBe('http://127.0.0.1:44100/v1');
  });

  it('lets a path be given, for an origin that is not OpenAI-shaped', async () => {
    const launch = await generic().prepare({
      ...ctx,
      env: { ORCA_BASE_URL_VARS: 'TOKENPLAN_BASE_URL=/' },
    });
    expect(launch.env.TOKENPLAN_BASE_URL).toBe('http://127.0.0.1:44100');
  });

  it('is consumed, not forwarded — the child has no use for it', async () => {
    const launch = await generic().prepare({
      ...ctx,
      env: { ORCA_BASE_URL_VARS: 'OPENROUTER_BASE_URL' },
    });
    expect(launch.env.ORCA_BASE_URL_VARS).toBeUndefined();
  });

  it('ignores blanks and empty entries rather than setting a variable named ""', async () => {
    const launch = await generic().prepare({ ...ctx, env: { ORCA_BASE_URL_VARS: ' , ,' } });
    expect(Object.keys(launch.env)).not.toContain('');
  });

  it('works on the node adapter too, where a hooked agent may still read a variable', async () => {
    const launch = await defaultAdapters()
      .get('node')
      .prepare({ ...ctx, env: { ORCA_BASE_URL_VARS: 'LLM_BASE_URL' } });
    expect(launch.env.LLM_BASE_URL).toBe('http://127.0.0.1:44100/v1');
  });
});
