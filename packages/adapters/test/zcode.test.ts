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
 * file is JSON. An earlier version of this comment said that was the whole difference — that
 * because the rewrite parses a tree and walks it, the question MiniMax Code's text rewrite kept
 * answering wrongly, did this reach every key, is not a question here.
 *
 * It is. Parsing settles where the values are and says nothing about which of them are secret,
 * and review found a credential under `APIKEY` walking straight through. So the tests below are
 * in two groups, matching the two things the adapter now does: the ones that check the rewrite
 * did what it understood, and the ones that check the net refused what it did not.
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

  it('moves an origin under a key name it has never seen', () => {
    // The first version of this read key names — `baseUrl`, `apiUrl` — and review named what that
    // misses. An origin is dangerous because the harness can dial it, and that is a property of
    // the value, so the value is what decides. `endpoint`, `host`, `url` and a name invented for
    // this test all move; so does the link to a key-management console, which is the price of not
    // keeping a name list, and is a link in a copy of a config that outlives one run by nothing.
    const out = redirectedConfig(
      JSON.stringify({
        a: { baseUrl: 'https://one.example/v1' },
        b: [{ c: { endpoint: 'https://two.example/v1' } }],
        d: { host: 'https://three.example/v1' },
        e: { url: 'https://four.example/v1' },
        f: { someNameZCodeHasNotInventedYet: 'https://five.example/v1' },
        g: { apiKeyManagementUrl: 'https://six.example/keys' },
      }),
      PROXY,
    );
    expect(out).toBeDefined();
    const urls = [...out!.matchAll(/"(https?:\/\/[^"]+)"/g)].map((m) => m[1]!);
    expect(urls).toHaveLength(6);
    expect(urls.map((u) => decodeForwardPath(new URL(u).pathname)?.base)).toEqual([
      'https://one.example/v1',
      'https://two.example/v1',
      'https://three.example/v1',
      'https://four.example/v1',
      'https://five.example/v1',
      'https://six.example/keys',
    ]);
  });

  it('refuses a config carrying a credential under a name the rewrite does not know', () => {
    // The net, and the reason it is not built like the rewrite. `isSecret` is an allowlist and
    // will always be incomplete — review found `APIKEY`, `Authorization` and `jwt` walking
    // through the first version of it — so what gets written is judged by what the values look
    // like, not by what they are called. Refusing means the run gets orca's own provider instead
    // of the operator's, which is the side to fail on when the alternative is a key on disk.
    const shapes = [
      'sk-live-CANARY0000000000000000000',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc',
      'deadbeefdeadbeefdeadbeefdeadbeef',
      'AKIAIOSFODNN7EXAMPLE',
    ];
    for (const name of ['monkey', 'authMode', 'notAFieldAnyoneNamed', 'key', 'auth']) {
      for (const value of shapes) {
        const out = redirectedConfig(JSON.stringify({ config: { x: { [name]: value } } }), PROXY);
        // Either the name was recognised and the value replaced, or the file was refused whole.
        // What must not happen is the value surviving into the run directory.
        expect(out ?? '', `${name} = ${value.slice(0, 12)}`).not.toContain(value);
      }
    }
  });

  it('reaches a credential spelled in capitals', () => {
    // `APIKey` and `APIKEY` walked through the first version: its camel-case branch required a
    // lowercase letter before `Key`. Widening it case-insensitively would have matched `monkey`,
    // and a rewrite with a false positive does not refuse, it corrupts — so case carries meaning
    // in these branches, and this test is what says which way.
    const out = redirectedConfig(
      JSON.stringify({
        a: { APIKey: 'sk-live-a' },
        b: { APIKEY: 'sk-live-b' },
        c: { APISecret: 'sk-live-c' },
        d: { Authorization: 'sk-live-d' },
        e: { jwt: 'sk-live-e' },
        f: { Cookie: 'sk-live-f' },
      }),
      PROXY,
    );
    expect(out).toBeDefined();
    expect(out).not.toContain('sk-live-');
    expect([...out!.matchAll(/orca-recorded/g)]).toHaveLength(6);
  });

  it('leaves a structural field called “key” alone', () => {
    // `^key$` was in the rewrite's name list, and ZCode's shipped example config has
    // `logo: { "key": "zai" }` — an image name. The rewrite replaced it with the placeholder,
    // which is the failure mode a rewrite has that a net does not: it does not refuse, it
    // corrupts. `key` and `auth` on their own are as often structure as credential, so they are
    // left to the value-shaped net; under a separator or a prefix they stay in the list.
    const out = redirectedConfig(
      JSON.stringify({
        config: {
          logo: { key: 'zai' },
          access: { auth: 'api-key', apiKey: 'sk-live-must-not-be-copied' },
          options: { key: 'reasoningLevel', map: { key: 'high' } },
        },
      }),
      PROXY,
    );
    expect(out).toBeDefined();
    expect(out).not.toContain('sk-live-');
    // Three structural `key`s and one `auth`, all still saying what they said.
    expect([...out!.matchAll(/"key": "([^"]+)"/g)].map((m) => m[1])).toEqual([
      'zai',
      'reasoningLevel',
      'high',
    ]);
    expect(out).toContain('"auth": "api-key"');
  });

  it('compares an origin by its origin, not by a prefix of the proxy URL', () => {
    // `startsWith(proxyUrl)` was the first version of the net's "already moved" test, and
    // `http://127.0.0.1:44100.evil.example` starts with `http://127.0.0.1:44100`. A hostname
    // could walk through the one check standing between a real host and the trace.
    for (const lookalike of [
      `${PROXY}.evil.example/v1`,
      `${PROXY}@evil.example/v1`,
      'http://127.0.0.1:441000/v1',
    ]) {
      const out = redirectedConfig(JSON.stringify({ config: { x: { note: lookalike } } }), PROXY);
      expect(out ?? '', lookalike).not.toContain('evil.example');
    }
  });

  it('looks inside a forwarded URL for a credential its own path carried', () => {
    // Pointing at the proxy is not the same as being empty. The net used to return early for any
    // value whose origin is the proxy's, and the rewrite gives every origin that shape — so a
    // credential in an origin's *path* was exempted by the act of forwarding it. Review found the
    // one case where that matters: 32 hex characters is the shape the redactor is documented to
    // miss, and percent-encoding leaves the run intact, so neither net ever looked at it.
    // Measured before the fix: the key below was written into the run directory verbatim.
    for (const url of [
      'https://api.example.com/v1/keys/deadbeefdeadbeefdeadbeefdeadbeef',
      'https://api.example.com/a/b/cafebabecafebabecafebabecafebabe/v1',
    ]) {
      const out = redirectedConfig(JSON.stringify({ config: { p: { baseUrl: url } } }), PROXY);
      // Refused outright: the config is written as orca's own single provider instead.
      expect(out, url).toBeUndefined();
    }
    // And the shape this must not start refusing: an origin whose path carries nothing, and a
    // value the rewrite has already pointed at the proxy.
    expect(
      redirectedConfig(
        JSON.stringify({ config: { p: { baseUrl: 'https://gw.example/v1' } } }),
        PROXY,
      ),
    ).toBeDefined();
    expect(
      redirectedConfig(JSON.stringify({ config: { p: { baseUrl: `${PROXY}/v1` } } }), PROXY),
    ).toBeDefined();
  });

  it('carries ZCode’s own shipped example config rather than refusing it', () => {
    // A tightened net has to be re-run against real input, and this is the closest thing to it
    // that ships: `provider.example.json` from the `zcode-app-cli` package, reproduced here by
    // shape. MiniMax Code's alphabet for an opaque token allows `-`, which makes
    // `zhipu-coding-plan-api-key` — an enum value, 25 characters — look like a credential and
    // refuses the whole file. Every ZCode config with a coding-plan provider would be uncaptured.
    const out = redirectedConfig(
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: 'zhipu',
                config: {
                  access: {
                    type: 'zhipu-coding-plan-api-key',
                    apiKey: 'sk-live-must-not-be-copied',
                    apiKeyManagementUrl: 'https://z.ai/manage-apikey/apikey-list',
                  },
                  api: { type: 'openai-chat-completions', baseUrl: 'https://api.example.com/v1' },
                  personalModelIds: ['deepseek/deepseek-v4-flash-free'],
                },
              },
            ],
          },
        },
      }),
      PROXY,
    );
    expect(out).toBeDefined();
    expect(out).toContain('zhipu-coding-plan-api-key');
    // A provider-qualified model id is not a credential either, and `/` is out of the alphabet
    // for that reason before it is out for Windows paths.
    expect(out).toContain('deepseek/deepseek-v4-flash-free');
    expect(out).not.toContain('sk-live-');
  });

  it('blanks ZCode’s whole environment namespace, then names the provider file', async () => {
    // The child runs on `{ ...process.env, ...launch.env }`, so an overlay that sets one variable
    // leaves every other one the operator had — and `ZCODE_BASE_URL` is an origin. A replay on
    // such a machine reaches a real host by a route the proxy is not in a position to block,
    // spends the operator's quota, and reports success because nothing arrived.
    ctx.env = {
      ...ctx.env,
      ZCODE_BASE_URL: 'https://real.z.ai',
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/home/op/builtin.json',
      ZCODE_CREDENTIAL_SECRET: 'sk-live-must-not-survive',
      ZAI_OAUTH_ORIGIN: 'https://real.z.ai',
      BIGMODEL_API_BASE_URL: 'https://open.bigmodel.cn',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-live-must-not-survive',
      // Not ZCode's, and not ZCode's to blank.
      PATH: '/usr/bin',
    };
    const launch = await zcodeAdapter.prepare(ctx);
    for (const name of [
      'ZCODE_BASE_URL',
      'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
      'ZCODE_CREDENTIAL_SECRET',
      'ZAI_OAUTH_ORIGIN',
      'BIGMODEL_API_BASE_URL',
      'OPENAI_BASE_URL',
      'OPENAI_API_KEY',
    ]) {
      expect(launch.env[name], name).toBe('');
    }
    expect(launch.env['PATH']).toBeUndefined();
    // Set last, so the sweep cannot blank the one variable the adapter depends on.
    expect(launch.env['ZCODE_PERSONAL_PROVIDER_CONFIG_FILE']).toBe(launch.tempFiles![0]);
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
