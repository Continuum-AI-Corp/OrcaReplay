import type { ParsedArgs } from './args.js';
import { gatewayHeaders, readConfig, resolveUpstream } from './config.js';

/**
 * Where live model calls go, and what they carry.
 *
 * Needed by record *and* by replay: `--loose` and any fork continue live, and a fork that ignored
 * the override would quietly talk to the real provider instead of the gateway the user pointed it
 * at. Same precedence whichever command is running — flag, then environment, then the gateway from
 * `orca setup`.
 *
 * The headers are the half that makes `orca setup` worth having: a gateway needs a key, and this
 * is the only place one is attached. It goes on the *outbound* request only. What gets recorded is
 * built from the incoming request with auth stripped, so a key orca injects cannot reach a trace
 * by construction rather than by a rule someone has to remember.
 */
export interface UpstreamPlan {
  upstream: Record<string, string> | undefined;
  headers: Record<string, string> | undefined;
}

export async function upstreamPlan(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpstreamPlan> {
  const config = await readConfig(env);
  const upstream = await resolveUpstream(args, env);
  const headers = gatewayHeaders(config, env);
  // Only attach a key when the traffic is actually going to the gateway that issued it. Sending a
  // gateway credential to api.anthropic.com because a flag redirected one dialect would hand a
  // third party a key they were never meant to see.
  const goingToGateway =
    config.gateway?.url !== undefined &&
    Object.values(upstream ?? {}).some((origin) => sameOrigin(origin, config.gateway!.url));
  return {
    upstream,
    headers: goingToGateway && Object.keys(headers).length > 0 ? headers : undefined,
  };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  }
}
