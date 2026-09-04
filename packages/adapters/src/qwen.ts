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
 * Two of the four are redirected, and the other two deliberately are not. The line is not about
 * the harness at all — it is about what orca can put on the other end.
 *
 * `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` are moved, because the proxy can restore those
 * origins: `resolveUpstream` produces `anthropic`, `openai` and `openai-responses` keys, and the
 * dialects default to `api.anthropic.com` and `api.openai.com` when nothing is configured. A
 * redirected call reaches the provider the client was already addressing.
 *
 * `DASHSCOPE_PROXY_BASE_URL` and `GEMINI_NEXT_GEN_API_BASE_URL` are left alone, and this is the
 * uncomfortable part: they are the origins Qwen's *own* models and Gemini use, so leaving them is
 * a real gap in what a run records. Redirecting them would be worse. The proxy resolves a live
 * upstream by **wire dialect, not by provider**, and no `--upstream` form or gateway setting can
 * name either destination — so with no gateway configured (a setup the README supports outright)
 * a DashScope call arrives as `POST /v1/chat/completions`, is claimed by the openai dialect, and
 * is forwarded to `api.openai.com` carrying `Authorization: Bearer <the user's DashScope key>`.
 * A Gemini call reaches `/v1beta/models/...`, which no dialect claims, so `passthroughOrigin`
 * guesses from headers — and it recognises only Anthropic's, treating everything else as OpenAI,
 * which sends `x-goog-api-key` the same way. Its own comment says why that matters: "a wrong guess
 * does not merely fail — it hands one vendor a key issued by another."
 *
 * So these two join `WEB_SEARCH_BASE_URL` as documented gaps. That one is the web-search tool's
 * endpoint rather than a model origin — off unless `ENABLE_WEB_SEARCH` is set, keyed separately by
 * `WEB_SEARCH_API_KEY` — and pointing it at the proxy without the matching key would break a tool
 * that works today. Different reason, same conclusion: an origin orca cannot serve is one it
 * should not take away.
 *
 * To record Qwen against its own models, terminate the TLS instead of moving the origin. One host
 * is not enough, because `HostPolicy` matches a bare pattern exactly and the harness reaches a
 * whole family — read off the same bundle: `dashscope.aliyuncs.com` is only the default, with
 * `coding.dashscope.aliyuncs.com` and `coding-intl.dashscope.aliyuncs.com` for the coding plan,
 * `cn-hongkong.dashscope.aliyuncs.com`, `dashscope-intl.aliyuncs.com` and
 * `dashscope-us.aliyuncs.com` by region, and the token plan on a different domain again at
 * `token-plan.cn-beijing.maas.aliyuncs.com` / `token-plan.ap-southeast-1.maas.aliyuncs.com`. So:
 *
 *     orca record qwen --tls-intercept --tls-hosts \
 *       '+dashscope.aliyuncs.com,+*.dashscope.aliyuncs.com,+dashscope-intl.aliyuncs.com,+dashscope-us.aliyuncs.com'
 *
 * adding `+token-plan.cn-beijing.maas.aliyuncs.com` or the Singapore one if that is the plan in
 * use, and `+api-inference.modelscope.cn` for a ModelScope endpoint. The wildcard covers the
 * `*.dashscope` subdomains without reaching the console: DashScope's sign-in lives on
 * `bailian.console.aliyun.com` and `modelstudio.console.alibabacloud.com`, different domains
 * entirely, which is what makes the wildcard narrower here than one over a vendor's whole zone.
 */
export const qwenAdapter: Adapter = {
  id: 'qwen',
  aliases: ['qwen-code'],
  harnessVersions: '>=0.22.3',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['qwen'], ['.qwen']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    // Only the two origins the proxy can put a real provider behind. See the note above for why
    // DashScope and Gemini are left pointing at their own APIs rather than at a proxy that would
    // forward them, and their credentials, to OpenAI.
    const env: Record<string, string> = {
      OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
      ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl),
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
