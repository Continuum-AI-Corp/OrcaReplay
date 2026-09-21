import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecordContext } from '@orcareplay/plugin-api';
import { decodeForwardPath } from '@orcareplay/proxy';
import { checkAdapterContract, formatContractResult } from '../src/contract.js';
import { defaultAdapters } from '../src/registry.js';
import { redirectedConfig, zcodeAdapter } from '../src/zcode.js';

const PROXY = 'http://127.0.0.1:44100';

/**
 * ZCode is the second harness captured through its own configuration file, and the first whose
 * file is JSON. That is the whole difference: the rewrite parses a tree and walks it, so the
 * question MiniMax Code's text rewrite kept answering wrongly — did this reach every key — is not
 * a question here.
 */
describe('the zcode adapter', () => {
  let root: string;
  let ctx: RecordContext;

  const config = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: 'gw',
              enabled: true,
              config: {
                access: { type: 'api-key', apiKey: 'sk-live-must-not-be-copied' },
                api: { type: 'openai-chat-completions', baseUrl: 'https://gateway.example/v1' },
              },
            },
          ],
        },
        ...over,
      },
    });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-zcode-'));
    await mkdir(join(root, 'work'), { recursive: true });
    await mkdir(join(root, 'run'), { recursive: true });
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(root, 'home', 'provider_config.json'), config(), 'utf8');
    ctx = {
      runId: 'run_test',
      cwd: join(root, 'work'),
      runDir: join(root, 'run'),
      proxyUrl: PROXY,
      userArgs: [],
      env: { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(root, 'home', 'provider_config.json') },
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes the adapter contract', async () => {
    const result = await checkAdapterContract(zcodeAdapter);
    expect(result.ok, formatContractResult(result)).toBe(true);
  });

  it('is registered under the names a user types', () => {
    const registry = defaultAdapters();
    for (const name of ['zcode', 'zcode-cli']) expect(registry.get(name).id).toBe('zcode');
  });

  it('names its own provider file and leaves the operator theirs', async () => {
    const launch = await zcodeAdapter.prepare(ctx);
    const written = join(ctx.runDir, 'zcode-config', 'provider_config.json');
    expect(launch.command).toBe('zcode');
    expect(launch.env['ZCODE_PERSONAL_PROVIDER_CONFIG_FILE']).toBe(written);
    expect(launch.tempFiles).toEqual([written]);
    // The source is read, never written. MiniMax Code's adapter has to move a whole data
    // directory to get this; one variable does it here.
    expect(await readFile(join(root, 'home', 'provider_config.json'), 'utf8')).toContain(
      'sk-live-must-not-be-copied',
    );
  });

  it('carries the origin through the proxy and takes the key out', async () => {
    await zcodeAdapter.prepare(ctx);
    const written = JSON.parse(
      await readFile(join(ctx.runDir, 'zcode-config', 'provider_config.json'), 'utf8'),
    );
    const provider = written.config.providerConfigRules.providerRules[0].config;
    expect(decodeForwardPath(new URL(provider.api.baseUrl).pathname)?.base).toBe(
      'https://gateway.example/v1',
    );
    // §7: the file lands in the run directory, so the key does not travel with it.
    expect(provider.access.apiKey).toBe('orca-recorded');
  });

  it('reaches a key by any name and at any depth', () => {
    // The point of parsing rather than pattern-matching text. A credential three levels down
    // under a name this file has never seen is still a credential, and the walk sees it because
    // it sees every node.
    const out = redirectedConfig(
      JSON.stringify({
        config: {
          nested: {
            deeper: [
              { apiKey: 'sk-live-a', api_key: 'sk-live-b', token: 'sk-live-c' },
              { secret: 'sk-live-d', accessToken: 'sk-live-e', password: 'sk-live-f' },
            ],
          },
        },
      }),
      PROXY,
    );
    expect(out).toBeDefined();
    expect(out).not.toContain('sk-live-');
    expect([...out!.matchAll(/orca-recorded/g)]).toHaveLength(6);
  });

  it('moves an origin wherever it is nested, and leaves a documentation link alone', () => {
    const out = redirectedConfig(
      JSON.stringify({
        a: { baseUrl: 'https://one.example/v1' },
        b: [{ c: { base_url: 'https://two.example/v1' } }],
        // Not an origin the harness calls: it is where a human goes to mint a key.
        d: { apiKeyManagementUrl: 'https://three.example/keys' },
      }),
      PROXY,
    );
    const moved = [...out!.matchAll(/"base_?[uU]rl": "([^"]+)"/g)].map((m) => m[1]!);
    expect(moved.map((u) => decodeForwardPath(new URL(u).pathname)?.base)).toEqual([
      'https://one.example/v1',
      'https://two.example/v1',
    ]);
    expect(out).toContain('https://three.example/keys');
  });

  it('writes its own provider rather than half of the operator’s', async () => {
    // Two ways a carry can fail, and both end the same way: orca's own single provider, pointed
    // at the proxy. A partial redirect would leave whichever provider it missed talking to its
    // real host with nothing in the trace to say so.
    for (const body of [
      'not json at all {',
      // `/forward/` refuses userinfo, so this origin cannot be carried.
      config({ extra: { baseUrl: 'https://user:pw@gateway.example/v1' } }),
    ]) {
      await writeFile(join(root, 'home', 'provider_config.json'), body, 'utf8');
      await zcodeAdapter.prepare(ctx);
      const written = JSON.parse(
        await readFile(join(ctx.runDir, 'zcode-config', 'provider_config.json'), 'utf8'),
      );
      const rules = written.config.providerConfigRules.providerRules;
      expect(rules, body.slice(0, 20)).toHaveLength(1);
      expect(rules[0].providerId).toBe('orca');
      expect(rules[0].config.api.baseUrl).toBe(`${PROXY}/v1`);
      expect(JSON.stringify(written)).not.toContain('sk-live-');
      expect(JSON.stringify(written)).not.toContain('pw@');
    }
  });

  it('still names a provider file when there is no config to read', async () => {
    // What keeps `orca replay` honest. Replay calls this same `prepare` with the operator's
    // current environment; an adapter that redirected nothing there would let a replay run live
    // on their real providers, spend money, and report success because nothing reached the proxy.
    await rm(join(root, 'home', 'provider_config.json'));
    const launch = await zcodeAdapter.prepare(ctx);
    expect(launch.env['ZCODE_PERSONAL_PROVIDER_CONFIG_FILE']).toBeDefined();
    const written = JSON.parse(await readFile(launch.tempFiles![0]!, 'utf8'));
    expect(written.config.providerConfigRules.providerRules[0].providerId).toBe('orca');
  });

  it('asks for a model the catalogue knows', async () => {
    // ZCode builds the model from its catalogue before it builds a request. An id orca invented
    // ends the run at `Model creation failed`, measured, with nothing captured — so the fallback
    // config names a real one and lets `--model` override it.
    await rm(join(root, 'home', 'provider_config.json'));
    const launch = await zcodeAdapter.prepare(ctx);
    const written = JSON.parse(await readFile(launch.tempFiles![0]!, 'utf8'));
    expect(written.config.defaultModelSelection.modelId).toBe('glm-4.6');
    expect(written.config.modelConfigRules.providerModelRules[0].modelId).toBe('glm-4.6');
  });

  it('passes the user their own arguments', async () => {
    ctx.userArgs = ['--prompt', 'fix the auth test', '--mode', 'yolo'];
    const launch = await zcodeAdapter.prepare(ctx);
    expect(launch.args).toEqual(['--prompt', 'fix the auth test', '--mode', 'yolo']);
  });
});
