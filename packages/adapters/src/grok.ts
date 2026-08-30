import {
  HOOK_FILENAME,
  bunOptionsWithHook,
  nodeOptionsWithHook,
  writeFetchHook,
} from '@orcareplay/node-instrument';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { applyNamedBaseUrls, passThrough, proxyBase, readEnv } from './env.js';
import { detectAgent } from './detect.js';

/** xAI's origin, which grok-cli reaches whenever something bypasses `GROK_BASE_URL`. */
const XAI_HOST = 'api.x.ai';

/**
 * grok-cli — the community coding agent for xAI's Grok API.
 *
 * It documents `GROK_BASE_URL` (default `https://api.x.ai/v1`), so the ordinary redirect works and
 * this adapter is mostly that one variable. Two details are not ordinary:
 *
 * The `/v1` is part of the documented default, so the replacement carries it — drop it and every
 * request lands one path segment short.
 *
 * And it runs on Bun with sub-agents on by default. A sub-agent that builds its own client would
 * slip past a variable its parent read, so the fetch hook goes in as well, with `api.x.ai` added
 * to the allowlist — it is not one of the hook's default hosts, so without that line the hook
 * would be installed and inert. Bun ignores `--require` inside `NODE_OPTIONS`, which is why
 * `BUN_OPTIONS` is set alongside it.
 *
 * Its Telegram remote control is the same process reading the same variable, so "the grok bot" is
 * captured by this adapter too, with nothing extra.
 */
export const grokAdapter: Adapter = {
  id: 'grok',
  aliases: ['grok-cli'],

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['grok'], ['.grok']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const hookPath = await writeFetchHook(ctx.runDir);
    const hosts = readEnv(ctx.env, 'ORCA_INSTRUMENT_HOSTS');
    const env: Record<string, string> = {
      GROK_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
      ORCA_PROXY_URL: ctx.proxyUrl,
      // Added to whatever the operator asked for rather than replacing it: naming one host should
      // not silently drop xAI, which is the only host this adapter exists to catch.
      ORCA_INSTRUMENT_HOSTS: hosts === undefined ? XAI_HOST : `${hosts},${XAI_HOST}`,
      NODE_OPTIONS: nodeOptionsWithHook(hookPath, readEnv(ctx.env, 'NODE_OPTIONS')),
      BUN_OPTIONS: bunOptionsWithHook(hookPath, readEnv(ctx.env, 'BUN_OPTIONS')),
    };
    // Never invented: grok-cli refuses to start without a key and says so clearly, which is a
    // better failure than a run that silently authenticates as nobody.
    passThrough(env, ctx.env, 'GROK_API_KEY');
    applyNamedBaseUrls(env, ctx.env, ctx.proxyUrl);
    return { command: 'grok', args: [...ctx.userArgs], env, tempFiles: [hookPath] };
  },
};

export { HOOK_FILENAME };
