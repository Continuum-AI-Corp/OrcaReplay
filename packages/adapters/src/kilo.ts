import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent } from './detect.js';

/**
 * Kilo Code's CLI — another OpenCode fork, captured the way the others are.
 *
 * Nothing is redirected, for the reason the whole OpenCode family shares: the provider origin
 * lives in the harness's own config rather than in an environment variable, so `OPENAI_BASE_URL`
 * leaves the run talking straight past the proxy. `--tls-intercept` terminates the TLS the agent
 * established itself, and `api.kilo.ai` is in `DEFAULT_TLS_HOSTS` so the built-in `kilo/*` models
 * need no extra `--tls-hosts`.
 *
 * One thing worth knowing before recording it: Kilo checks entitlement locally, before it opens a
 * connection. A model the account cannot use fails with "You need to sign in to use this model"
 * and no request is ever sent, so there is nothing to capture — unlike MiMo, which sends the
 * request and lets the server reject it. `kilo/kilo-auto/free` is reachable without a paid plan
 * and is what the fixture below was verified against.
 *
 * Kilo also posts to `us.i.posthog.com`. That is not a model API and is not in the allowlist, so
 * it stays tunnelled: orca records that the connection happened and reads none of it.
 */
export const kiloAdapter: Adapter = {
  id: 'kilo',
  aliases: ['kilocode', 'kilo-code'],
  harnessVersions: '>=7.5.9',

  // Redirecting nothing is the intent, not a defect. See the `capture` field on `Adapter`.
  capture: 'transport',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['kilo', 'kilocode'], ['.config/kilo', '.kilo']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    // No origin and no credential: both live in the harness's own config and credential store,
    // and an adapter that injected either would override a choice made there.
    return { command: 'kilo', args: [...ctx.userArgs], env: {} };
  },
};
