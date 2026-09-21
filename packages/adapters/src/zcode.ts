import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { decodeForwardPath, forwardBasePath } from '@orcareplay/proxy';
import { detectAgent } from './detect.js';
import { forwardOrProxyBase, PLACEHOLDER_KEY, readEnv } from './env.js';

/**
 * ZCode — Z.ai's coding agent, captured by handing it a provider file of orca's own.
 *
 * The second adapter to take the config route, and much the easier of the two, because ZCode's
 * provider file is JSON. MiniMax Code's is YAML, which this project rewrote as text — a decision
 * that cost eight rounds of review, every one of them a spelling the rewrite had not anticipated:
 * a flow map, a list item, a block scalar, a value on the next line, a quoted name, a value that
 * was only a comment. None of that exists here. `JSON.parse` returns a tree, `redirected` walks
 * every node of it, and "did I reach every key" stops being a question anyone has to argue about.
 *
 * `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` names the file, which is a better lever than MiniMax
 * Code's relocatable data directory: one variable, one file, and the operator's own
 * `~/.zcode/v2/provider_config.json` is never touched.
 *
 * It is always set, even when there is nothing to carry into it. That is what keeps `orca replay`
 * honest: replay calls this same `prepare` with the operator's current environment, and an
 * adapter that redirected nothing would let a replay run live on their real providers, spend
 * money, and still report success because nothing reached the proxy.
 *
 * What this does not reach is ZCode's built-in providers — the eight account-backed entries for
 * z.ai and BigModel, carried in a separate file the app ships. `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`
 * can replace that file, but not with nothing: handed an empty one, ZCode refuses to start at all
 * (`Bundled 与 Active ZCode Built-in Release 均不可用`), measured. Redirecting them would mean
 * locating and rewriting the shipped file, which is install-specific. So a run on an account
 * provider is not captured, the same limit MiniMax Code has for its built-ins, and the end-of-run
 * warning is what says so.
 */
export const zcodeAdapter: Adapter = {
  id: 'zcode',
  aliases: ['zcode-cli'],
  harnessVersions: '>=3.14.1',

  // Redirected through a file, not a variable. See the `capture` field on `Adapter`.
  capture: 'config',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['zcode'], ['.zcode']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const dir = join(ctx.runDir, 'zcode-config');
    await mkdir(dir, { recursive: true });
    const config = join(dir, 'provider_config.json');

    const source = await readFile(providerConfigPath(ctx.env), 'utf8').catch(() => undefined);
    const carried = source === undefined ? undefined : redirectedConfig(source, ctx.proxyUrl);

    // A config orca could not read, could not parse, or could not redirect completely becomes the
    // bare one below rather than the operator's. Writing a partial redirect would leave whichever
    // provider it missed talking to its real host, with nothing in the trace to say so.
    await writeFile(config, carried ?? onlyOrca(ctx.proxyUrl), 'utf8');

    return {
      command: 'zcode',
      args: [...ctx.userArgs],
      env: { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: config },
      tempFiles: [config],
    };
  },
};

/** The file ZCode reads, which the operator may already have pointed elsewhere. */
function providerConfigPath(env: Record<string, string | undefined>): string {
  return (
    readEnv(env, 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE') ??
    join(homedir(), '.zcode', 'v2', 'provider_config.json')
  );
}

/**
 * The config with every origin moved to the proxy and every key taken out, or nothing.
 *
 * `undefined` rather than a partial rewrite, for anything this cannot account for: a file that is
 * not JSON, or an origin `/forward/` will not carry. The caller then writes its own file, so the
 * run is captured against a provider orca controls instead of half-redirected against theirs.
 *
 * The walk is over the parsed tree, so it reaches a `baseUrl` wherever it is nested and does not
 * care how the file was formatted. Keys are matched by name at any depth for the same reason:
 * `apiKey`, `api_key`, `token`, `secret` and anything else ending in `key` or `token` becomes the
 * placeholder, because the file lands in the run directory and §7 says a credential is never
 * written there.
 */
export function redirectedConfig(source: string, proxyUrl: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  let carried = true;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (isSecret(key) && typeof value === 'string') {
        out[key] = value === '' ? value : PLACEHOLDER_KEY;
      } else if (isOrigin(key) && typeof value === 'string' && value !== '') {
        if (!carries(value)) carried = false;
        out[key] = forwardOrProxyBase(proxyUrl, value);
      } else {
        out[key] = walk(value);
      }
    }
    return out;
  };
  const moved = walk(parsed);
  return carried ? `${JSON.stringify(moved, null, 2)}\n` : undefined;
}

const SECRET_WORD = 'key|token|secret|password|credential';

/**
 * Any name a credential is kept under, rather than the two this file happens to have seen.
 *
 * Three boundaries, because a config uses three conventions and the first version of this only
 * knew two: `token` on its own, `api_key` and `api-key` with a separator, and `apiKey` with none
 * at all. The camel case one is matched case-sensitively on purpose — a lowercase `key` after a
 * letter is the end of `monkey`, not a field.
 */
function isSecret(key: string): boolean {
  return (
    new RegExp(`^(?:${SECRET_WORD})s?$`, 'i').test(key) ||
    new RegExp(`[-_](?:${SECRET_WORD})s?$`, 'i').test(key) ||
    /[a-z0-9](?:Key|Token|Secret|Password|Credential)s?$/.test(key)
  );
}

/** `baseUrl`, and the spellings a later version might use for it. */
function isOrigin(key: string): boolean {
  return /^base[-_]?url$/i.test(key) || /^(api|endpoint)[-_]?(url|origin)$/i.test(key);
}

/**
 * Whether `/forward/` can carry this origin, asked of the decoder rather than restated here.
 *
 * `forwardOrProxyBase` answers an origin the decoder will not take with orca's own default
 * upstream, which would send the run to a host the operator never named. A config carrying one of
 * those — userinfo, a query, a scheme that is not HTTP — is a config this adapter leaves alone.
 */
function carries(origin: string): boolean {
  return decodeForwardPath(forwardBasePath(origin)) !== undefined;
}

/**
 * One provider, pointed at the proxy, with no key.
 *
 * What a run gets when there is no config to carry or the carry could not be completed. The model
 * id is deliberately generic: ZCode resolves it against this provider alone, and a run that wants
 * a particular model passes `--model`.
 */
function onlyOrca(proxyUrl: string): string {
  // A real catalogue id, not a label orca made up. ZCode builds the model from its catalogue,
  // so an invented id ends the run at `Model creation failed` before a request exists — measured.
  // Which model it is barely matters here: the id travels in the request and the prompt travels
  // with it, and `--model` overrides this for a run that wants another.
  const model = 'glm-4.6';
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: 'orca',
              templateId: null,
              providerName: 'orca',
              enabled: true,
              config: {
                group: 'standard-personal',
                logo: null,
                access: { type: 'api-key', apiKey: PLACEHOLDER_KEY },
                api: {
                  type: 'openai-chat-completions',
                  baseUrl: `${proxyUrl.replace(/\/+$/, '')}/v1`,
                  headers: {},
                },
                personalModelIds: [model],
                modelOrder: [model],
                visibility: 'visible',
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [{ providerId: 'orca', modelId: model, config: { enabled: true } }],
          manualProviderModelRules: [],
        },
        providerOrder: ['orca'],
        defaultModelSelection: { providerId: 'orca', modelId: model },
      },
    },
    null,
    2,
  )}\n`;
}
