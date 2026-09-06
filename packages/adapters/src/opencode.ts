import { basename, join } from 'node:path';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { forwardBasePath } from '@orcareplay/proxy';
import { resolveRealBinary } from '@orcareplay/shell-shim';
import { detectAgent, homeDirHas } from './detect.js';
import { openCodeConfiguredBaseURLs } from './opencode-config.js';
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
 * A config overlay (see `prepare`) points each at the proxy carrying its own destination, which
 * is one mechanism for both and for any later first-party provider, at the cost of this table
 * going stale: a provider added after it was written keeps bypassing capture the way it did
 * before, which the end-of-run `capture.empty` warning is what says out loud.
 */
const OPENCODE_FIRST_PARTY_BASE: Record<string, string> = {
  opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
};

/** The environment variable the overlay rides in on, and the one it must never clobber. */
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
 * licence to reroute someone's provider. And an `OPENCODE_CONFIG_CONTENT` the user already set is
 * relayed untouched — there is no way to merge two sources of one variable, and clobbering theirs
 * to add capture would change more than the capture.
 */
async function baseURLsThroughProxy(ctx: RecordContext): Promise<Record<string, string>> {
  // There is no way to merge two sources of one variable, and clobbering theirs to add capture
  // would change more than the capture — so it is relayed exactly as it arrived.
  const theirs = readEnv(ctx.env, CONFIG_CONTENT_VAR);
  if (theirs !== undefined) return { [CONFIG_CONTENT_VAR]: theirs };
  const scan = await openCodeConfiguredBaseURLs(ctx.env, ctx.cwd);
  if (!scan.trusted) return {};
  const provider: Record<string, { options: { baseURL: string } }> = {};
  for (const [id, catalogBase] of Object.entries(OPENCODE_FIRST_PARTY_BASE)) {
    const base = scan.overrides.get(id) ?? catalogBase;
    provider[id] = { options: { baseURL: `${proxyBase(ctx.proxyUrl)}${forwardBasePath(base)}` } };
  }
  return { [CONFIG_CONTENT_VAR]: JSON.stringify({ provider }) };
}

/**
 * OpenCode picks its provider per model, so both origins are redirected: whichever protocol the
 * chosen model speaks, the traffic lands on the proxy. Providers whose origin is neither of the
 * two — OpenCode's own first-party ones, most visibly — are redirected by the config overlay
 * below, because no environment variable can name their origin for them.
 */
export const openCodeAdapter: Adapter = {
  id: 'opencode',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['opencode'], ['.config/opencode', '.opencode']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const env: Record<string, string> = {
      OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
      ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl),
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
