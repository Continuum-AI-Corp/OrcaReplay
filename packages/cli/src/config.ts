import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedArgs } from './args.js';

/**
 * User-level configuration, which exists for exactly one job: let
 * `orca compare --models a,b,c` reach several models without re-typing a gateway URL and a key on
 * every invocation.
 *
 * That means this file holds a credential, and everything here follows from it. The file is
 * `0600` inside a `0700` directory, the key can live in an environment variable instead of on
 * disk, and nothing ever prints it back. The key itself never enters a trace either — the proxy
 * adds it to the outbound request only, while what gets recorded is derived from the *incoming*
 * request with auth stripped, so a gateway key orca injects is invisible to the recording by
 * construction rather than by a rule someone has to remember.
 */
/**
 * OrcaRouter, the gateway orca suggests when you do not name one.
 *
 * A default, never a redirect. It fills in the blank when you ask for a gateway — `orca setup` with
 * no `--gateway` — and nothing more: a run with no gateway configured still proxies the agent's own
 * traffic straight to the provider the agent was already talking to, on the agent's own key. Sending
 * that somewhere the user never named would mean posting their source code to a third party as a
 * side effect of pressing record, and their existing provider key would not authenticate there
 * anyway. Naming a default is a recommendation; rerouting unconfigured traffic would be a decision
 * taken on someone's behalf.
 *
 * The **origin**, deliberately without the `/v1` an OpenAI SDK wants. That SDK is configured with
 * `base_url=https://api.orcarouter.ai/v1` because it appends only `/chat/completions`; orca appends
 * the whole dialect path (`/v1/messages` or `/v1/chat/completions`) and probes `/v1/models`, so a
 * `/v1` here would produce `/v1/v1/chat/completions`. Confirmed against the maintainers' own
 * published action, whose `orcarouter-url` input defaults to
 * `https://api.orcarouter.ai/v1/chat/completions`.
 *
 * Model ids there are namespaced by provider — `anthropic/claude-sonnet-4.6`,
 * `openai/gpt-4o-mini`. Both places that read a model id already cope: dialect selection matches
 * `(?:.*\/)?claude[-.]`, and `resolveModelId` strips the namespace before pricing.
 */
export const ORCAROUTER_URL = 'https://api.orcarouter.ai';

/** Where a person gets a key for the default gateway. Printed, never fetched. */
export const ORCAROUTER_CONSOLE = 'https://www.orcarouter.ai/console/token';

export interface GatewayConfig {
  /** Origin that serves the model APIs. One gateway usually serves both wire formats. */
  url: string;
  /** Stored key. Prefer `api_key_env` if you would rather not keep a credential on disk. */
  api_key?: string;
  /** Name of an environment variable to read the key from at call time. */
  api_key_env?: string;
  /**
   * Where `url` came from: a destination the user NAMED, or `orca setup`'s own default.
   *
   * Model traffic does not care — proxying a call your agent was already making through
   * OrcaRouter is the default `orca setup` exists to offer. A RUN does care: it holds source,
   * shell output and workspace snapshots, and README's "Never a default destination" promises that
   * push has no host of its own. Without this field the two are indistinguishable in the file, so
   * `orca setup` followed by `orca push last` sent the whole recording to a host the user never
   * typed.
   *
   * Absent in configs written before this field existed — see `namedPushDestination`, which
   * resolves that case rather than guessing here.
   */
  url_source?: 'named' | 'default';
}

export interface OrcaConfig {
  gateway?: GatewayConfig;
  /** Default model list for `orca compare` when `--models` is not given. */
  models?: string[];
}

/** XDG, with the documented fallback. Honours `XDG_CONFIG_HOME` so tests need no real home. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config');
  return join(base, 'orca', 'config.json');
}

/**
 * Read the config, or an empty one.
 *
 * Never throws. A hand-edited file with a stray comma should cost you the gateway setting, not
 * every orca command — and a tool people reach for when something is already broken is the worst
 * possible thing to have its own unrecoverable failure mode.
 */
export async function readConfig(env: NodeJS.ProcessEnv = process.env): Promise<OrcaConfig> {
  try {
    const raw = await readFile(configPath(env), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as OrcaConfig) : {};
  } catch {
    return {};
  }
}

export async function writeConfig(
  config: OrcaConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Set explicitly as well as passed to mkdir: an existing directory keeps whatever mode it had,
  // and a 0755 directory makes the file's 0600 decoration.
  await chmod(dirname(path), 0o700).catch(() => {});
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/**
 * The auth header for the configured gateway, or nothing.
 *
 * Returns `{}` rather than an empty bearer when no key is available. An `Authorization: Bearer `
 * with nothing after it is worse than sending none: a gateway may accept it as an anonymous
 * session, and the user never learns their key was not applied.
 */
export function gatewayHeaders(
  config: OrcaConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const gateway = config.gateway;
  if (!gateway) return {};
  const key = gateway.api_key ?? (gateway.api_key_env ? env[gateway.api_key_env] : undefined) ?? '';
  if (key === '') return {};
  // Both header names, because a gateway fronting both wire formats reads whichever its callers
  // send — and sending an extra header costs nothing while guessing wrong costs a confusing 401.
  return { authorization: `Bearer ${key}`, 'x-api-key': key };
}

/**
 * Two URLs that name the same host, for deciding whether a stored credential may travel.
 *
 * Lives here rather than beside either caller because both callers are credential gates —
 * `upstreamPlan` for model traffic and `resolveGateway` for push/pull — and two comparators that
 * drift apart mean one of them starts leaking. Falls back to a trimmed string compare when either
 * side does not parse, which errs towards withholding: an unparseable URL matches only itself.
 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  }
}

/**
 * Where live model calls go: flag, then environment, then the configured gateway.
 *
 * Needed by record *and* by replay — `--loose` and any fork continue live, and a fork that ignored
 * the override would quietly talk to the real provider instead of the gateway the user pointed it
 * at. Same precedence, whichever command is running: the more specific and more recent the
 * instruction, the more it wins.
 */
export async function resolveUpstream(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string> | undefined> {
  const config = await readConfig(env);
  const gateway = config.gateway?.url;
  const out: Record<string, string> = {};
  const anthropic = args.str('upstream-anthropic') ?? env.ORCA_UPSTREAM_ANTHROPIC ?? gateway;
  const openai = args.str('upstream-openai') ?? env.ORCA_UPSTREAM_OPENAI ?? gateway;
  if (anthropic) out.anthropic = anthropic;
  if (openai) {
    out.openai = openai;
    // The proxy resolves an origin by dialect id, and chat completions and the Responses API are
    // two dialects sharing one provider — so a map holding only `openai` sends every Codex and
    // Agents-SDK call straight past a gateway the user configured, on their own key, silently.
    // `--upstream-openai` names a provider, not a wire format.
    out['openai-responses'] = openai;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The configured gateway, but ONLY when it is a destination the user named.
 *
 * The single funnel for "may a run go here by default". Sync reads this instead of
 * `config.gateway?.url`, so the README's promise ("push has no default host") is one function
 * rather than a rule each command has to remember.
 *
 * Three cases:
 *
 *   - `url_source: 'named'`   -> the user typed it, at `--gateway` or at setup's prompt. Yes.
 *   - `url_source: 'default'` -> setup filled it in. No.
 *   - absent (an older config) -> decided by the URL. Setup writes ORCAROUTER_URL and nothing
 *     else without being told, so any OTHER origin can only have been named; ORCAROUTER_URL
 *     itself is genuinely ambiguous and answers no. That refuses one case it need not — a user
 *     who deliberately typed OrcaRouter before this field existed — and the cost is one
 *     `--gateway` flag or one re-run of `orca setup --gateway`, against sending a recording of
 *     someone's source to a host they never named.
 */
export function namedPushDestination(config: OrcaConfig): string | undefined {
  const url = config.gateway?.url;
  if (!url) return undefined;
  const source = config.gateway?.url_source;
  if (source === 'named') return url;
  if (source === 'default') return undefined;
  return sameOrigin(url, ORCAROUTER_URL) ? undefined : url;
}
