import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent } from './detect.js';
import { passKey, proxyBase } from './env.js';

/** OpenAI SDK clients expect the version segment to be part of the base url. */
export const codexAdapter: Adapter = {
  id: 'codex',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['codex'], ['.codex']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const env: Record<string, string> = { OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1') };
    passKey(env, ctx.env, 'OPENAI_API_KEY');
    return { command: 'codex', args: [...ctx.userArgs], env };
  },
};
