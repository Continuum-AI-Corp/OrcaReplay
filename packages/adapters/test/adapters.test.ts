import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, RecordContext } from '@orcareplay/plugin-api';
import {
  AdapterRegistry,
  claudeCodeAdapter,
  codexAdapter,
  defaultAdapters,
  genericOpenAiAdapter,
  hasBinary,
  openCodeAdapter,
} from '../src/index.js';

/** A PATH with `which` on it but none of the agent binaries, so detect() is deterministic. */
const BARE_PATH = '/usr/bin:/bin';

let scratch: string;
const saved = { ...process.env };

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-adapters-'));
});

afterEach(() => {
  // Restore in place: assigning `process.env` a fresh object detaches it from the real OS
  // environment, and os.homedir() then reads stale values for the rest of the file.
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  rmSync(scratch, { recursive: true, force: true });
});

function ctx(over: Partial<RecordContext> = {}): RecordContext {
  return {
    runId: 'run_abc123',
    cwd: '/work',
    proxyUrl: 'http://127.0.0.1:51733',
    runDir: '/work/.orca/runs/run_abc123',
    userArgs: [],
    env: {},
    ...over,
  };
}

let homeCount = 0;

/** Isolate HOME (no agent config dirs) and PATH (no agent binaries). Each call gets a fresh home. */
function isolate(homeContents: string[] = []): string {
  const home = join(scratch, `home-${(homeCount += 1)}`);
  mkdirSync(home, { recursive: true });
  for (const rel of homeContents) mkdirSync(join(home, rel), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = BARE_PATH;
  return home;
}

describe('hasBinary', () => {
  it('finds a binary that is on PATH', async () => {
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'orca-fake-agent'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${bin}:${BARE_PATH}`;
    expect(await hasBinary('orca-fake-agent')).toBe(true);
  });

  it('is false for a binary that is not on PATH', async () => {
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'orca-fake-agent'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = BARE_PATH;
    expect(await hasBinary('orca-fake-agent')).toBe(false);
  });

  it('never throws, even on a name full of shell metacharacters', async () => {
    await expect(hasBinary('nope; rm -rf / #`whoami`')).resolves.toBe(false);
  });

  it('is false rather than throwing when PATH cannot even resolve which/where', async () => {
    process.env.PATH = join(scratch, 'empty-dir-that-does-not-exist');
    await expect(hasBinary('claude')).resolves.toBe(false);
  });
});

describe('claudeCodeAdapter', () => {
  it('is identified and declares the harness range it was tested against', () => {
    expect(claudeCodeAdapter.id).toBe('claude-code');
    expect(claudeCodeAdapter.harnessVersions).toBe('>=1.0.0');
  });

  it('detects a workspace by ~/.claude even when the binary is absent', async () => {
    isolate(['.claude']);
    expect(await claudeCodeAdapter.detect('/work')).toBe(true);
  });

  it('detects the binary on PATH even when ~/.claude is absent', async () => {
    const home = isolate();
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${bin}:${BARE_PATH}`;
    expect(home).toBeTruthy();
    expect(await claudeCodeAdapter.detect('/work')).toBe(true);
  });

  it('does not detect when neither the binary nor ~/.claude is present', async () => {
    isolate();
    expect(await claudeCodeAdapter.detect('/work')).toBe(false);
  });

  it('follows the HOME visible in process.env, which is the one the child will get', async () => {
    const home = isolate(['.claude']);
    const real = process.env;
    // A host that builds a sandboxed env object detaches process.env from the OS environment;
    // os.homedir() then reads the stale OS value and detection disagrees with the launch.
    process.env = { ...real, HOME: home, USERPROFILE: home, PATH: BARE_PATH };
    try {
      expect(await claudeCodeAdapter.detect('/work')).toBe(true);
      process.env.HOME = join(scratch, 'nowhere');
      process.env.USERPROFILE = process.env.HOME;
      expect(await claudeCodeAdapter.detect('/work')).toBe(false);
    } finally {
      process.env = real;
    }
  });

  it('points the agent at the proxy with no path suffix', async () => {
    const launch = await claudeCodeAdapter.prepare(ctx());
    expect(launch.command).toBe('claude');
    expect(launch.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:51733');
  });

  it('strips a trailing slash from the proxy url', async () => {
    const launch = await claudeCodeAdapter.prepare(ctx({ proxyUrl: 'http://127.0.0.1:51733/' }));
    expect(launch.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:51733');
  });

  it('passes the user argv through', async () => {
    const userArgs = ['-p', 'hello world'];
    const launch = await claudeCodeAdapter.prepare(ctx({ userArgs }));
    expect(launch.args).toEqual(['-p', 'hello world']);
    launch.args.push('mutated');
    expect(userArgs).toEqual(['-p', 'hello world']);
  });

  it('passes an existing API key through', async () => {
    const launch = await claudeCodeAdapter.prepare(ctx({ env: { ANTHROPIC_API_KEY: 'sk-real' } }));
    expect(launch.env.ANTHROPIC_API_KEY).toBe('sk-real');
  });

  it('substitutes a placeholder key when none is set', async () => {
    const launch = await claudeCodeAdapter.prepare(ctx());
    expect(launch.env.ANTHROPIC_API_KEY).toBe('orca-recorded');
  });

  it('treats an empty key as unset', async () => {
    const launch = await claudeCodeAdapter.prepare(ctx({ env: { ANTHROPIC_API_KEY: '' } }));
    expect(launch.env.ANTHROPIC_API_KEY).toBe('orca-recorded');
  });

  it('passes ANTHROPIC_AUTH_TOKEN through only when it is set', async () => {
    const withToken = await claudeCodeAdapter.prepare(
      ctx({ env: { ANTHROPIC_AUTH_TOKEN: 'tok-1' } }),
    );
    expect(withToken.env.ANTHROPIC_AUTH_TOKEN).toBe('tok-1');
    const without = await claudeCodeAdapter.prepare(ctx());
    expect('ANTHROPIC_AUTH_TOKEN' in without.env).toBe(false);
  });
});

describe('codexAdapter', () => {
  it('is identified', () => {
    expect(codexAdapter.id).toBe('codex');
  });

  it('points the OpenAI SDK at the proxy under /v1', async () => {
    const launch = await codexAdapter.prepare(ctx());
    expect(launch.command).toBe('codex');
    expect(launch.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:51733/v1');
  });

  it('does not double the slash when the proxy url already ends in one', async () => {
    const launch = await codexAdapter.prepare(ctx({ proxyUrl: 'http://127.0.0.1:51733/' }));
    expect(launch.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:51733/v1');
  });

  it('passes OPENAI_API_KEY through, or substitutes a placeholder', async () => {
    const real = await codexAdapter.prepare(ctx({ env: { OPENAI_API_KEY: 'sk-real' } }));
    expect(real.env.OPENAI_API_KEY).toBe('sk-real');
    const none = await codexAdapter.prepare(ctx());
    expect(none.env.OPENAI_API_KEY).toBe('orca-recorded');
  });

  it('detects by ~/.codex, and not at all in a bare environment', async () => {
    isolate(['.codex']);
    expect(await codexAdapter.detect('/work')).toBe(true);
    isolate();
    expect(await codexAdapter.detect('/work')).toBe(false);
  });
});

describe('openCodeAdapter', () => {
  it('sets both base urls because it can drive either protocol', async () => {
    const launch = await openCodeAdapter.prepare(ctx());
    expect(launch.command).toBe('opencode');
    expect(launch.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:51733/v1');
    expect(launch.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:51733');
  });

  it('passes both keys through', async () => {
    const launch = await openCodeAdapter.prepare(
      ctx({ env: { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a' } }),
    );
    expect(launch.env.OPENAI_API_KEY).toBe('sk-o');
    expect(launch.env.ANTHROPIC_API_KEY).toBe('sk-a');
  });

  it('detects by ~/.config/opencode, and not at all in a bare environment', async () => {
    isolate(['.config/opencode']);
    expect(await openCodeAdapter.detect('/work')).toBe(true);
    isolate();
    expect(await openCodeAdapter.detect('/work')).toBe(false);
  });
});

describe('genericOpenAiAdapter', () => {
  it('is never auto-selected', async () => {
    expect(genericOpenAiAdapter.id).toBe('generic-openai');
    expect(await genericOpenAiAdapter.detect('/work')).toBe(false);
    expect(await genericOpenAiAdapter.detect(process.cwd())).toBe(false);
  });

  it('takes the command from the first user arg and the rest as argv', async () => {
    const launch = await genericOpenAiAdapter.prepare(
      ctx({ userArgs: ['my-agent', '--task', 'ship it'] }),
    );
    expect(launch.command).toBe('my-agent');
    expect(launch.args).toEqual(['--task', 'ship it']);
  });

  it('sets the modern, legacy and Anthropic base urls', async () => {
    const launch = await genericOpenAiAdapter.prepare(ctx({ userArgs: ['my-agent'] }));
    expect(launch.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:51733/v1');
    expect(launch.env.OPENAI_API_BASE).toBe('http://127.0.0.1:51733/v1');
    expect(launch.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:51733');
  });

  it('says what to do when given no command', async () => {
    await expect(genericOpenAiAdapter.prepare(ctx({ userArgs: [] }))).rejects.toThrow(
      /generic-openai.*--.*command/is,
    );
  });
});

describe('AdapterRegistry', () => {
  it('registers all four adapters by default', () => {
    expect(defaultAdapters().ids()).toEqual(['claude-code', 'codex', 'opencode', 'generic-openai']);
  });

  it('returns a registered adapter by id', () => {
    expect(defaultAdapters().get('codex')).toBe(codexAdapter);
  });

  it('names the known ids and the escape hatch when an id is unknown', () => {
    let message = '';
    try {
      defaultAdapters().get('cursor');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('cursor');
    expect(message).toContain('claude-code');
    expect(message).toContain('generic-openai');
  });

  it('refuses to let one adapter silently shadow another', () => {
    const registry = new AdapterRegistry();
    registry.register(codexAdapter);
    expect(() => registry.register({ ...codexAdapter })).toThrow(/codex/);
  });

  it('detects the first adapter that claims the workspace', async () => {
    isolate(['.claude']);
    const found = await defaultAdapters().detect('/work');
    expect(found?.id).toBe('claude-code');
  });

  it('detects nothing in a bare environment', async () => {
    isolate();
    expect(await defaultAdapters().detect('/work')).toBeUndefined();
  });

  it('survives a third-party adapter whose detect throws', async () => {
    isolate(['.codex']);
    const registry = new AdapterRegistry();
    const exploding: Adapter = {
      id: 'exploding',
      detect: async () => {
        throw new Error('boom');
      },
      prepare: async () => ({ command: 'x', args: [], env: {} }),
    };
    registry.register(exploding);
    registry.register(codexAdapter);
    const found = await registry.detect('/work');
    expect(found?.id).toBe('codex');
  });
});
