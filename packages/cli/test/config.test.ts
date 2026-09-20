import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import {
  configPath,
  gatewayHeaders,
  readConfig,
  resolveUpstream,
  writeConfig,
} from '../src/config.js';

/**
 * 0600 and 0700 say nothing on Windows: `chmod` there sets the read-only attribute and `stat`
 * answers 0o666 whatever was asked for. What actually decides who may read the file is its ACL, so
 * that is what gets checked — `(I)` marks an inherited entry, and an inherited entry on this path
 * is one the config directory handed down to it. `restrictToOwner`'s own tests in
 * @orcareplay/core cover exactly which trustees are left; the property here is that none of them
 * came from outside.
 */
async function expectOwnerOnly(path: string, mode: number): Promise<void> {
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777, path).toBe(mode);
    return;
  }
  const icacls = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const { stdout } = await promisify(execFile)(icacls, [path]);
  // Nothing inherited...
  expect(stdout, path).not.toContain('(I)');
  // ...and nothing else granted. `(I)` alone would pass a surviving *explicit* ACE for a third
  // party, which is exactly what `/inheritance:r` plus `/grant:r` used to leave behind. Counted
  // rather than named, because the names icacls prints are localized.
  const granted = stdout.split(/\r?\n/).filter((line) => line.includes(':(')).length;
  expect(granted, `${path}: expected owner, SYSTEM and Administrators only`).toBe(3);
}

/**
 * Config exists for one job: let `orca compare --models a,b,c` reach several models without the
 * user re-typing a gateway URL and a key on every invocation. That means it holds a credential,
 * which sets the bar for everything here.
 */
describe('config', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orca-cfg-'));
    env = { XDG_CONFIG_HOME: home };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('stores the file where only its owner can read it', async () => {
    // It holds an API key. 0600 is the same bar ~/.aws/credentials and ~/.npmrc set, and the
    // directory has to match or the file's mode is decoration.
    //
    // This ran on POSIX only, on the reading that Windows "cannot provide" the guarantee, because
    // `chmod 0o600` is a no-op on NTFS. It cannot provide it *as mode bits*. It has permissions
    // all the same, and without this the key sat in a file the whole machine could read.
    await writeConfig({ gateway: { url: 'https://gw.example', api_key: 'sk-secret' } }, env);

    await expectOwnerOnly(configPath(env), 0o600);
    await expectOwnerOnly(join(home, 'orca'), 0o700);
  });

  it.runIf(process.platform === 'win32')(
    'never leaves the key on disk when it cannot protect the file',
    async () => {
      // `mode: 0o600` is discarded on Windows, so until `restrictToOwner` has run the file carries
      // whatever the directory handed down. Written straight to its final path, a failure there —
      // icacls unavailable, `SystemRoot` unset — left the key readable by every account, while
      // `orca setup` reported an error that mentioned none of it. Measured before this was fixed.
      await writeConfig({ gateway: { url: 'https://gw.example', api_key: 'sk-earlier' } }, env);

      const saved = process.env['SystemRoot'];
      delete process.env['SystemRoot'];
      try {
        await expect(
          writeConfig({ gateway: { url: 'https://gw.example', api_key: 'sk-must-not-land' } }, env),
        ).rejects.toThrow(/SystemRoot/);
      } finally {
        process.env['SystemRoot'] = saved;
      }

      // Nowhere under the config directory — the staging file included — and the config that was
      // already there is intact. Truncating in place, or deleting on failure, would have taken it.
      const dir = join(home, 'orca');
      for (const name of await readdir(dir)) {
        expect(await readFile(join(dir, name), 'utf8'), name).not.toContain('sk-must-not-land');
      }
      expect(await readFile(configPath(env), 'utf8')).toContain('sk-earlier');
    },
  );

  it('reads nothing at all when a test supplies no environment', async () => {
    // The guard on vitest.setup.ts. `record`, `replay`, `attach` and `compare` all resolve their
    // upstream through `readConfig()` with no argument. If that ever returns the config of whoever
    // is running the suite, tests start sending live requests to their gateway — and never in CI,
    // which has no config, so nothing would say so.
    await expect(readConfig()).resolves.toEqual({});
  });

  it('never installs a half-written config, however many writers race', async () => {
    // The staging file used to be named after the destination alone, so every writer addressed one
    // scratch path with nothing serialising them: B's truncate landed on the file A was about to
    // rename into place, and A installed an *empty* config over the user's own while reporting
    // success. `readConfig` swallows the parse failure, so the gateway and its key simply vanish.
    //
    // The property is that nobody installs a partial file — not that every racing writer wins. On
    // Windows a rename onto a path another writer holds open fails with EPERM, and that is the
    // better half of the trade: a loud failure leaving the previous config intact, where writing
    // straight to the destination used to interleave two configs into one file in silence.
    //
    // Said plainly rather than implied: this does not reproduce the interleaving, and it was not
    // written as though it did. Restoring the shared name and running thirty writers over eight
    // rounds produced no empty and no corrupt config here, because Windows refuses the concurrent
    // open instead of truncating. The interleaving is a POSIX shape, and the reason to fix it by
    // convention — `BlobStore.put` and scrub's `commit` both randomise — rather than by a test
    // that happens to catch it. What this does guard is the invariant either way: whatever ends up
    // installed parses, and no scratch file is left to be mistaken for one.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, n) =>
        writeConfig({ gateway: { url: `https://gw-${n}.example`, api_key: `sk-${n}` } }, env),
      ),
    );
    expect(
      results.some((r) => r.status === 'fulfilled'),
      'every writer failed',
    ).toBe(true);

    const config = await readConfig(env);
    expect(config.gateway?.url, 'installed an empty or partial config').toMatch(
      /^https:\/\/gw-\d+\.example$/,
    );
    expect(config.gateway?.api_key).toMatch(/^sk-\d+$/);
    // And no scratch file survives to be mistaken for a config later.
    expect((await readdir(join(home, 'orca'))).filter((f) => f.includes('incoming'))).toEqual([]);
  });

  it('round-trips what was written', async () => {
    await writeConfig(
      { gateway: { url: 'https://gw.example', api_key: 'sk-secret' }, models: ['a', 'b'] },
      env,
    );
    const back = await readConfig(env);
    expect(back.gateway?.url).toBe('https://gw.example');
    expect(back.models).toEqual(['a', 'b']);
  });

  it('reads a key from an environment variable rather than storing it', async () => {
    // Anyone who would rather not have a credential on disk at all, which is a reasonable thing
    // to want from a tool whose whole subject is not writing secrets down.
    await writeConfig({ gateway: { url: 'https://gw.example', api_key_env: 'MY_KEY' } }, env);
    const headers = gatewayHeaders(await readConfig(env), { ...env, MY_KEY: 'sk-from-env' });
    expect(JSON.stringify(headers)).toContain('sk-from-env');
  });

  it('prefers the stored key over the env var when both are set', async () => {
    await writeConfig(
      { gateway: { url: 'https://gw.example', api_key: 'sk-stored', api_key_env: 'MY_KEY' } },
      env,
    );
    const headers = gatewayHeaders(await readConfig(env), { ...env, MY_KEY: 'sk-from-env' });
    expect(JSON.stringify(headers)).toContain('sk-stored');
  });

  it('sends no auth header at all when there is no key', async () => {
    // An empty string in an Authorization header is worse than no header: a gateway may accept it
    // as an anonymous session and the user never learns their key was not applied.
    await writeConfig({ gateway: { url: 'https://gw.example' } }, env);
    expect(gatewayHeaders(await readConfig(env), env)).toEqual({});
  });

  it('returns an empty config rather than throwing when there is none', async () => {
    expect(await readConfig(env)).toEqual({});
  });

  it('degrades instead of taking the CLI down when the file is corrupt', async () => {
    // A hand-edited config should not make every orca command unusable.
    await mkdir(join(home, 'orca'), { recursive: true });
    await writeFile(configPath(env), '{ not json', 'utf8');
    expect(await readConfig(env)).toEqual({});
  });

  describe('resolution order', () => {
    it('puts a flag above everything', async () => {
      await writeConfig({ gateway: { url: 'https://from-config' } }, env);
      const args = parseArgs(['compare', '--upstream-anthropic', 'https://from-flag']);
      const up = await resolveUpstream(args, {
        ...env,
        ORCA_UPSTREAM_ANTHROPIC: 'https://from-env',
      });
      expect(up?.anthropic).toBe('https://from-flag');
    });

    it('puts the environment above config', async () => {
      await writeConfig({ gateway: { url: 'https://from-config' } }, env);
      const up = await resolveUpstream(parseArgs(['compare']), {
        ...env,
        ORCA_UPSTREAM_ANTHROPIC: 'https://from-env',
      });
      expect(up?.anthropic).toBe('https://from-env');
    });

    it('falls back to the configured gateway for both dialects', async () => {
      // One gateway serves both wire formats, which is the point of using one.
      await writeConfig({ gateway: { url: 'https://gw.example' } }, env);
      const up = await resolveUpstream(parseArgs(['compare']), env);
      expect(up?.anthropic).toBe('https://gw.example');
      expect(up?.openai).toBe('https://gw.example');
    });

    it('routes the Responses dialect to the gateway too', async () => {
      // The proxy resolves an origin by dialect id, and the Responses API is its own dialect —
      // so a map holding only `openai` sends a Codex run straight past a gateway the user
      // configured, on their own key, without saying so.
      await writeConfig({ gateway: { url: 'https://gw.example' } }, env);
      const up = await resolveUpstream(parseArgs(['compare']), env);
      expect(up?.['openai-responses']).toBe('https://gw.example');
    });

    it('follows --upstream-openai onto the Responses dialect', async () => {
      const args = parseArgs(['compare', '--upstream-openai', 'https://from-flag']);
      const up = await resolveUpstream(args, env);
      expect(up?.['openai-responses']).toBe('https://from-flag');
    });

    it('returns undefined when nothing is configured, so vendor defaults apply', async () => {
      expect(await resolveUpstream(parseArgs(['compare']), env)).toBeUndefined();
    });
  });
});
