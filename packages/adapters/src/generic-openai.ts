import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import {
  applyNamedBaseUrls,
  forwardOrProxyBase,
  passKey,
  passThrough,
  proxyBase,
  readEnv,
} from './env.js';

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
      // TypeSafe's System One API, which Jev answers. A *forward* rather than a bare proxy base,
      // because this origin is not one the proxy has a default for: its paths belong to no wire
      // dialect, so an unclaimed `/v1/systemone` would otherwise be sent to whichever OpenAI-shaped
      // upstream the run was configured with, and answered with a 404. The forward carries the
      // real destination with it.
      //
      // Their own base, when they set one — a self-hosted or staging endpoint has to keep working
      // — and the published API otherwise. No path is appended: the SDK's default base carries no
      // `/v1`, and it joins `/v1/systemone` on itself.
      TYPESAFE_BASE_URL: forwardOrProxyBase(
        ctx.proxyUrl,
        readEnv(ctx.env, 'TYPESAFE_BASE_URL') ?? 'https://api.typesafe.ai',
        '',
      ),
    };
    passKey(env, ctx.env, 'OPENAI_API_KEY');
    // Only passed on if the user already had one: an invented Anthropic key could flip an unknown
    // agent's provider auto-selection and change which model it calls.
    passThrough(env, ctx.env, 'ANTHROPIC_API_KEY');
    // Same rule as Anthropic's, and the contract check enforces it: this adapter is the fallback
    // for agents nobody has written one for, so an invented credential can change which provider
    // an unknown harness picks. It was `passKey` first, and `no-invented-keys` refused it.
    //
    // The cost is worth stating: typesafe-sdk raises at *construction* when TYPESAFE_API_KEY is
    // unset, so replaying a recorded System One run needs some value in that variable even though
    // the answer comes from the trace. Any string does — it is never sent anywhere on replay.
    passThrough(env, ctx.env, 'TYPESAFE_API_KEY');
    applyNamedBaseUrls(env, ctx.env, ctx.proxyUrl);
    return { command, args, env };
  },
};
