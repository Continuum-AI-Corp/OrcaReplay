import { basename, join } from 'node:path';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { forwardBasePath } from '@orcareplay/proxy';
import { resolveRealBinary } from '@orcareplay/shell-shim';
import { detectAgent, homeDirHas } from './detect.js';
import { openCodeConfiguredBaseURLs, stripJsonc } from './opencode-config.js';
import { writeOpenCodeCapturePlugin } from './opencode-capture.js';
import { passKey, passThrough, proxyBase, readEnv } from './env.js';

/**
 * Where OpenCode keeps the credentials `opencode auth login` writes.
 *
 * Both locations, because the data directory moved and an installation that predates the move
 * still has the old one. Finding either means the harness can authenticate on its own.
 */
const OPENCODE_AUTH_PATHS = ['.local/share/opencode/auth.json', '.config/opencode/auth.json'];

/** Whether OpenCode has credentials of its own, independent of the environment. */
export function opencodeHasOwnAuth(): boolean {
  return OPENCODE_AUTH_PATHS.some(homeDirHas);
}

/**
 * OpenCode's first-party providers, and the base URL the models.dev catalog gives each.
 *
 * OpenCode resolves its API origin per model, and only the OpenAI and Anthropic origins can be
 * named with an environment variable — so a run on one of these talked straight to its provider
 * while the proxy saw nothing, and the trace came out empty while the agent answered happily.
 * The existing config overlay points these two at the proxy carrying their own destination.
 * The final-fetch plugin independently covers the full catalog, including newly added providers
 * and model-specific API origins; this table is no longer the capture allowlist.
 */
const OPENCODE_FIRST_PARTY_BASE: Record<string, string> = {
  opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
};

/** The environment variable the run-local overlay rides in on. */
const CONFIG_CONTENT_VAR = 'OPENCODE_CONFIG_CONTENT';

/**
 * Shells whose real binary a shim can find again, from OpenCode's own acceptable set — the
 * POSIX shells it runs commands with, minus the ones it refuses outright.
 */
const SHIMMABLE_SHELLS = ['zsh', 'bash', 'sh', 'ksh', 'dash'] as const;

/**
 * The shell OpenCode falls back to when `SHELL` is unset or one it denies, which is what a
 * recorded run should resolve through the shim so that it behaves like the unrecorded one.
 */
function fallbackShells(): string[] {
  return process.platform === 'darwin' ? ['zsh', 'bash', 'sh'] : ['bash', 'sh'];
}

/**
 * Route OpenCode's shell tool through the shim, by pointing `SHELL` at one.
 *
 * OpenCode resolves its shell from this variable and then execs it *by absolute path*, so the
 * PATH shim in front of `bash` and `sh` never engaged: on macOS every command ran under
 * `/bin/zsh` and the frames file stayed empty while the trace showed shell tool calls. The shim
 * named after the real shell keeps every flag OpenCode passes (`-c`, and the login wrappers)
 * byte-identical — it is argv-transparent — so the run behaves the same and the shim sees it.
 *
 * The name is resolved before the run starts, because a shim whose real binary cannot be found
 * on PATH would answer every command 127 and break the run instead of under-recording it.
 * `installShellShim` writes one shim per name in its default set; a name that is not there
 * simply never gets picked, and the end-of-run `shell.ineffective` warning is what reports the
 * layer as unused.
 */
async function shellThroughShim(
  env: Record<string, string | undefined>,
  runDir: string,
): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  const shimDir = join(runDir, 'shims');
  const current = basename(readEnv(env, 'SHELL') ?? '').toLowerCase();
  const candidates = SHIMMABLE_SHELLS.includes(current as (typeof SHIMMABLE_SHELLS)[number])
    ? [current, ...fallbackShells()]
    : fallbackShells();
  for (const name of new Set(candidates)) {
    if ((await resolveRealBinary(name, env['PATH'] ?? '', shimDir)) !== undefined) {
      return join(shimDir, name);
    }
  }
  return undefined;
}

/**
 * The config overlay that rewrites OpenCode's per-provider origins through the proxy.
 *
 * `provider.<id>.options.baseURL` is the one lever OpenCode honours over its catalog's origin,
 * and `OPENCODE_CONFIG_CONTENT` is the config source merged last, so the overlay decides the
 * final URL without touching the user's files. Each base URL is rewritten to
 * `<proxy>/forward/<encoded base>`: the request arrives at the proxy naming where it was headed,
 * the proxy records the exchange and forwards to that base — so an OpenAI-compatible provider
 * whose origin is neither api.openai.com nor api.anthropic.com is captured, not bypassed.
 *
 * The user's own `options.baseURL` for the same provider is carried through rather than replaced.
 * A config that could not be parsed clears the whole overlay: an unreadable intent is not a
 * licence to reroute someone's provider. An existing `OPENCODE_CONFIG_CONTENT` keeps its fields
 * and provider routing; only the run-local capture plugin is appended.
 */
async function baseURLsThroughProxy(ctx: RecordContext): Promise<Record<string, string>> {
  const theirs = readEnv(ctx.env, CONFIG_CONTENT_VAR);
  if (theirs !== undefined) return withCapturePlugin(ctx, theirs);
  const scan = await openCodeConfiguredBaseURLs(ctx.env, ctx.cwd);
  if (!scan.trusted) return {};
  const provider: Record<string, { options: { baseURL: string } }> = {};
  for (const [id, catalogBase] of Object.entries(OPENCODE_FIRST_PARTY_BASE)) {
    const base = scan.overrides.get(id) ?? catalogBase;
    provider[id] = { options: { baseURL: `${proxyBase(ctx.proxyUrl)}${forwardBasePath(base)}` } };
  }
  return withCapturePlugin(ctx, JSON.stringify({ provider }));
}

async function withCapturePlugin(
  ctx: RecordContext,
  content: string,
): Promise<Record<string, string>> {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(stripJsonc(content));
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('not an object');
    if (config.plugin !== undefined && !Array.isArray(config.plugin))
      throw new Error('not a plugin list');
  } catch {
    // Leave invalid config for OpenCode to diagnose without discarding the user's settings.
    return { [CONFIG_CONTENT_VAR]: content };
  }
  const plugin = await writeOpenCodeCapturePlugin(ctx.runDir, proxyBase(ctx.proxyUrl));
  config.plugin = [...((config.plugin as unknown[] | undefined) ?? []), plugin];
  return { [CONFIG_CONTENT_VAR]: JSON.stringify(config) };
}

/**
 * Base URL overrides retain the existing SDK routing. The run-local plugin captures final fetches
 * to catalog APIs and ChatGPT OAuth's rewritten URL, retaining each actual destination.
 * NODE_OPTIONS/BUN_OPTIONS preloads do not run in OpenCode's compiled executable.
 */
export const openCodeAdapter: Adapter = {
  id: 'opencode',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['opencode'], ['.config/opencode', '.opencode']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const env: Record<string, string> = {
      OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
      // OpenCode's AI SDK appends /messages, unlike Claude Code's /v1/messages.
      ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
    };
    // Which credentials OpenCode can see is part of how it chooses a provider, so handing it a
    // placeholder for the provider the user has *not* configured can change which model the run
    // calls — a recorded run that answers differently from the same command uninstrumented is the
    // worst kind of capture bug. With no credential at all there is no choice to flip, and a
    // client that refuses to start without a key helps nobody, so placeholders stand in.
    //
    // Unless OpenCode has signed in on its own. `opencode auth login` writes a credential file the
    // environment knows nothing about, and inventing both variables in front of it is the failure
    // Claude Code showed plainly: the harness prefers the environment, authenticates with a key
    // that is not real, and the run dies before it starts. There is no provider choice to protect
    // there either — the credential file already made it.
    const hasAny =
      readEnv(ctx.env, 'OPENAI_API_KEY') !== undefined ||
      readEnv(ctx.env, 'ANTHROPIC_API_KEY') !== undefined;
    if (hasAny || opencodeHasOwnAuth()) {
      passThrough(env, ctx.env, 'OPENAI_API_KEY');
      passThrough(env, ctx.env, 'ANTHROPIC_API_KEY');
    } else {
      passKey(env, ctx.env, 'OPENAI_API_KEY');
      passKey(env, ctx.env, 'ANTHROPIC_API_KEY');
    }
    Object.assign(env, await baseURLsThroughProxy(ctx));

    // `SHELL` overrides the user's own only to a shim standing in for a shell OpenCode would have
    // picked anyway. With `--no-shell` there is no shim directory, OpenCode's own resolution
    // finds nothing there and falls back exactly as it would unrecorded — so the wrong variable
    // costs nothing, and the right one is what makes the frames file non-empty.
    const shell = await shellThroughShim(ctx.env, ctx.runDir);
    if (shell !== undefined) env['SHELL'] = shell;

    return { command: 'opencode', args: [...ctx.userArgs], env };
  },
};
