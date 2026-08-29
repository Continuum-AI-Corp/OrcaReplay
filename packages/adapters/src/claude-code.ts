import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent } from './detect.js';
import { passKey, passThrough, proxyBase } from './env.js';

/**
 * Claude Code reads `ANTHROPIC_BASE_URL` for the API origin and appends its own `/v1/...` paths,
 * so the proxy url goes in bare.
 */
export const claudeCodeAdapter: Adapter = {
  id: 'claude-code',
  // What people type. The binary is `claude`, and so is every example in the docs.
  aliases: ['claude'],
  harnessVersions: '>=1.0.0',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['claude'], ['.claude']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl) };
    passKey(env, ctx.env, 'ANTHROPIC_API_KEY');
    passThrough(env, ctx.env, 'ANTHROPIC_AUTH_TOKEN');
    return { command: 'claude', args: [...ctx.userArgs], env };
  },
};
