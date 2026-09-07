import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installOpenCodeCapture } from '../src/opencode-capture.js';
import { openCodeAdapter } from '../src/opencode.js';

const PROXY = 'http://127.0.0.1:51733';
const CHATGPT = 'https://chatgpt.com/backend-api/codex/responses';
afterEach(() => vi.unstubAllGlobals());

describe('OpenCode final fetch capture', () => {
  it.each([
    CHATGPT,
    'https://api.openai.com/v1/responses',
    'https://api.openai.com/v1/chat/completions',
  ])('captures %s with its original destination and fetch options', async (url) => {
    const original = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', original);
    installOpenCodeCapture(PROXY);
    const init = { method: 'POST', body: '{}', headers: { authorization: 'Bearer fixture' } };
    await fetch(new URL(url + '?test=1'), init);
    const target = new URL(url);
    expect(original).toHaveBeenCalledExactlyOnceWith(
      `${PROXY}/forward/${encodeURIComponent(target.origin)}${target.pathname}?test=1`,
      init,
    );
  });

  it.each([
    'https://auth.openai.com/oauth/token',
    'https://chatgpt.com/backend-api/me',
    'https://chatgpt.com/backend-api/codex/responses/other',
    'https://chatgpt.com.attacker.test/backend-api/codex/responses',
    'https://api.openai.com/v1/files',
    'https://gateway.example/v1/responses',
    'http://chatgpt.com/backend-api/codex/responses',
    'https://chatgpt.com:444/backend-api/codex/responses',
    'https://user:pass@chatgpt.com/backend-api/codex/responses',
    `${PROXY}/v1/responses`,
    '/relative',
  ])('leaves unrelated or already redirected traffic alone: %s', async (url) => {
    const original = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', original);
    installOpenCodeCapture(PROXY);
    await fetch(url);
    expect(original).toHaveBeenCalledExactlyOnceWith(url, undefined);
  });

  it('preserves a Request body, auth, abort signal and init overrides', async () => {
    const original = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', original);
    installOpenCodeCapture(PROXY);
    const abort = new AbortController();
    const input = new Request(CHATGPT, {
      method: 'POST',
      body: '{"model":"gpt-5"}',
      headers: { authorization: 'Bearer fixture', 'ChatGPT-Account-Id': 'account-fixture' },
      signal: abort.signal,
    });
    const init = { redirect: 'manual' as const };
    await fetch(input, init);
    const [moved, options] = original.mock.calls[0]! as unknown as [Request, RequestInit];
    expect(moved.method).toBe('POST');
    expect(await moved.text()).toBe('{"model":"gpt-5"}');
    expect(moved.headers.get('authorization')).toBe('Bearer fixture');
    expect(moved.headers.get('ChatGPT-Account-Id')).toBe('account-fixture');
    expect(options).toBe(init);
    abort.abort();
    expect(moved.signal.aborted).toBe(true);
  });

  it('never retries a failed capture directly', async () => {
    const original = vi.fn(async () => {
      throw new Error('proxy unavailable');
    });
    vi.stubGlobal('fetch', original);
    installOpenCodeCapture(PROXY);
    await expect(fetch(CHATGPT)).rejects.toThrow('proxy unavailable');
    expect(original).toHaveBeenCalledTimes(1);
  });

  it('keeps Bun fetch helpers and makes disposed wrappers inactive', async () => {
    const original = Object.assign(
      vi.fn(async () => new Response('ok')),
      { preconnect: vi.fn() },
    );
    vi.stubGlobal('fetch', original);
    const first = installOpenCodeCapture(PROXY);
    const second = installOpenCodeCapture(PROXY);
    expect((fetch as unknown as { preconnect: unknown }).preconnect).toBe(original.preconnect);
    await first.dispose();
    await second.dispose();
    await fetch(CHATGPT);
    expect(original).toHaveBeenCalledExactlyOnceWith(CHATGPT, undefined);
  });
});

describe('OpenCode capture plugin configuration', () => {
  it('appends a loadable local plugin while preserving JSONC config and existing plugins', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca opencode-'));
    try {
      const theirs = `{
        // Existing user choices must survive.
        "model": "openai/gpt-5",
        "plugin": ["user-plugin", ["configured-plugin", {"enabled": true}]],
        "provider": {"openai": {"options": {"baseURL": "https://gateway.example/v1"}}},
      }`;
      const env = { OPENCODE_CONFIG_CONTENT: theirs };
      const launch = await openCodeAdapter.prepare({
        runId: 'run_abc123',
        cwd: scratch,
        runDir: scratch,
        proxyUrl: PROXY,
        env,
        userArgs: [],
      });
      const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
      expect(config.model).toBe('openai/gpt-5');
      expect(config.provider.openai.options.baseURL).toBe('https://gateway.example/v1');
      expect(config.plugin.slice(0, 2)).toEqual([
        'user-plugin',
        ['configured-plugin', { enabled: true }],
      ]);
      expect(env.OPENCODE_CONFIG_CONTENT).toBe(theirs);
      const source = await readFile(fileURLToPath(config.plugin[2]), 'utf8');
      expect(source).toContain(installOpenCodeCapture.toString());
      expect(source).not.toContain('import ');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
