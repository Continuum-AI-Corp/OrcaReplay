import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent, homeDirHas } from './detect.js';
import { passKey, passThrough, proxyBase, readEnv } from './env.js';

/** Where `qwen` writes the credentials its OAuth sign-in produces. */
const QWEN_AUTH_PATH = '.qwen/oauth_creds.json';

/** Whether Qwen Code can authenticate on its own, independent of the environment. */
export function qwenHasOwnAuth(): boolean {
  return homeDirHas(QWEN_AUTH_PATH);
}

/**
 * Qwen Code, which reaches four different providers and reads a separate origin for each.
 *
 * The four are all redirected, for the same reason OpenCode's two are: the harness picks its
 * provider from the model it was given, and an origin left pointing at the real API is traffic
 * the run never sees. Read off the installed bundle rather than guessed —
 * `DEFAULT_DASHSCOPE_BASE_URL` is `https://dashscope.aliyuncs.com/compatible-mode/v1` with
 * `DASHSCOPE_PROXY_BASE_URL` as its override, and that is the path Qwen's *own* models take, so
 * an adapter that redirected only `OPENAI_BASE_URL` would miss the default configuration.
 *
 * Deliberately not redirected: `WEB_SEARCH_BASE_URL`. It is the web-search tool's endpoint, not
 * the agent's model origin — off unless `ENABLE_WEB_SEARCH` is set, keyed separately by
 * `WEB_SEARCH_API_KEY`, and falling back to DashScope. Pointing it at the proxy without the
 * matching key would break a tool that works today, so the search calls of a run with search
 * enabled are a known gap in the recording rather than something this adapter silently half-fixes.
 */
export const qwenAdapter: Adapter = {
  id: 'qwen',
  aliases: ['qwen-code'],
  harnessVersions: '>=0.22.3',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['qwen'], ['.qwen']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const env: Record<string, string> = {
      OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
      // DashScope is OpenAI-shaped — `compatible-mode/v1` — so it takes the same `/v1` base.
      DASHSCOPE_PROXY_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
      ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl),
      // Gemini's client appends its own `v1beta/...`, so it gets the bare origin.
      GEMINI_NEXT_GEN_API_BASE_URL: proxyBase(ctx.proxyUrl),
    };

    // The same credential rule as OpenCode, and for the same two reasons. Which keys the harness
    // can see decides which provider it picks, so a placeholder for a provider the user never
    // configured can change which model answers — and a recorded run that answers differently
    // from the same command uninstrumented is the worst kind of capture bug. Separately, `qwen`
    // signs in on its own: an OAuth run writes `~/.qwen/oauth_creds.json`, and inventing keys in
    // front of that credential makes the harness prefer an environment key that is not real.
    //
    // So placeholders stand in only when there is nothing to disturb: no key in the environment
    // and no sign-in of its own.
    const hasAny =
      readEnv(ctx.env, 'OPENAI_API_KEY') !== undefined ||
      readEnv(ctx.env, 'ANTHROPIC_API_KEY') !== undefined ||
      readEnv(ctx.env, 'ANTHROPIC_AUTH_TOKEN') !== undefined ||
      readEnv(ctx.env, 'GEMINI_API_KEY') !== undefined ||
      readEnv(ctx.env, 'GOOGLE_API_KEY') !== undefined ||
      readEnv(ctx.env, 'DASHSCOPE_API_KEY') !== undefined;
    if (hasAny || qwenHasOwnAuth()) {
      passThrough(env, ctx.env, 'OPENAI_API_KEY');
      passThrough(env, ctx.env, 'ANTHROPIC_API_KEY');
      passThrough(env, ctx.env, 'ANTHROPIC_AUTH_TOKEN');
      passThrough(env, ctx.env, 'GEMINI_API_KEY');
      passThrough(env, ctx.env, 'GOOGLE_API_KEY');
      passThrough(env, ctx.env, 'DASHSCOPE_API_KEY');
    } else {
      passKey(env, ctx.env, 'OPENAI_API_KEY');
      passKey(env, ctx.env, 'ANTHROPIC_API_KEY');
    }

    // `OPENAI_MODEL` is passed on, never invented: Qwen Code has no default for a
    // custom endpoint, so the model id is the operator's to supply and the adapter has no way to
    // know which one the recording is meant to exercise.
    passThrough(env, ctx.env, 'OPENAI_MODEL');
    passThrough(env, ctx.env, 'QWEN_CODE_MODEL');

    return { command: 'qwen', args: [...ctx.userArgs], env };
  },
};
