import type { Adapter, RecordContext } from '@orcareplay/plugin-api';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_CHECKS,
  checkAdapterContract,
  defaultAdapters,
  formatContractResult,
  passKey,
  passThrough,
  PLACEHOLDER_KEY,
  proxyBase,
} from '../src/index.js';

/**
 * Two halves, and both are load-bearing. The first runs every *registered* adapter through the
 * contract, so an adapter someone adds tomorrow is covered without anyone remembering to opt in.
 * The second runs deliberately broken adapters through it, so every check is proven to bite —
 * a green contract over checks that never fail is worse than no contract, because it is believed.
 */

const PROXY = 'http://127.0.0.1:51733';

/** Satisfies every check. Each fixture below is this adapter with exactly one thing broken. */
function goodAdapter(over: Partial<Adapter> = {}): Adapter {
  return {
    id: 'fixture-good',
    async detect(): Promise<boolean> {
      return false;
    },
    async prepare(ctx: RecordContext) {
      const env: Record<string, string> = { OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1') };
      passKey(env, ctx.env, 'OPENAI_API_KEY');
      return { command: 'fixture', args: [...ctx.userArgs], env };
    },
    ...over,
  };
}

async function failedChecks(adapter: Adapter): Promise<string[]> {
  const result = await checkAdapterContract(adapter);
  return result.failed.map((f) => f.check);
}

async function detailOf(adapter: Adapter, check: string): Promise<string> {
  const result = await checkAdapterContract(adapter);
  return result.failed.find((f) => f.check === check)?.detail ?? '';
}

describe('every registered adapter', () => {
  const registry = defaultAdapters();

  it.each(registry.ids())('%s satisfies the adapter contract', async (id) => {
    const result = await checkAdapterContract(registry.get(id), {
      ctx: { proxyUrl: PROXY },
    });
    expect(formatContractResult(result)).toBe(`${id}: ok (${result.passed.length} checks)`);
    expect(result.failed).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each(registry.ids())('%s is checked by every contract check, not a subset', async (id) => {
    const adapter = registry.get(id);
    const result = await checkAdapterContract(adapter);
    // harness-versions only applies to adapters that declare a range; everything else is universal.
    const universal = CONTRACT_CHECKS.filter((c) => c !== 'harness-versions');
    // An adapter that captures at the transport redirects nothing on purpose, so the one check
    // that asks "where does this point the harness" cannot apply to it. The exemption is narrow
    // by construction: it is subtracted here by name, so a transport adapter that stopped passing
    // any *other* check would still fail this test rather than quietly opt out of the contract.
    const exempt = adapter.capture === 'transport' ? ['redirects-model-traffic'] : [];
    const required = universal.filter((c) => !exempt.includes(c));
    expect(result.passed).toEqual(expect.arrayContaining([...required]));
    for (const check of exempt) expect(result.passed).not.toContain(check);
  });

  it('covers the registry as a whole, so a new adapter cannot skip the guard', async () => {
    const results = await Promise.all(
      registry.ids().map((id) => checkAdapterContract(registry.get(id))),
    );
    expect(results.map((r) => r.adapter)).toEqual(registry.ids());
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe('the reference fixture', () => {
  it('passes, so a fixture that fails below fails for its one deliberate flaw', async () => {
    expect(await failedChecks(goodAdapter())).toEqual([]);
  });
});

describe('id-format', () => {
  it('rejects an id that is not lowercase kebab-case', async () => {
    expect(await failedChecks(goodAdapter({ id: 'My_Adapter' }))).toEqual(['id-format']);
  });

  it('rejects an empty id', async () => {
    expect(await failedChecks(goodAdapter({ id: '' }))).toEqual(['id-format']);
  });

  it('accepts digits and multiple segments', async () => {
    expect(await failedChecks(goodAdapter({ id: 'my-agent-2' }))).toEqual([]);
  });
});

describe('detect-resolves', () => {
  it('catches a detect that throws, because one detector aborts detection for all', async () => {
    const exploding = goodAdapter({
      detect: async () => {
        throw new Error('ENOENT: no such file or directory');
      },
    });
    expect(await failedChecks(exploding)).toEqual(['detect-resolves']);
    expect(await detailOf(exploding, 'detect-resolves')).toContain('ENOENT');
  });

  it('catches a detect that throws only on a path that does not exist', async () => {
    const picky = goodAdapter({
      detect: async (cwd: string) => {
        if (cwd.includes('missing')) throw new Error('cannot stat');
        return false;
      },
    });
    expect(await failedChecks(picky)).toEqual(['detect-resolves']);
  });

  it('catches a detect that answers with something other than a boolean', async () => {
    // `if (await adapter.detect(cwd))` treats any truthy value as a claim on the workspace.
    const sloppy = goodAdapter({ detect: async () => 'yes' as unknown as boolean });
    expect(await failedChecks(sloppy)).toEqual(['detect-resolves']);
  });
});

describe('prepare-shape', () => {
  it('catches an empty command', async () => {
    const noCommand = goodAdapter({
      async prepare(ctx: RecordContext) {
        return { command: '', args: [], env: { OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1') } };
      },
    });
    expect(await failedChecks(noCommand)).toEqual(['prepare-shape']);
  });

  it('catches args that are not an array of strings', async () => {
    const badArgs = goodAdapter({
      async prepare(ctx: RecordContext) {
        return {
          command: 'fixture',
          args: '--flag' as unknown as string[],
          env: { OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1') },
        };
      },
    });
    expect(await failedChecks(badArgs)).toEqual(['prepare-shape']);
  });

  it('reports a rejected prepare instead of throwing out of the contract runner', async () => {
    const throws = goodAdapter({
      prepare: async () => {
        throw new Error('needs a command after --');
      },
    });
    const result = await checkAdapterContract(throws);
    expect(result.ok).toBe(false);
    expect(result.failed.map((f) => f.check)).toContain('prepare-shape');
    expect(result.failed[0]?.detail).toContain('needs a command after --');
  });
});

describe('redirects-model-traffic', () => {
  it('catches an adapter that redirects nothing at all', async () => {
    const blind = goodAdapter({
      async prepare(ctx: RecordContext) {
        const env: Record<string, string> = {};
        passKey(env, ctx.env, 'OPENAI_API_KEY');
        return { command: 'fixture', args: [...ctx.userArgs], env };
      },
    });
    expect(await failedChecks(blind)).toEqual(['redirects-model-traffic']);
  });

  it('catches the rot case: the harness moved and the base url still points upstream', async () => {
    // The bug this whole file exists for. The agent runs, the user sees answers, and the trace
    // is empty — because the adapter is pointing a variable the harness no longer reads, or is
    // pointing it at the real API.
    const rotted = goodAdapter({
      async prepare(ctx: RecordContext) {
        const env: Record<string, string> = { OPENAI_BASE_URL: 'https://api.openai.com/v1' };
        passKey(env, ctx.env, 'OPENAI_API_KEY');
        return { command: 'fixture', args: [...ctx.userArgs], env };
      },
    });
    const names = await failedChecks(rotted);
    expect(names).toEqual(['redirects-model-traffic']);
    expect(await detailOf(rotted, 'redirects-model-traffic')).toContain('OPENAI_BASE_URL');
  });

  it('catches a second base-url variable left pointing upstream', async () => {
    const half = goodAdapter({
      async prepare(ctx: RecordContext) {
        return {
          command: 'fixture',
          args: [],
          env: {
            OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
          },
        };
      },
    });
    expect(await failedChecks(half)).toEqual(['redirects-model-traffic']);
  });

  it('checks base-url variables it has never heard of, which is where rot lands', async () => {
    const newVar = goodAdapter({
      async prepare(ctx: RecordContext) {
        return {
          command: 'fixture',
          args: [],
          env: {
            OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
            MYAGENT_API_BASE: 'https://api.myagent.dev/v1',
          },
        };
      },
    });
    expect(await failedChecks(newVar)).toEqual(['redirects-model-traffic']);
  });

  it('accepts any of the three known variables on its own', async () => {
    for (const name of ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE']) {
      const single = goodAdapter({
        async prepare(ctx: RecordContext) {
          return { command: 'fixture', args: [], env: { [name]: proxyBase(ctx.proxyUrl) } };
        },
      });
      expect(await failedChecks(single)).toEqual([]);
    }
  });

  it('follows the proxy url it was given rather than a hardcoded one', async () => {
    const hardcoded = goodAdapter({
      async prepare() {
        return { command: 'fixture', args: [], env: { OPENAI_BASE_URL: `${PROXY}/v1` } };
      },
    });
    const result = await checkAdapterContract(hardcoded, {
      ctx: { proxyUrl: 'http://127.0.0.1:9999' },
    });
    expect(result.failed.map((f) => f.check)).toEqual(['redirects-model-traffic']);
  });
});

describe('no-invented-keys', () => {
  it('catches an invented credential that is not the documented placeholder', async () => {
    const inventor = goodAdapter({
      async prepare(ctx: RecordContext) {
        return {
          command: 'fixture',
          args: [],
          env: {
            OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
            OPENAI_API_KEY: 'sk-fixture-not-a-real-key',
          },
        };
      },
    });
    expect(await failedChecks(inventor)).toEqual(['no-invented-keys']);
    expect(await detailOf(inventor, 'no-invented-keys')).not.toContain('sk-fixture');
  });

  it('catches inventing one provider credential when the user only has another', async () => {
    // Provider auto-selection keys off which credentials are present, so a fabricated second
    // credential can change which model the harness calls under recording.
    const crossProvider = goodAdapter({
      async prepare(ctx: RecordContext) {
        const env: Record<string, string> = {
          OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
          ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl),
        };
        passKey(env, ctx.env, 'OPENAI_API_KEY');
        passKey(env, ctx.env, 'ANTHROPIC_API_KEY');
        return { command: 'fixture', args: [], env };
      },
    });
    expect(await failedChecks(crossProvider)).toEqual(['no-invented-keys']);
    expect(await detailOf(crossProvider, 'no-invented-keys')).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('accepts a placeholder for the one provider the harness speaks', async () => {
    expect(await failedChecks(goodAdapter())).toEqual([]);
  });

  it('accepts a second provider credential that is passed through, not invented', async () => {
    const passesThrough = goodAdapter({
      async prepare(ctx: RecordContext) {
        const env: Record<string, string> = {
          OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
          ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl),
        };
        passKey(env, ctx.env, 'OPENAI_API_KEY');
        passThrough(env, ctx.env, 'ANTHROPIC_API_KEY');
        return { command: 'fixture', args: [], env };
      },
    });
    expect(await failedChecks(passesThrough)).toEqual([]);
  });

  it('accepts placeholders for both providers when the user has neither', async () => {
    // Nothing to flip: with no credential at all the harness has no provider preference to
    // misread, and a client that refuses to start without a key is worse than useless.
    const both = goodAdapter({
      async prepare(ctx: RecordContext) {
        const env: Record<string, string> = {
          OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
          ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl),
        };
        const anyKey =
          ctx.env['OPENAI_API_KEY'] !== undefined || ctx.env['ANTHROPIC_API_KEY'] !== undefined;
        if (anyKey) {
          passThrough(env, ctx.env, 'OPENAI_API_KEY');
          passThrough(env, ctx.env, 'ANTHROPIC_API_KEY');
        } else {
          env['OPENAI_API_KEY'] = PLACEHOLDER_KEY;
          env['ANTHROPIC_API_KEY'] = PLACEHOLDER_KEY;
        }
        return { command: 'fixture', args: [], env };
      },
    });
    expect(await failedChecks(both)).toEqual([]);
  });
});

describe('no-ctx-mutation', () => {
  it('catches an adapter that pushes into ctx.userArgs', async () => {
    const mutator = goodAdapter({
      async prepare(ctx: RecordContext) {
        ctx.userArgs.unshift('--recorded');
        return {
          command: 'fixture',
          args: ctx.userArgs,
          env: { OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1') },
        };
      },
    });
    expect(await failedChecks(mutator)).toEqual(['no-ctx-mutation']);
  });

  it('catches an adapter that writes its overlay onto ctx.env', async () => {
    const mutator = goodAdapter({
      async prepare(ctx: RecordContext) {
        ctx.env['OPENAI_BASE_URL'] = proxyBase(ctx.proxyUrl, 'v1');
        return {
          command: 'fixture',
          args: [],
          env: { OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1') },
        };
      },
    });
    expect(await failedChecks(mutator)).toEqual(['no-ctx-mutation']);
  });
});

describe('deterministic', () => {
  it('catches an adapter whose argv changes between two identical calls', async () => {
    let n = 0;
    const drifting = goodAdapter({
      async prepare(ctx: RecordContext) {
        n += 1;
        return {
          command: 'fixture',
          args: ['--session', String(n)],
          env: { OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1') },
        };
      },
    });
    expect(await failedChecks(drifting)).toEqual(['deterministic']);
  });
});

describe('no-foreign-paths', () => {
  it('catches a developer home directory leaking into the launch env', async () => {
    const leaky = goodAdapter({
      async prepare(ctx: RecordContext) {
        return {
          command: 'fixture',
          args: [],
          env: {
            OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
            MYAGENT_CONFIG: '/home/someone/.config/myagent/config.json',
          },
        };
      },
    });
    expect(await failedChecks(leaky)).toEqual(['no-foreign-paths']);
    expect(await detailOf(leaky, 'no-foreign-paths')).toContain('/home/someone');
  });

  it('accepts a path the adapter wrote inside ctx.runDir', async () => {
    const tidy = goodAdapter({
      async prepare(ctx: RecordContext) {
        return {
          command: 'fixture',
          args: [],
          env: {
            OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
            MYAGENT_CONFIG: `${ctx.runDir}/myagent.json`,
          },
        };
      },
    });
    expect(await failedChecks(tidy)).toEqual([]);
  });

  it('does not mistake the path segment of the proxy url for a filesystem path', async () => {
    const withPath = goodAdapter({
      async prepare(ctx: RecordContext) {
        return {
          command: 'fixture',
          args: [],
          env: { OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1/openai/deep/path') },
        };
      },
    });
    expect(await failedChecks(withPath)).toEqual([]);
  });
});

describe('harness-versions', () => {
  it('accepts the ranges adapters actually use', async () => {
    for (const range of ['>=1.0.0', '>=1.2.0 <2', '^0.3.1', '1.x', '*', '1.2.3 - 2.0.0', '~2.1']) {
      expect(await failedChecks(goodAdapter({ harnessVersions: range }))).toEqual([]);
    }
  });

  it('rejects a range that is not semver', async () => {
    expect(await failedChecks(goodAdapter({ harnessVersions: 'latest' }))).toEqual([
      'harness-versions',
    ]);
  });

  it('rejects an empty range, which reads as "unset" but is not', async () => {
    expect(await failedChecks(goodAdapter({ harnessVersions: '  ' }))).toEqual([
      'harness-versions',
    ]);
  });

  it('is skipped, not failed, when the adapter declares no range', async () => {
    const result = await checkAdapterContract(goodAdapter());
    expect(result.passed).not.toContain('harness-versions');
    expect(result.ok).toBe(true);
  });
});

describe('checkAdapterContract', () => {
  it('names the adapter and derives ok from the failures', async () => {
    const result = await checkAdapterContract(goodAdapter({ id: 'named-fixture' }));
    expect(result.adapter).toBe('named-fixture');
    expect(result.ok).toBe(result.failed.length === 0);
  });

  it('runs every check even after one fails, so one PR fixes the whole list', async () => {
    const awful: Adapter = {
      id: 'Awful_Adapter',
      harnessVersions: 'whenever',
      detect: async () => {
        throw new Error('boom');
      },
      async prepare(ctx: RecordContext) {
        ctx.userArgs.push('--mutated');
        return { command: 'awful', args: [], env: { OPENAI_API_KEY: 'sk-invented' } };
      },
    };
    const names = await failedChecks(awful);
    expect(names).toEqual(
      expect.arrayContaining([
        'id-format',
        'detect-resolves',
        'redirects-model-traffic',
        'no-invented-keys',
        'no-ctx-mutation',
        'harness-versions',
      ]),
    );
  });

  it('lets the caller supply the argv an adapter needs', async () => {
    const needsArgv = goodAdapter({
      async prepare(ctx: RecordContext) {
        const [command, ...args] = ctx.userArgs;
        if (command === undefined) throw new Error('no command');
        return { command, args, env: { OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1') } };
      },
    });
    expect(await failedChecks(needsArgv)).toEqual([]);
    const bare = await checkAdapterContract(needsArgv, { ctx: { userArgs: [] } });
    expect(bare.failed.map((f) => f.check)).toContain('prepare-shape');
  });

  it('gives a failing result a one-line summary naming the checks', async () => {
    const result = await checkAdapterContract(goodAdapter({ id: 'bad', harnessVersions: 'nope' }));
    expect(formatContractResult(result)).toContain('bad');
    expect(formatContractResult(result)).toContain('harness-versions');
  });
});
