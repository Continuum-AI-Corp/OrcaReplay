import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent } from './detect.js';

/**
 * MiMo Code, Xiaomi's terminal agent — an OpenCode fork, captured the way OpenCode is.
 *
 * Nothing is redirected, and that is inherited rather than chosen: like OpenCode, MiMo keeps its
 * provider origin in a config file (`~/.config/mimocode/mimocode.jsonc`) rather than in an
 * environment variable, so `OPENAI_BASE_URL` leaves the run talking straight past the proxy. The
 * route that works is the one orca built for an origin that cannot be moved — `--tls-intercept`
 * terminates the TLS the agent established itself, and the config is left alone.
 *
 * Being a fork does *not* mean it inherits an OpenCode installation. The two read parallel
 * directories, `~/.config/mimocode/` beside `~/.config/opencode/`, so a machine with OpenCode
 * configured still starts MiMo on Xiaomi's own provider. The config *shape* is shared, which is
 * what makes a provider block copied from one work in the other.
 *
 * `api.xiaomimimo.com` is in `DEFAULT_TLS_HOSTS`, so no extra `--tls-hosts` is needed for the
 * built-in `xiaomi/*` and `mimo/*` models. A provider of your own pointed at a plain-HTTP gateway
 * is a different matter: orca sets `HTTPS_PROXY` and not `HTTP_PROXY`, so that traffic is neither
 * redirected nor decrypted and the run records nothing.
 *
 * A credential is not required to capture the prompt. MiMo sends the request and lets the server
 * reject it, and the system prompt is in the request — so an invalid key still yields a complete
 * capture, which is how the fixture below was verified.
 */
export const mimoAdapter: Adapter = {
  id: 'mimo',
  aliases: ['mimo-code', 'mimocode'],
  harnessVersions: '>=0.1.14',

  // Redirecting nothing is the intent, not a defect. See the `capture` field on `Adapter`.
  capture: 'transport',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['mimo'], ['.config/mimocode', '.mimocode']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    // No origin and no credential: both live in the harness's own config, and an adapter that
    // injected either would be overriding a choice the operator already made there.
    return { command: 'mimo', args: [...ctx.userArgs], env: {} };
  },
};
