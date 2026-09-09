import type { ParsedArgs } from './args.js';
import { unusableOrigin } from '@orcareplay/proxy';
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
  /**
   * The origin the headers belong to, when they belong to one.
   *
   * The gateway key is attached per request rather than to every outbound call, because a
   * forwarded request can legitimately go somewhere the gateway is not — a `/forward/` path names
   * its own destination, and sending the gateway's credential there hands a third party a key
   * they were never meant to see, which is the one outcome this plan exists to make impossible.
   */
  headersOrigin: string | undefined;
}

export async function upstreamPlan(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpstreamPlan> {
  const config = await readConfig(env);
  const upstream = await resolveUpstream(args, env);

  // Refused here, because here is where all three sources meet: `--upstream-*`,
  // `ORCA_UPSTREAM_*`, and the gateway from the config file. `orca setup` refuses one on the way
  // in, but a config written before it did, a hand-edited one, an environment variable and a flag
  // all still arrive unchecked — and on the record path an origin is not only sent, it is
  // *printed*: `distinctOrigins` renders it on the recording line, and an origin `doFetch` cannot
  // parse comes back inside undici's TypeError, which the proxy hands to the agent as a 500 body.
  // Neither sink can be made safe by scrubbing alone, because `recordableOrigin` answers with a
  // value for a scheme-less URL whose username parses as the protocol. Refusing closes both.
  for (const [dialect, origin] of Object.entries(upstream ?? {})) {
    const problem = unusableOrigin(origin);
    if (problem === undefined) continue;
    throw new Error(
      `the upstream for ${dialect} is not an origin orca can use: ${problem}` +
        '\n  give it as scheme, host and path: --upstream-openai https://gateway.example/v1' +
        '\n  read in order: --upstream-*, then ORCA_UPSTREAM_*, then the gateway from orca setup',
    );
  }
  const headers = gatewayHeaders(config, env);
  // Unanimity, not `some`. `upstreamHeaders` are attached to every live call the proxy makes —
  // there is no per-dialect header channel — so if any origin we might reach is not the gateway,
  // attaching the key sends it there. A `.some()` check passed whenever *one* dialect still
  // defaulted to the gateway, which is exactly what happens when a flag redirects the other: the
  // gateway's credential went to api.anthropic.com. Verified against the built CLI.
  //
  // Erring towards withholding costs an unauthenticated request and a clear 401. Erring the other
  // way hands a third party a key they were never meant to see, and nothing says it happened.
  const origins = Object.values(upstream ?? {});
  const goingToGateway =
    config.gateway?.url !== undefined &&
    origins.length > 0 &&
    origins.every((origin) => sameOrigin(origin, config.gateway!.url));
  return {
    upstream,
    headers: goingToGateway && Object.keys(headers).length > 0 ? headers : undefined,
    headersOrigin: goingToGateway ? config.gateway!.url : undefined,
  };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  }
}
