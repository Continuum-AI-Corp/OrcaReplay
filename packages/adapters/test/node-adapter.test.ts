import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecordContext } from '@orcareplay/plugin-api';
import { HOOK_FILENAME } from '@orcareplay/node-instrument';
import { checkAdapterContract, formatContractResult } from '../src/contract.js';
import { defaultAdapters } from '../src/registry.js';
import { nodeAdapter } from '../src/node.js';

/**
 * The adapter for a JS agent that reads no base-URL variable.
 *
 * Every other adapter works by pointing an environment variable at the proxy. This one exists
 * because a whole class of agents ignores them — `@ai-sdk/openai` takes its origin as a
 * constructor argument and nothing else — so the redirect has to happen inside the runtime.
 */
describe('the node adapter', () => {
  let root: string;
  let ctx: RecordContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-node-adapter-'));
    ctx = {
      runId: 'run_test',
      cwd: join(root, 'work'),
      runDir: join(root, 'run'),
      proxyUrl: 'http://127.0.0.1:44100',
      userArgs: ['node', 'app.mjs'],
      env: {},
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes the adapter contract', async () => {
    const result = await checkAdapterContract(nodeAdapter);
    expect(result.ok, formatContractResult(result)).toBe(true);
  });

  it('is registered, and answers to the names people will actually type', () => {
    const registry = defaultAdapters();
    expect(registry.get('node').id).toBe('node');
    expect(registry.get('vercel-ai').id).toBe('node');
    expect(registry.get('ai-sdk').id).toBe('node');
  });

  it('launches the command the user gave it', async () => {
    const launch = await nodeAdapter.prepare(ctx);
    expect(launch.command).toBe('node');
    expect(launch.args).toEqual(['app.mjs']);
  });

  it('installs the fetch hook through NODE_OPTIONS', async () => {
    const launch = await nodeAdapter.prepare(ctx);
    expect(launch.env.NODE_OPTIONS).toContain('--require');
    expect(launch.env.NODE_OPTIONS).toContain(HOOK_FILENAME);
    // Written where the run can find it and clean it up, never into the user's project.
    expect(launch.env.NODE_OPTIONS).toContain(ctx.runDir);
  });

  it('writes the hook to disk, ready for the child to load', async () => {
    await nodeAdapter.prepare(ctx);
    const source = await readFile(join(ctx.runDir, HOOK_FILENAME), 'utf8');
    expect(source).toContain('globalThis.fetch');
  });

  it('tells the hook where the proxy is', async () => {
    const launch = await nodeAdapter.prepare(ctx);
    expect(launch.env.ORCA_PROXY_URL).toBe(ctx.proxyUrl);
  });

  it('still sets the base-URL variables, for an agent that does read them', async () => {
    // Belt and braces on purpose: one agent may use the SDK's default client for one provider and
    // a hardcoded origin for another, and orca has no way to know which.
    const launch = await nodeAdapter.prepare(ctx);
    expect(launch.env.OPENAI_BASE_URL).toContain('44100');
    expect(launch.env.ANTHROPIC_BASE_URL).toContain('44100');
  });

  it('keeps NODE_OPTIONS the user already set', async () => {
    const launch = await nodeAdapter.prepare({
      ...ctx,
      env: { NODE_OPTIONS: '--max-old-space-size=4096' },
    });
    expect(launch.env.NODE_OPTIONS).toContain('--max-old-space-size=4096');
    expect(launch.env.NODE_OPTIONS).toContain('--require');
  });

  it('is not chosen automatically, because it cannot know what it would be launching', async () => {
    expect(await nodeAdapter.detect(ctx.cwd)).toBe(false);
  });

  it('refuses without a command, rather than launching something arbitrary', async () => {
    await expect(nodeAdapter.prepare({ ...ctx, userArgs: [] })).rejects.toThrow(/command/i);
  });
});
