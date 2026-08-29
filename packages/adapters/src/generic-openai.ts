import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { passKey, passThrough, proxyBase } from './env.js';

/**
 * The escape hatch for any agent nobody has written an adapter for: the user supplies the command,
 * and every base-url variable in common use is redirected at once. `detect` is always false — an
 * adapter that cannot know what it is launching must never be chosen automatically.
 */
export const genericOpenAiAdapter: Adapter = {
  id: 'generic-openai',

  async detect(_cwd: string): Promise<boolean> {
    return false;
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const [command, ...args] = ctx.userArgs;
    if (command === undefined || command === '') {
      throw new Error(
        'generic-openai needs the command to run: orca record generic-openai -- <command> [args...]',
      );
    }
    const env: Record<string, string> = {
      OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
      // Pre-1.0 OpenAI SDKs and many ports read OPENAI_API_BASE instead.
      OPENAI_API_BASE: proxyBase(ctx.proxyUrl, 'v1'),
      ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl),
    };
    passKey(env, ctx.env, 'OPENAI_API_KEY');
    // Only passed on if the user already had one: an invented Anthropic key could flip an unknown
    // agent's provider auto-selection and change which model it calls.
    passThrough(env, ctx.env, 'ANTHROPIC_API_KEY');
    return { command, args, env };
  },
};
