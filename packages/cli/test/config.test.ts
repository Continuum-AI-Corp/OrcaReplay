import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    await rm(home, { recursive: true, force: true });
  });

  it('stores the file where only its owner can read it', async () => {
    // It holds an API key. 0600 is the same bar ~/.aws/credentials and ~/.npmrc set, and the
    // directory has to match or the file's mode is decoration.
    await writeConfig({ gateway: { url: 'https://gw.example', api_key: 'sk-secret' } }, env);

    const path = configPath(env);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, 'orca'))).mode & 0o777).toBe(0o700);
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

    it('returns undefined when nothing is configured, so vendor defaults apply', async () => {
      expect(await resolveUpstream(parseArgs(['compare']), env)).toBeUndefined();
    });
  });
});
