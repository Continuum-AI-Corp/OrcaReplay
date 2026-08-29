import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { Output, stripAnsi } from '../src/out.js';
import { ORCAROUTER_CONSOLE, ORCAROUTER_URL, readConfig } from '../src/config.js';
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

  describe('the OrcaRouter default', () => {
    it('fills the blank when the answer is empty', async () => {
      const asked: string[] = [];
      const config = await setupCommand(parseArgs(['setup']), out, {
        env,
        probe: async () => ['claude-opus-5'],
        // Enter on both questions: the gateway takes the default, the key is left unset.
        ask: async (q) => {
          asked.push(q);
          return '';
        },
      });

      expect(config.gateway?.url).toBe(ORCAROUTER_URL);
      expect(asked[0], 'the default has to be visible in the prompt').toContain(ORCAROUTER_URL);
      expect(await readConfig(env)).toMatchObject({ gateway: { url: ORCAROUTER_URL } });
    });

    it('is overridden by anything the user actually types', async () => {
      const config = await setupCommand(parseArgs(['setup']), out, {
        env,
        probe: async () => ['some-model'],
        ask: async (q) => (q.startsWith('Gateway') ? 'https://gw.example' : ''),
      });
      expect(config.gateway?.url).toBe('https://gw.example');
    });

    it('is overridden by --gateway, which skips the question entirely', async () => {
      const asked: string[] = [];
      const config = await setupCommand(
        parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'k']),
        out,
        {
          env,
          probe: async () => ['some-model'],
          ask: async (q) => {
            asked.push(q);
            return '';
          },
        },
      );
      expect(config.gateway?.url).toBe('https://gw.example');
      expect(asked.some((q) => q.startsWith('Gateway'))).toBe(false);
    });

    it('works non-interactively with only a key', async () => {
      // A terminal-less `orca setup --key <k>` used to fail with "no gateway to configure".
      const config = await setupCommand(parseArgs(['setup', '--key', 'sk-secret-value']), out, {
        env,
        probe: async () => ['claude-opus-5'],
      });
      expect(config.gateway?.url).toBe(ORCAROUTER_URL);
      expect(text(), 'still never the key itself').not.toContain('sk-secret-value');
    });

    it('says where to get a key, but only for the gateway it suggested', async () => {
      await setupCommand(parseArgs(['setup']), out, {
        env,
        probe: async () => [],
        ask: async () => '',
      });
      expect(text()).toContain(ORCAROUTER_CONSOLE);

      lines.length = 0;
      await setupCommand(parseArgs(['setup']), out, {
        env,
        probe: async () => [],
        ask: async (q) => (q.startsWith('Gateway') ? 'https://gw.example' : ''),
      });
      expect(text(), 'a different gateway is not ours to send people to').not.toContain(
        ORCAROUTER_CONSOLE,
      );
    });

    it('is a default, not a redirect: an unconfigured run still goes to the provider', async () => {
      // The property that keeps this a recommendation. With nothing configured, recording proxies
      // the agent's own traffic to whatever it was already talking to — routing that through a
      // gateway the user never named would post their source code to a third party as a side
      // effect of pressing record, on a key that would not authenticate there anyway.
      const plan = await upstreamPlan(parseArgs(['record', 'claude']), env);
      expect(plan.upstream, 'no gateway configured means no upstream override').toBeUndefined();
      expect(plan.headers).toBeUndefined();
      expect(JSON.stringify(plan)).not.toContain('orcarouter');
    });
  });

  describe('the next-step line', () => {
    it('suggests models the gateway actually serves', async () => {
      // Model ids are gateway-specific — OrcaRouter namespaces them by provider, a direct provider
      // does not — so a hardcoded pair is a copyable line that fails against the gateway orca just
      // configured. It used to print `claude-opus-5,gpt-5.2` regardless.
      await setupCommand(
        parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'k']),
        out,
        {
          env,
          probe: async () => ['anthropic/claude-opus-5', 'openai/gpt-5.2', 'google/gemini-2.5-pro'],
          ask: async (q) => (q.startsWith('Models') ? '' : ''),
        },
      );
      // The ask above accepts the offered default, so a model list is stored and the line is short.
      expect(text()).toContain('orca compare last --verify');
    });

    it('names real ids when no default list was chosen', async () => {
      await setupCommand(
        parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'k']),
        out,
        { env, probe: async () => ['anthropic/claude-opus-5', 'openai/gpt-5.2'] },
      );
      const printed = text();
      expect(printed).toContain('--models anthropic/claude-opus-5,openai/gpt-5.2');
      expect(printed, 'never a model id nobody confirmed exists').not.toContain(
        '--models claude-opus-5,gpt-5.2',
      );
    });

    it('points at orca models when the gateway could not be reached', async () => {
      await setupCommand(
        parseArgs(['setup', '--gateway', 'https://gw.example', '--key', 'k']),
        out,
        {
          env,
          probe: async () => {
            throw new Error('ECONNREFUSED');
          },
        },
      );
      const printed = text();
      expect(printed).toContain('orca models');
      expect(printed, 'inventing ids for an unreachable gateway is worse than none').not.toMatch(
        /--models \S/,
      );
    });
  });

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

  it('configures the default gateway when it cannot ask and was told nothing', async () => {
    // This used to throw "no gateway to configure". With a default there is something to
    // configure, so the useful outcome is a written config and a key you can add afterwards —
    // not an error telling you to pass the flag whose value orca already knows.
    const config = await setupCommand(parseArgs(['setup']), out, { env, probe: async () => [] });

    expect(config.gateway?.url).toBe(ORCAROUTER_URL);
    expect(config.gateway?.api_key, 'a key is never invented').toBeUndefined();
    expect(config.gateway?.api_key_env).toBeUndefined();
    expect(text()).toContain('auth=none');
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

  it('withholds the gateway key when even one dialect is redirected', async () => {
    // The case the previous test missed, and the one that actually happens. Redirecting a single
    // dialect leaves the other still pointing at the gateway, so a `.some()` check passed and the
    // key was returned — and `upstreamHeaders` are applied to *every* live call, not per dialect,
    // so the gateway's credential went to api.anthropic.com. Verified against the built CLI before
    // this fix: upstream {anthropic: api.anthropic.com, openai: gw.example}, headers carrying the
    // key.
    //
    // Because the headers are global to the proxy, the only safe rule is unanimity: attach the key
    // when every origin we might reach is the gateway, and otherwise not at all.
    const env = { ...process.env, XDG_CONFIG_HOME: home };
    await writeConfig({ gateway: { url: 'https://gw.example', api_key: 'sk-gateway-key' } }, env);

    const plan = await upstreamPlan(
      parseArgs(['record', '--upstream-anthropic', 'https://api.anthropic.com']),
      env,
    );

    expect(plan.upstream?.anthropic).toBe('https://api.anthropic.com');
    expect(plan.upstream?.openai).toBe('https://gw.example');
    expect(plan.headers, 'a redirected dialect must disarm the key entirely').toBeUndefined();
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
