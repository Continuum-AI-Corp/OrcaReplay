import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { applyNamedBaseUrls } from './env.js';

/**
 * Any agent at all, captured at the transport.
 *
 * The other adapters here each name a harness and the variable it reads. This one names neither,
 * because the cases it exists for have nothing to name:
 *
 *   - a bot with its origin hardcoded in source — a Grok bot posting to `https://api.x.ai/v1`
 *     because someone typed that string, which no environment variable will ever move;
 *   - an agent in a language the fetch hook cannot reach, which is every language except JS;
 *   - an editor that spawns the real agent as a child, where orca launches the editor and the
 *     agent inherits the capture two processes down.
 *
 * For all three the redirect happens below the agent, at the socket: `--tls-intercept` terminates
 * the TLS the agent established itself. That is applied by the run rather than by this adapter,
 * which is why `prepare` looks nearly empty — the emptiness is the design.
 *
 * It is deliberately not `generic-openai` with a better name. That adapter sets `OPENAI_BASE_URL`,
 * `OPENAI_API_BASE` and `ANTHROPIC_BASE_URL` at once, which is right when you know your agent
 * reads one of them and actively wrong when you do not: an injected origin silently repoints a
 * harness that would otherwise have called somewhere else, and the trace then describes a run the
 * user never asked for. Pointing an unknown agent nowhere is the honest default.
 */
export const execAdapter: Adapter = {
  id: 'exec',
  // `any` is what someone types when their agent is not on the list, which is the whole audience.
  aliases: ['any'],

  // Redirecting nothing is the intent, not a defect. See the `capture` field on `Adapter`.
  capture: 'transport',

  async detect(_cwd: string): Promise<boolean> {
    // Never automatic. An adapter that does not know what it would be launching must not claim a
    // workspace — the same rule `generic-openai` and `node` follow, for the same reason.
    return false;
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const [command, ...args] = ctx.userArgs;
    if (command === undefined || command === '') {
      throw new Error(
        'exec needs the command to run: orca record exec --tls-intercept -- <command> [args...], ' +
          'e.g. orca record exec --tls-intercept -- python bot.py',
      );
    }

    // Nothing is invented: no origin, and no credential. An agent recorded this way authenticates
    // with whatever it already had, because orca never learned which provider it talks to.
    const env: Record<string, string> = {};
    // The one exception, and only because the operator asked for it by name. This is what makes
    // `exec` useful for a harness that reads an unusual variable but has no adapter yet, without
    // needing interception at all.
    applyNamedBaseUrls(env, ctx.env, ctx.proxyUrl);

    return { command, args, env };
  },
};
