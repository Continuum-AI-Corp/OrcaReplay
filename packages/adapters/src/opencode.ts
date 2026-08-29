import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent } from './detect.js';
import { passKey, passThrough, proxyBase, readEnv } from './env.js';

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
    const hasAny =
      readEnv(ctx.env, 'OPENAI_API_KEY') !== undefined ||
      readEnv(ctx.env, 'ANTHROPIC_API_KEY') !== undefined;
    if (hasAny) {
      passThrough(env, ctx.env, 'OPENAI_API_KEY');
      passThrough(env, ctx.env, 'ANTHROPIC_API_KEY');
    } else {
      passKey(env, ctx.env, 'OPENAI_API_KEY');
      passKey(env, ctx.env, 'ANTHROPIC_API_KEY');
    }
    return { command: 'opencode', args: [...ctx.userArgs], env };
  },
};
