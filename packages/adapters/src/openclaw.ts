import {
  bunOptionsWithHook,
  nodeOptionsWithHook,
  writeFetchHook,
} from '@orcareplay/node-instrument';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { applyNamedBaseUrls, passThrough, proxyBase, readEnv } from './env.js';
import { detectAgent } from './detect.js';

/**
 * OpenClaw — a multi-channel gateway that runs coding agents on your behalf.
 *
 * It is a different shape from every other adapter here: OpenClaw does not do the coding, it
 * *launches* Claude Code, Codex or opencode as child processes and drives them from a chat app. So
 * there are two kinds of model traffic in one run, and both have to be caught.
 *
 * The gateway's own calls read no base-URL variable that its documentation names, so they are
 * caught the way the Vercel AI SDK is: the fetch hook, installed through `NODE_OPTIONS`.
 *
 * The coding agent's calls are caught by the ordinary variables — not because OpenClaw reads them,
 * but because a child process inherits its parent's environment, so the Claude Code that OpenClaw
 * spawns sees `ANTHROPIC_BASE_URL` exactly as it would if you had run it yourself. That is a
 * property of the OS, not of orca, and it is why this adapter sets variables the launched program
 * ignores.
 */
export const openClawAdapter: Adapter = {
  id: 'openclaw',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['openclaw'], ['.openclaw', '.config/openclaw']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const hookPath = await writeFetchHook(ctx.runDir);
    const env: Record<string, string> = {
      ORCA_PROXY_URL: ctx.proxyUrl,
      NODE_OPTIONS: nodeOptionsWithHook(hookPath, readEnv(ctx.env, 'NODE_OPTIONS')),
      BUN_OPTIONS: bunOptionsWithHook(hookPath, readEnv(ctx.env, 'BUN_OPTIONS')),
      // For the coding agents it spawns, which inherit this environment and do read them.
      ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl),
      OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
      OPENAI_API_BASE: proxyBase(ctx.proxyUrl, 'v1'),
    };
    passThrough(env, ctx.env, 'ORCA_INSTRUMENT_HOSTS');
    passThrough(env, ctx.env, 'ANTHROPIC_API_KEY');
    passThrough(env, ctx.env, 'OPENAI_API_KEY');
    applyNamedBaseUrls(env, ctx.env, ctx.proxyUrl);
    return { command: 'openclaw', args: [...ctx.userArgs], env, tempFiles: [hookPath] };
  },
};
