import { HOOK_FILENAME, nodeOptionsWithHook, writeFetchHook } from '@orcareplay/node-instrument';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { passKey, passThrough, proxyBase, readEnv } from './env.js';

/**
 * A JS agent that never reads a base-URL variable.
 *
 * Every other adapter here redirects an environment variable and stops. That covers most
 * harnesses and misses a whole class: `@ai-sdk/openai` takes its origin as a constructor argument
 * and reads nothing from the environment, so a Vercel AI SDK agent under `orca record` runs
 * perfectly, exits 0, and writes an empty trace. The same is true of any agent that hardcodes a
 * base URL, which is most of them once someone has pinned a gateway in code.
 *
 * So this one redirects at the only place all of them agree on — `globalThis.fetch` — by writing
 * a self-contained preload into the run directory and pointing `NODE_OPTIONS` at it. It is a
 * separate adapter rather than a change to `generic-openai` because `NODE_OPTIONS` reaches every
 * Node process the agent spawns, and that is a real cost: worth paying when you know your agent
 * needs it, not worth imposing on someone recording a Python harness.
 */
export const nodeAdapter: Adapter = {
  id: 'node',
  // What people will actually type. The adapter is not specific to the Vercel AI SDK, but that is
  // the name someone reaches for when their trace came back empty.
  aliases: ['vercel-ai', 'ai-sdk'],

  async detect(_cwd: string): Promise<boolean> {
    // Never automatic. Like `generic-openai`, this adapter does not know what it would be
    // launching, and an adapter that cannot know must not claim the workspace.
    return false;
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const [command, ...args] = ctx.userArgs;
    if (command === undefined || command === '') {
      throw new Error(
        'node needs the command to run: orca record node -- <command> [args...], ' +
          'e.g. orca record node -- node agent.mjs',
      );
    }

    const hookPath = await writeFetchHook(ctx.runDir);
    const env: Record<string, string> = {
      // Read by the hook. Absent, the hook is inert — which is what makes the file safe to leave
      // on disk in a run directory someone later opens.
      ORCA_PROXY_URL: ctx.proxyUrl,
      NODE_OPTIONS: nodeOptionsWithHook(hookPath, readEnv(ctx.env, 'NODE_OPTIONS')),
      // Belt and braces. One agent may use an SDK's default client for one provider and a
      // hardcoded origin for another, and orca has no way to tell which from the outside.
      OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
      OPENAI_API_BASE: proxyBase(ctx.proxyUrl, 'v1'),
      ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl),
    };
    // An extra origin to redirect — an Azure deployment, a self-hosted gateway the agent pins in
    // code. Passed through rather than invented so the default stays the two provider hosts.
    passThrough(env, ctx.env, 'ORCA_INSTRUMENT_HOSTS');
    passKey(env, ctx.env, 'OPENAI_API_KEY');
    passThrough(env, ctx.env, 'ANTHROPIC_API_KEY');
    return { command, args, env, tempFiles: [hookPath] };
  },
};

export { HOOK_FILENAME };
