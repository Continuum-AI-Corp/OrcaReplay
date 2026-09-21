import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Redactor } from '@orcareplay/core';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { decodeForwardPath, forwardBasePath } from '@orcareplay/proxy';
import { detectAgent } from './detect.js';
import { forwardOrProxyBase, PLACEHOLDER_KEY, readEnv } from './env.js';

/**
 * ZCode — Z.ai's coding agent, captured by handing it a provider file of orca's own.
 *
 * The second adapter to take the config route. ZCode's provider file is JSON, where MiniMax Code's
 * is YAML that this project rewrote as text — a decision that cost eight rounds of review, every
 * one of them a spelling the rewrite had not anticipated: a flow map, a list item, a block scalar,
 * a value on the next line, a quoted name, a value that was only a comment. `JSON.parse` returns a
 * tree and `redirectedConfig` walks every node of it, so none of those shapes exist here.
 *
 * That settles *structure*, and an earlier draft of this comment claimed it settled more: that
 * "did I reach every key" stops being a question. It does not. Parsing tells this file where the
 * values are; it says nothing about which of them are secret. Review found the gap — `isSecret`
 * knew `apiKey` and `api_key` and did not know `APIKEY`, `Authorization` or `jwt`, and `isOrigin`
 * knew `baseUrl` and did not know `endpoint` — so a credential filed under a name this file had
 * not thought of was copied into the run directory verbatim, which is what §7 exists to stop.
 *
 * So the same two-part shape MiniMax Code arrived at applies here too, and for the same reason.
 * The rewrite is an allowlist, because it has to produce correct output. The net under it is not,
 * because every shape a net cannot parse is a value it never looks at: `accountedFor` walks the
 * *result* and judges values by what they look like rather than by what they are called.
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
 * warning is what says so. The sweep below blanks that variable rather than pointing it anywhere,
 * which leaves ZCode reading its own bundled file and booting — measured, a full capture — and
 * takes away an operator's custom built-in file as a second route out.
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
      env: isolatedEnv(ctx.env, config),
      tempFiles: [config],
    };
  },
};

/**
 * ZCode's whole environment namespace, blanked, then the provider file put back.
 *
 * The child runs on `{ ...process.env, ...launch.env }`, so an overlay that sets one variable
 * leaves every other one the operator had. Review found what that costs: `ZCODE_BASE_URL` is an
 * origin, and an operator who had set it kept it — the redirected config bought nothing, because
 * the harness had a second route to a real host that the proxy is not in a position to block. A
 * replay on such a machine calls out for real, spends the operator's quota, and reports success
 * because nothing reached the proxy.
 *
 * Naming the live variables one at a time is not something this file can do honestly. ZCode's
 * bundle names two hundred `ZCODE_*` variables and reads them through a table of minified
 * constants (`Hee="ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"`, read as `process.env[Hee]`), so grepping
 * for `process.env.ZCODE_BASE_URL` finds one hit and proves nothing about the other hundred and
 * ninety-nine. Among the names are four more origins (`ZCODE_ENDPOINT_ORIGIN`,
 * `ZCODE_PRODUCTION_BASE_URL`, `ZCODE_TEST_BASE_URL`, `ZCODE_DEPS_BASE_URL`), three credentials
 * (`ZCODE_CREDENTIAL_SECRET`, `ZCODE_OFFICIAL_MCP_AUTH_PROVIDER_JWT_TOKEN`,
 * `ZCODE_CUA_PERMISSION_BROKER_TOKEN`), three data directories and two proxies. The sweep covers
 * all of them, and covers the ones a later version adds.
 *
 * The overlay can only set, not unset, so they arrive empty rather than absent. That is the
 * difference between a run that cannot reach a real origin and one that quietly can.
 */
function isolatedEnv(
  env: Record<string, string | undefined>,
  configPath: string,
): Record<string, string> {
  const overlay: Record<string, string> = {};
  for (const name of Object.keys(env)) if (VENDOR_ENV.test(name)) overlay[name] = '';
  // Borrowed from the wider ecosystem rather than ZCode's own namespace, and named one at a time
  // because a `OPENAI_`/`ANTHROPIC_` prefix sweep would reach well past this harness. These four
  // are the ones ZCode's bundle names.
  for (const name of BORROWED_ENV) if (env[name] !== undefined) overlay[name] = '';
  // Last, so the sweep above cannot blank the one variable this adapter depends on.
  overlay['ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'] = configPath;
  return overlay;
}

/** Every namespace ZCode's own bundle reads from: its own, Z.ai's, BigModel's, GLM's. */
const VENDOR_ENV = /^(?:ZCODE|ZAI|Z_AI|BIGMODEL|GLM)_/i;

const BORROWED_ENV = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
];

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
 * The walk is over the parsed tree, so it reaches a value wherever it is nested and does not care
 * how the file was formatted. Origins are recognised by their *value* — anything that reads as an
 * `http://` or `https://` URL — rather than by the name it is filed under, because review found
 * `isOrigin` matching `baseUrl` and missing `endpoint`, `host`, `url` and `server`, each of which
 * would have left a provider talking to its real host while this function still reported success.
 *
 * Secrets are still matched by name, because a rewrite has to know which value to replace. That
 * is an allowlist and it will be incomplete; `accountedFor` is the net under it.
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
      } else if (typeof value === 'string' && isOrigin(value)) {
        if (!carries(value)) carried = false;
        out[key] = forwardOrProxyBase(proxyUrl, value);
      } else {
        out[key] = walk(value);
      }
    }
    return out;
  };
  const moved = walk(parsed);
  if (!carried) return undefined;
  const rewritten = `${JSON.stringify(moved, null, 2)}\n`;
  return accountedFor(rewritten, proxyUrl) ? rewritten : undefined;
}

/**
 * Whether every value in the rewritten config is one this file can account for.
 *
 * The net under the rewrite, and deliberately not built the way the rewrite is. The rewrite
 * understands a set of names and replaces what it finds under them, which is right for something
 * that has to produce correct output. A net built that way has the failure the other way round:
 * every name it does not know is a value it never looks at. So this one reads values.
 *
 * Three questions, because each of the first two has a measured hole:
 *
 * 1. Orca's own redactor, asked whether anything still looks like a secret. It catches an `sk-`
 *    token, a real JWT, a forty-character random string and an AWS key id, and changes nothing in
 *    a rewritten config, forwarded URLs included. It does not catch thirty-two hex characters:
 *    that string's maximum Shannon entropy is exactly the threshold, so a hex key never trips it.
 * 2. Shape rather than entropy: a value carrying one opaque run of twenty-four or more token
 *    characters is something this file cannot account for. See `OPAQUE_TOKEN` for the alphabet,
 *    which is narrower than MiniMax Code's and had to be.
 * 3. An origin the rewrite did not move. After the walk above, every `http`-shaped value should
 *    point at the proxy; one that does not means the rewrite passed over it, which is the
 *    "partial redirect with nothing in the trace to say so" this adapter exists to prevent.
 *
 * What survives all three is a short low-entropy value under a name the rewrite does not know —
 * `"auth": "hunter2"`. These narrow the hole; they do not close it. Refusing costs an uncaptured
 * custom provider, which is the side to fail on when the alternative is writing a credential down.
 */
function accountedFor(rewritten: string, proxyUrl: string): boolean {
  if (new Redactor().redactString(rewritten).value !== rewritten) return false;

  // A proxy URL this cannot parse leaves nothing to compare against, and `undefined === undefined`
  // would then wave every origin through. Refuse instead.
  const base = originOf(proxyUrl);
  if (base === undefined) return false;
  let ok = true;
  const inspect = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(inspect);
      return;
    }
    if (node !== null && typeof node === 'object') {
      Object.values(node as Record<string, unknown>).forEach(inspect);
      return;
    }
    if (typeof node !== 'string') return;
    if (node === PLACEHOLDER_KEY) return;
    // Origins are judged by their parsed origin, not by a prefix. `startsWith(proxyUrl)` was the
    // first version of this line, and `http://127.0.0.1:44100.evil.example` starts with
    // `http://127.0.0.1:44100` — so the one check standing between a real host and the trace was
    // a substring match that a hostname can walk straight through.
    if (isOrigin(node)) {
      if (originOf(node) !== base) ok = false;
      return;
    }
    if (OPAQUE_TOKEN.test(node)) ok = false;
  };
  inspect(JSON.parse(rewritten));
  return ok;
}

/**
 * One opaque run of token characters, long enough that nothing in a real config is one.
 *
 * Neither `-`, `_` nor `/` is in the alphabet, and all three exclusions were paid for. MiniMax
 * Code's version of this allows `-` and `_`, and measured clean against a real MiniMax config;
 * pointed at ZCode's own shipped `provider.example.json` it refuses the file, because
 * `"type": "zhipu-coding-plan-api-key"` is twenty-five characters of exactly those. That is an
 * enum value, and refusing it would mean no ZCode config with a coding-plan provider is ever
 * carried. `/` is out for the reason MiniMax Code's comment gives — a provider-qualified model id
 * is full of it — and, measured here, because a Windows path in a config is one unbroken run of
 * it otherwise.
 *
 * What separates a credential from all three is that a credential has no word structure: it is a
 * single run, where an enum, a model id and a path are short segments with separators between
 * them. So the alphabet is the run, and the separators end it.
 *
 * The cost is a credential written with a separator inside every twenty-four characters, which
 * the redactor above is the net for: it is the one that knows `sk-`, a JWT and an AWS key id.
 */
const OPAQUE_TOKEN = /[A-Za-z0-9+=]{24,}/;

const SECRET_WORD = 'key|token|secret|password|credential|auth|authorization|cookie|jwt|bearer';
const SECRET_TITLE = 'Key|Token|Secret|Password|Credential|Auth|Authorization|Cookie|Jwt|Bearer';
const SECRET_UPPER = SECRET_TITLE.toUpperCase();

/**
 * The same words minus the two that mean something else on their own.
 *
 * `key` is as often a map entry or an asset name as it is a credential — ZCode's own shipped
 * example config has `logo: { "key": "zai" }`, and replacing that writes `orca-recorded` into a
 * field naming an image. `auth` is as often a mode as a token. Measured on that file: the first
 * version of this list corrupted it.
 *
 * Under a separator or a prefix — `api_key`, `apiKey`, `authToken` — both are unambiguous and stay
 * in. On their own they are left to `accountedFor`, which judges a value by what it looks like
 * rather than by what it is called, and refuses the file if it cannot account for one. That is the
 * division of labour this file is supposed to have: the rewrite may only touch what it is sure of,
 * because a rewrite that guesses wrong does not refuse, it corrupts.
 */
const BARE_WORD = 'token|secret|password|credential|authorization|cookie|jwt|bearer';

/**
 * Any name a credential is kept under, rather than the handful this file happens to have seen.
 *
 * Four boundaries, because a config uses four conventions and the first version of this knew two.
 * `token` on its own and `api_key` with a separator it had. `APIKey` and `APIKEY` it did not: the
 * camel-case branch required a *lowercase* letter before `Key`, so a name that spelled its prefix
 * in capitals walked straight through — and `APIKEY` is a spelling MiniMax Code's own test list
 * says must be stripped.
 *
 * Case matters in the last two branches and is not a detail. Matching `key$` case-insensitively
 * after any letter, which is the obvious widening, also matches `monkey` — and a rewrite with a
 * false positive does not refuse, it corrupts. So a capital or a digit may precede a Titlecase or
 * an ALLCAPS word, and a lowercase letter may precede a Titlecase one, and an all-lowercase `key`
 * after a letter stays what it is: the end of a longer word.
 *
 * Still incomplete by construction — `accessKeyId` ends in neither — which is why the value-shaped
 * net in `accountedFor` is the thing being relied on, and this is only the first pass.
 */
function isSecret(key: string): boolean {
  return (
    new RegExp(`^(?:${BARE_WORD})s?$`, 'i').test(key) ||
    new RegExp(`[-_](?:${SECRET_WORD})s?$`, 'i').test(key) ||
    new RegExp(`[A-Za-z0-9](?:${SECRET_TITLE})s?$`).test(key) ||
    new RegExp(`[A-Z0-9](?:${SECRET_UPPER})S?$`).test(key)
  );
}

/**
 * An origin, recognised by the value rather than by the name it is filed under.
 *
 * `isOrigin` used to read key names — `baseUrl`, `apiUrl`, `endpointUrl` — and review pointed out
 * what that misses: `endpoint`, `host`, `url`, `server`, and whatever a later ZCode calls it. A
 * name list is the wrong tool for the question, because the thing that makes a value dangerous is
 * that the harness can dial it, and that is visible in the value.
 *
 * The cost is that a URL nobody dials — a link to the console where a human mints a key — is
 * forwarded too. It is a link in a copy of a config that exists for the length of one run, so
 * being routed through a proxy that is about to disappear costs it nothing.
 */
function isOrigin(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Scheme, host and port, or `undefined` for a string that only looks like a URL. */
function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
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
