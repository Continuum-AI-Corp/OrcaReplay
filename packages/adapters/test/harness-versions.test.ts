import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { defaultAdapters } from '../src/index.js';

/**
 * Recorded wire contracts, one per adapter.
 *
 * A fixture is a claim: *against these harness versions, on this date, this adapter set exactly
 * these variables to exactly these values.* The contract in contract.ts checks that an adapter is
 * still shaped correctly; these fixtures check that it has not quietly changed shape.
 *
 * **When a harness changes and someone updates an adapter, the fixture must be updated in the
 * same PR.** That is the whole point. The diff is where a reviewer sees "this adapter now sets a
 * different variable" — and `verified_at` is the reviewer's cue to ask the only question that
 * matters: did you actually run the harness, or did you guess? A fixture nobody has to touch is a
 * fixture that records what the adapter used to do.
 *
 * `verified_at` is the day someone last confirmed the adapter against a running harness.
 */

const PROXY = 'http://127.0.0.1:51733';
/** First arg is the command for adapters that take one (generic-openai); the rest is padding. */
const USER_ARGS = ['my-agent', '--task', 'demo'];
const FIXTURES = new URL('../fixtures/harness/', import.meta.url);
const BASE_URL_LIKE = /(?:_BASE_URL|_API_BASE)$/;

interface HarnessFixture {
  adapter: string;
  harness_versions: string | null;
  verified_at: string;
  command: string;
  /** Every variable a bare run sets, sorted. The exact wire contract. */
  env_vars: string[];
  /** Base-url variable to the path appended to the proxy url. */
  base_urls: Record<string, string>;
  /** Set only when the incoming environment already carries them — never invented. */
  optional_env_vars: string[];
  note?: string;
}

/**
 * A real directory, because `ctx.runDir` is where the contract tells an adapter to put scratch
 * files — the MCP config rewrite and the fetch instrument both write one. With `/work` hardcoded
 * here, the first adapter to do that created a directory at the filesystem root on whoever ran
 * the tests, or failed outright on a machine where they could not.
 */
const SCRATCH = mkdtempSync(join(tmpdir(), 'orca-harness-fixture-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

function ctx(over: Partial<RecordContext> = {}): RecordContext {
  return {
    runId: 'run_fixture',
    cwd: join(SCRATCH, 'work'),
    proxyUrl: PROXY,
    runDir: join(SCRATCH, 'work', '.orca', 'runs', 'run_fixture'),
    userArgs: [...USER_ARGS],
    env: {},
    ...over,
  };
}

function fixturePath(id: string): string {
  return fileURLToPath(new URL(`${id}.json`, FIXTURES));
}

/** What the adapter does today, in fixture shape — the failure message pastes straight into JSON. */
function observed(adapter: Adapter, launch: Launch): Omit<HarnessFixture, 'verified_at'> {
  const baseUrls: Record<string, string> = {};
  for (const [name, value] of Object.entries(launch.env)) {
    if (BASE_URL_LIKE.test(name)) baseUrls[name] = value.slice(PROXY.length);
  }
  return {
    adapter: adapter.id,
    harness_versions: adapter.harnessVersions ?? null,
    command: launch.command,
    env_vars: Object.keys(launch.env).sort(),
    base_urls: baseUrls,
    optional_env_vars: [],
  };
}

function readFixture(adapter: Adapter, launch: Launch): HarnessFixture {
  const path = fixturePath(adapter.id);
  if (!existsSync(path)) {
    const suggestion = { ...observed(adapter, launch), verified_at: 'YYYY-MM-DD' };
    throw new Error(
      `no harness fixture for '${adapter.id}'. Without one, nothing notices when the harness ` +
        `changes what it reads. Create fixtures/harness/${adapter.id}.json:\n` +
        `${JSON.stringify(suggestion, null, 2)}\n` +
        'setting verified_at to the day you ran the harness and harness_versions to the range ' +
        'you ran it against.',
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as HarnessFixture;
}

const registry = defaultAdapters();

describe.each(registry.ids())('%s', (id) => {
  const adapter = registry.get(id);

  it('still produces the env it was recorded with', async () => {
    const launch = await adapter.prepare(ctx());
    const fixture = readFixture(adapter, launch);
    expect(Object.keys(launch.env).sort()).toEqual(fixture.env_vars);
    expect(launch.command).toBe(fixture.command);
  });

  it('still points every base url at the proxy, on the recorded path', async () => {
    const launch = await adapter.prepare(ctx());
    const fixture = readFixture(adapter, launch);
    for (const [name, path] of Object.entries(fixture.base_urls)) {
      expect(launch.env[name]).toBe(`${PROXY}${path}`);
    }
    // A base-url variable the adapter grew without a fixture entry is exactly the silent change
    // this file exists to catch.
    const live = Object.keys(launch.env).filter((name) => BASE_URL_LIKE.test(name));
    expect(live.sort()).toEqual(Object.keys(fixture.base_urls).sort());
  });

  it('passes its optional variables through without inventing them', async () => {
    const bare = await adapter.prepare(ctx());
    const fixture = readFixture(adapter, bare);
    for (const name of fixture.optional_env_vars) {
      expect(Object.keys(bare.env)).not.toContain(name);
      const carried = await adapter.prepare(ctx({ env: { [name]: 'from-the-user' } }));
      expect(carried.env[name]).toBe('from-the-user');
    }
  });

  it('records the harness versions the adapter declares, so the two cannot drift', async () => {
    const fixture = readFixture(adapter, await adapter.prepare(ctx()));
    expect(fixture.harness_versions).toBe(adapter.harnessVersions ?? null);
    expect(fixture.adapter).toBe(id);
  });

  it('carries a real verification date', async () => {
    const fixture = readFixture(adapter, await adapter.prepare(ctx()));
    expect(fixture.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(fixture.verified_at))).toBe(false);
  });
});

describe('the fixture directory', () => {
  it('has one fixture per registered adapter and no orphans', () => {
    const files = readdirSync(fileURLToPath(FIXTURES))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect(files).toEqual([...registry.ids()].sort());
  });
});
