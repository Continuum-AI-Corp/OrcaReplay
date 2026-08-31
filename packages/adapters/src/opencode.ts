import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent, homeDirHas } from './detect.js';
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
 * OpenCode picks its provider per model, so both origins are redirected: whichever protocol the
 * chosen model speaks, the traffic lands on the proxy.
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
    return { command: 'opencode', args: [...ctx.userArgs], env };
  },
};
