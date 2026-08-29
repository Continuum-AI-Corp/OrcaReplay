import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent } from './detect.js';
import { passKey, proxyBase } from './env.js';

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
    passKey(env, ctx.env, 'OPENAI_API_KEY');
    passKey(env, ctx.env, 'ANTHROPIC_API_KEY');
    return { command: 'opencode', args: [...ctx.userArgs], env };
  },
};
