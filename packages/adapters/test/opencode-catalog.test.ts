import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPENCODE_API_BASES } from '../src/opencode-api-bases.js';
import { collectOpenCodeApiBases, refreshOpenCodeApiBases } from '../src/opencode-catalog.js';
import { installOpenCodeCapture } from '../src/opencode-capture.js';

const PROXY = 'http://127.0.0.1:51733';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('OpenCode API catalog', () => {
  it('collects provider and model-specific APIs independently of SDK and skips malformed entries', () => {
    expect(
      collectOpenCodeApiBases({
        compatible: {
          api: 'https://compatible.test/v4',
          models: {
            claude: { provider: { api: 'https://anthropic.test/coding/v1' } },
            duplicate: { provider: { api: 'https://compatible.test/v4' } },
            noOverride: {},
            invalid: null,
          },
        },
        sdk: { models: { model: { provider: { api: 'http://localhost:8080/v1' } } } },
        missing: { models: null },
        bad: null,
        invalid: { api: 42 },
      }),
    ).toEqual([
      'https://compatible.test/v4',
      'https://anthropic.test/coding/v1',
      'http://localhost:8080/v1',
    ]);
    for (const bad of [null, [], '', { error: 'unavailable' }]) {
      expect(collectOpenCodeApiBases(bad)).toEqual([]);
    }
  });

  it('refreshes public metadata with a bounded request and retains offline endpoints', async () => {
    const original = vi.fn(async () => Response.json({ added: { api: 'https://new.test/v1' } }));
    vi.stubGlobal('fetch', original);
    expect(await refreshOpenCodeApiBases(['https://old.test/v1'])).toEqual([
      'https://old.test/v1',
      'https://new.test/v1',
    ]);
    expect(original).toHaveBeenCalledExactlyOnceWith('https://models.opencode.ai/api.json', {
      signal: expect.any(AbortSignal),
      redirect: 'error',
      credentials: 'omit',
    });
  });

  it.each(['network', 'http', 'json', 'empty'])(
    'falls back on %s errors without leaking error details',
    async (failure) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          if (failure === 'network') throw new Error('sensitive-error-fixture');
          if (failure === 'http') return new Response('sensitive-error-fixture', { status: 503 });
          if (failure === 'json') return new Response('sensitive-error-fixture');
          return Response.json({});
        }),
      );
      expect(await refreshOpenCodeApiBases(OPENCODE_API_BASES)).toBe(OPENCODE_API_BASES);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive-error-fixture');
    },
  );

  it('does not fetch metadata in explicitly offline mode', async () => {
    const original = vi.fn();
    vi.stubGlobal('fetch', original);
    expect(await refreshOpenCodeApiBases(OPENCODE_API_BASES, false)).toBe(OPENCODE_API_BASES);
    expect(original).not.toHaveBeenCalled();
  });
});

describe('catalog final fetch capture', () => {
  // Every shipped catalog template, including model overrides, is exercised without live APIs.
  it.each(OPENCODE_API_BASES)('captures POST beneath %s', async (template) => {
    const expand = (key: string) =>
      key === 'NEON_AI_GATEWAY_BASE_URL' ? 'https://neon-fixture.test' : 'fixture-value';
    for (const [, key] of template.matchAll(/\$\{([^}]+)\}/g)) vi.stubEnv(key!, expand(key!));
    const base = template.replace(/\$\{([^}]+)\}/g, (_, key: string) => expand(key));
    const target = new URL(base.replace(/\/+$/, '') + '/chat/completions?api-version=fixture');
    const original = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', original);
    installOpenCodeCapture(PROXY, OPENCODE_API_BASES);
    const init = { method: 'POST', body: '{}', headers: { authorization: 'Bearer fixture' } };
    await fetch(target, init);
    expect(original).toHaveBeenCalledExactlyOnceWith(
      `${PROXY}/forward/${encodeURIComponent(target.origin)}${target.pathname}${target.search}`,
      init,
    );
  });

  it.each([
    'https://api.fixture.test/v10/chat/completions',
    'https://api.fixture.test.attacker.test/v1/chat/completions',
    'https://api.fixture.test:444/v1/chat/completions',
    'http://api.fixture.test/v1/chat/completions',
    'https://user:pass@api.fixture.test/v1/chat/completions',
    'https://api.fixture.test/oauth/token',
    `${PROXY}/v1/chat/completions`,
  ])('does not widen matching to %s', async (target) => {
    const original = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', original);
    installOpenCodeCapture(PROXY, ['https://api.fixture.test/v1', PROXY]);
    const init = { method: 'POST', body: '{}' };
    await fetch(target, init);
    expect(original).toHaveBeenCalledExactlyOnceWith(target, init);
  });

  it('passes discovery GETs through and honors Request methods and init overrides', async () => {
    const original = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', original);
    installOpenCodeCapture(PROXY, ['https://api.fixture.test/v1']);
    const target = 'https://api.fixture.test/v1/chat/completions';
    await fetch(target);
    expect(original).toHaveBeenLastCalledWith(target, undefined);
    const request = new Request(target, {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer fixture' },
    });
    await fetch(request);
    const moved = original.mock.calls[1]![0] as unknown as Request;
    expect(moved.url).toBe(`${PROXY}/forward/https%3A%2F%2Fapi.fixture.test/v1/chat/completions`);
    expect(await moved.text()).toBe('{}');
    expect(moved.headers.get('authorization')).toBe('Bearer fixture');
    await fetch(target, { method: 'GET' });
    expect(original).toHaveBeenLastCalledWith(target, { method: 'GET' });
  });

  it('learns model overrides and custom provider bases from the OpenCode hook', async () => {
    const original = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', original);
    const plugin = installOpenCodeCapture(PROXY);
    const input = {
      model: { api: { url: 'https://model.test/v1' } },
      provider: { options: { baseURL: 'http://localhost:9911/custom' } },
    };
    const before = JSON.stringify(input);
    await plugin['chat.params'](input);
    for (const base of ['https://model.test/v1', 'http://localhost:9911/custom']) {
      const target = new URL(base + '/messages');
      const init = { method: 'POST', body: '{}' };
      await fetch(target, init);
      expect(original).toHaveBeenLastCalledWith(
        `${PROXY}/forward/${encodeURIComponent(target.origin)}${target.pathname}`,
        init,
      );
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it('ignores invalid bases and unexpanded variables instead of using wildcard matches', async () => {
    vi.stubEnv('ORCA_MISSING_CATALOG_TEST', undefined);
    const original = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', original);
    installOpenCodeCapture(PROXY, [
      'https://${ORCA_MISSING_CATALOG_TEST}.test/v1',
      'not a URL',
      'ftp://fixture.test/v1',
      'https://user:pass@fixture.test/v1',
      'https://fixture.test/v1?key=fixture',
      'https://fixture.test/v1#fragment',
    ]);
    const target = 'https://fixture.test/v1/chat/completions';
    const init = { method: 'POST', body: '{}' };
    await fetch(target, init);
    expect(original).toHaveBeenCalledExactlyOnceWith(target, init);
  });
});
