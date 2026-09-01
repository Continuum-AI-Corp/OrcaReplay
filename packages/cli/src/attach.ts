import { isIP } from 'node:net';

/**
 * Recording an agent orca does not launch.
 *
 * Every other capture path here ends in a child process: an adapter builds an environment and orca
 * spawns the agent inside it. That is the design, and it has exactly one boundary it cannot cross
 * — an agent that is not on this machine. A bot on a VPS, an agent inside a dev container or a
 * cloud sandbox, a harness someone else's CI runs: there is no process to spawn, so there is no
 * environment to build.
 *
 * Orca can still be reachable, and can still say precisely what to set. The proxy already accepts
 * a bind address. What was missing is this half: the block of variables the operator pastes on the
 * far side, which has to be right or the run comes back empty with nothing to explain why.
 *
 * Everything here is pure and returns data rather than printing, because the failure mode being
 * guarded against is a *wrong instruction* — a path that exists here and not there, a wildcard
 * address nothing can dial — and those are only testable if the strings are values.
 */

/** Bind addresses that mean "every interface", and so mean nothing as a destination. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '[::]', '*']);

export interface AdvertiseRequest {
  /** The address the proxy is listening on. */
  bind: string;
  /** The port it actually bound, which is not the advertised one behind a port mapping. */
  port: number;
  /** An explicit host, optionally with its own `:port`, overriding both of the above. */
  advertise?: string;
}

/**
 * The origin a remote agent should be pointed at.
 *
 * `0.0.0.0` is a statement about listening, not an address: an agent handed `http://0.0.0.0:8080`
 * fails in a way that looks like orca is broken rather than like the invocation was incomplete. So
 * a wildcard bind must be paired with the name the sandbox actually reaches this machine by, and
 * refusing is the only honest option — orca cannot discover that name, and guessing one produces a
 * run that records nothing.
 */
export function advertisedUrl(req: AdvertiseRequest): string {
  if (req.advertise !== undefined && req.advertise.trim() !== '') {
    const host = req.advertise
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    // A host the operator wrote a port into is used as-is: behind a port-mapped container the
    // reachable port is not the one orca bound, and orca has no way to learn the mapping.
    return `http://${hasPort(host) ? host : `${bracketed(host)}:${req.port}`}`;
  }
  if (WILDCARD_BINDS.has(req.bind)) {
    throw new Error(
      `--bind ${req.bind} listens on every interface, which is not an address an agent can ` +
        'connect to. Add --advertise <host> naming how the sandbox reaches this machine, ' +
        'e.g. --advertise 10.0.0.5 or --advertise host.docker.internal.',
    );
  }
  return `http://${bracketed(req.bind)}:${req.port}`;
}

/** A bare IPv6 literal is not a URL host until it is bracketed. */
function bracketed(host: string): string {
  if (host.startsWith('[')) return host;
  return isIP(host) === 6 ? `[${host}]` : host;
}

/** Does this host already carry its own port? Written to survive an IPv6 literal. */
function hasPort(host: string): boolean {
  const colon = host.lastIndexOf(':');
  if (colon === -1 || colon < host.lastIndexOf(']')) return false;
  return /^\d+$/.test(host.slice(colon + 1));
}

export interface AttachRequest {
  /** Where the remote agent should send its model traffic. */
  proxyUrl: string;
  /** Variables the named adapter would have set, already pointed at `proxyUrl`. */
  adapterEnv: Record<string, string>;
  /** Present only when the run is intercepting. Paths are local, and are only for the copy step. */
  ca?: { certPath: string; bundlePath: string };
  /** Where the CA will live *in the sandbox* once copied. Every printed path uses this. */
  remoteCaPath?: string;
}

/**
 * The variables to set on the far side.
 *
 * The CA paths are the remote ones throughout. Printing this machine's path is the subtle failure
 * this function exists to prevent: the block runs cleanly, every variable is set, and the agent
 * trusts nothing — because the file those variables name is not there.
 */
export function attachExports(req: AttachRequest): Record<string, string> {
  const env: Record<string, string> = { ...req.adapterEnv };
  if (!req.ca || !req.remoteCaPath) return env;

  env.HTTPS_PROXY = req.proxyUrl;
  env.https_proxy = req.proxyUrl;
  // One path for all of them, unlike a local run. The bundle exists so an intercepted child keeps
  // reaching the hosts orca deliberately does not decrypt; a sandbox that already trusts the
  // public roots needs only the run CA added, and shipping one file is what makes the copy step a
  // single line the operator will actually run.
  for (const name of [
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'AWS_CA_BUNDLE',
    'DENO_CERT',
  ]) {
    env[name] = req.remoteCaPath;
  }
  // Deliberately not carried across. `NO_PROXY` is set for a local run so the agent's plaintext
  // calls to the proxy do not loop back through it; inherited into a sandbox it is just a list of
  // hosts that machine will refuse to proxy, which is a silent way to record nothing.
  return env;
}

/** Single-quote a value so no shell can reinterpret it, however it was spelled. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The block the operator pastes into the sandbox.
 *
 * The copy step comes first because the export block references a file that has to exist by the
 * time the agent starts, and an operator who pastes the second half alone gets an agent that
 * cannot verify the proxy it was just told to trust.
 */
export function attachInstructions(req: AttachRequest): string[] {
  const lines: string[] = [];
  if (req.ca && req.remoteCaPath) {
    lines.push(`# 1. copy the run's certificate authority into the sandbox:`);
    lines.push(`#    scp ${req.ca.bundlePath} <sandbox>:${req.remoteCaPath}`);
    lines.push(`#    (or: docker cp ${req.ca.bundlePath} <container>:${req.remoteCaPath})`);
    lines.push(`# 2. then, in the sandbox, before starting your agent:`);
  } else {
    lines.push(`# in the sandbox, before starting your agent:`);
  }
  for (const [name, value] of Object.entries(attachExports(req))) {
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  return lines;
}
