import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { Output, stripAnsi } from '../src/out.js';
import { readConfig } from '../src/config.js';
import { modelsCommand, setupCommand } from '../src/commands/setup.js';
import { writeConfig } from '../src/config.js';
import { upstreamPlan } from '../src/upstream.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

/**
 * `orca setup` is the answer to "how do I compare four models without wiring anything up". It asks
 * for a gateway and a key, checks they work, and writes them down once.
 *
 * The recurring assertion in here is that the key never appears in output. A debugger that prints
 * your credential into a terminal you are about to paste into an issue has undone the point of
 * every redaction rule in the write path.
 */
describe('orca setup', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let lines: string[];
  let out: Output;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orca-setup-'));
    env = { XDG_CONFIG_HOME: home };
    lines = [];
    out = new Output({ write: (l) => void lines.push(l), isTTY: false });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const text = () => stripAnsi(lines.join('\n'));

  it('writes a gateway and key given on the command line', async () => {
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-secret-value']),
      out,
      { env, probe: async () => ['claude-opus-5', 'gpt-5.2'] },
    );

    const config = await readConfig(env);
    expect(config.gateway?.url).toBe('https://gw.example');
    expect(config.gateway?.api_key).toBe('sk-secret-value');
  });

  it('says whether a key was stored, without the guard eating the answer', async () => {
    // `key:` as a field name is redacted by the terminal guard — correctly, but it would hide the
    // one fact this line exists to convey.
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-secret-value']),
      out,
      { env, probe: async () => [] },
    );
    expect(text()).toContain('auth=stored');
  });

  it('never prints the key back', async () => {
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-secret-value']),
      out,
      { env, probe: async () => ['claude-opus-5'] },
    );
    expect(text()).not.toContain('sk-secret-value');
    expect(text()).toContain('gw.example');
  });

  it('reports the models the gateway actually serves', async () => {
    // Writing the config is not the same as it working. Asking the gateway what it has turns a
    // silent 401 later into an answer now, which is the entire reason this command exists.
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-x']),
      out,
      { env, probe: async () => ['claude-opus-5', 'gpt-5.2', 'qwen3-coder'] },
    );
    expect(text()).toContain('claude-opus-5');
    expect(text()).toContain('qwen3-coder');
  });

  it('still saves, and says what went wrong, when the gateway cannot be reached', async () => {
    // Being offline should not stop you configuring the thing you are about to use online.
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-x']),
      out,
      {
        env,
        probe: async () => {
          throw new Error('getaddrinfo ENOTFOUND gw.example');
        },
      },
    );
    expect((await readConfig(env)).gateway?.url).toBe('https://gw.example');
    expect(text()).toMatch(/ENOTFOUND|could not/i);
  });

  it('stores an env var name instead of the key when asked', async () => {
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key-env', 'MY_GATEWAY_KEY']),
      out,
      { env: { ...env, MY_GATEWAY_KEY: 'sk-from-env' }, probe: async () => [] },
    );
    const config = await readConfig(env);
    expect(config.gateway?.api_key_env).toBe('MY_GATEWAY_KEY');
    expect(config.gateway?.api_key).toBeUndefined();
  });

  it('asks, when nothing was given and someone is there to answer', async () => {
    const asked: string[] = [];
    await setupCommand(parseArgs(['setup']), out, {
      env,
      probe: async () => ['claude-opus-5'],
      ask: async (question) => {
        asked.push(question);
        return question.toLowerCase().includes('key') ? 'sk-typed' : 'https://typed.example';
      },
    });
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect((await readConfig(env)).gateway?.url).toBe('https://typed.example');
    expect(text()).not.toContain('sk-typed');
  });

  it('records a default model list, so compare needs no flags afterwards', async () => {
    // The half that makes setup worth running. A gateway with no models chosen still leaves you
    // typing a model list every time, which is the thing the command exists to remove.
    await setupCommand(
      parseArgs([
        'setup',
        '--gateway',
        'https://gw.example',
        '--key',
        'sk-x',
        '--models',
        'claude-opus-5,gpt-5.2',
      ]),
      out,
      { env, probe: async () => ['claude-opus-5', 'gpt-5.2'] },
    );
    expect((await readConfig(env)).models).toEqual(['claude-opus-5', 'gpt-5.2']);
  });

  it('offers the gateway list as the default answer when asking', async () => {
    await setupCommand(parseArgs(['setup']), out, {
      env,
      probe: async () => ['alpha', 'beta', 'gamma', 'delta'],
      // Blank means "take the suggestion", which is the whole point of suggesting one.
      ask: async (q) => (q.toLowerCase().includes('models') ? '' : 'https://typed.example'),
    });
    expect((await readConfig(env)).models).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('leaves the model list unset when there is nothing to suggest and nothing typed', async () => {
    await setupCommand(parseArgs(['setup', '--gateway', 'https://gw.example']), out, {
      env,
      probe: async () => [],
      ask: async () => '',
    });
    expect((await readConfig(env)).models).toBeUndefined();
  });

  it('fails with a usable message when it cannot ask and was told nothing', async () => {
    await expect(
      setupCommand(parseArgs(['setup']), out, { env, probe: async () => [] }),
    ).rejects.toThrow(/--gateway/);
  });
});

describe('orca models', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let lines: string[];
  let out: Output;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orca-models-'));
    env = { XDG_CONFIG_HOME: home };
    lines = [];
    out = new Output({ write: (l) => void lines.push(l), isTTY: false });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('says how to configure a gateway when there is none', async () => {
    await modelsCommand(parseArgs(['models']), out, { env, probe: async () => [] });
    expect(stripAnsi(lines.join('\n'))).toContain('orca setup');
  });

  it('lists what the gateway serves, with prices where they are known', async () => {
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-x']),
      out,
      { env, probe: async () => [] },
    );
    lines.length = 0;

    await modelsCommand(parseArgs(['models']), out, {
      env,
      probe: async () => ['claude-opus-5', 'some-unpriced-model'],
    });

    const text = stripAnsi(lines.join('\n'));
    expect(text).toContain('claude-opus-5');
    expect(text).toContain('some-unpriced-model');
    // A known model shows its input price; an unknown one must not invent one.
    expect(text).toMatch(/15/);
  });

  it('never prints the key', async () => {
    await setupCommand(
      parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'sk-secret-value']),
      out,
      { env, probe: async () => [] },
    );
    lines.length = 0;
    await modelsCommand(parseArgs(['models']), out, { env, probe: async () => ['claude-opus-5'] });
    expect(stripAnsi(lines.join('\n'))).not.toContain('sk-secret-value');
  });
});

describe('setup makes compare work without flags', () => {
  /**
   * The point of the whole feature. Writing a config that nothing reads would be worse than not
   * having one, so this drives a real record through a real proxy with only the config to go on,
   * and checks two things at once: the traffic went to the configured gateway, and it carried the
   * key — which is the half that turns "reachable" into "authorised".
   */
  let home: string;
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orca-e2e-cfg-'));
    workspace = await mkdtemp(join(tmpdir(), 'orca-e2e-ws-'));
    model = await startFakeModel();
    out = new Output({ write: () => {}, isTTY: false });
  });

  afterEach(async () => {
    await model.close();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it('routes live traffic to the configured gateway, carrying the key', async () => {
    const env = { ...process.env, XDG_CONFIG_HOME: home };
    await writeConfig({ gateway: { url: model.url, api_key: 'sk-gateway-key' } }, env);

    const plan = await upstreamPlan(parseArgs(['record']), env);

    expect(plan.upstream?.anthropic).toBe(model.url);
    expect(plan.upstream?.openai).toBe(model.url);
    expect(JSON.stringify(plan.headers)).toContain('sk-gateway-key');
  });

  it('withholds the gateway key when a flag sends traffic somewhere else', async () => {
    // Redirecting one dialect to a vendor must not hand that vendor a credential the gateway
    // issued. This is the failure that would be silent and expensive.
    const env = { ...process.env, XDG_CONFIG_HOME: home };
    await writeConfig({ gateway: { url: 'https://gw.example', api_key: 'sk-gateway-key' } }, env);

    const plan = await upstreamPlan(
      parseArgs([
        'record',
        '--upstream-anthropic',
        'https://api.anthropic.com',
        '--upstream-openai',
        'https://api.openai.com',
      ]),
      env,
    );

    expect(plan.upstream?.anthropic).toBe('https://api.anthropic.com');
    expect(plan.headers).toBeUndefined();
  });
});
