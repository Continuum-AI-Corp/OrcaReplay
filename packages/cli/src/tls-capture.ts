import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TraceWriter } from '@orcareplay/core';
import type { TraceEvent } from '@orcareplay/schema';
import {
  HostPolicy,
  RunCa,
  type InterceptFailure,
  resolveTlsHosts,
  type NetExchange,
  type TlsInterceptInfo,
  type TunnelRecord,
} from '@orcareplay/proxy';
import type { ParsedArgs } from './args.js';
import type { Output } from './out.js';
import type { SerialQueue } from './serial.js';

/**
 * TLS interception, shared by every command that runs an agent live.
 *
 * This lived inside `orca record` and nowhere else, which made `--tls-intercept` a flag the parser
 * accepted and `orca replay --model`, `orca fork` and `orca compare` silently discarded — the three
 * commands that also launch a real agent, and so the three where a harness talking to its own
 * backend over TLS is just as invisible. A flag that is accepted and ignored is worse than one that
 * is rejected: the operator believes they captured the traffic.
 *
 * Everything that can be rejected is rejected before anything is minted, so a run that is not going
 * to happen — `--tls-hosts '*'`, an unreadable `ORCA_TLS_UPSTREAM_CA` — leaves no private key on
 * disk at all. The caller owns the CA's lifetime and must dispose it on every exit path.
 */

export interface TlsCaptureRequest {
  args: ParsedArgs;
  out: Output;
  /**
   * Hosts the run being reproduced decrypted, recovered from its own trace.
   *
   * Present for replay and fork, absent for a fresh recording. See `recordedTlsHosts`.
   */
  recordedHosts?: readonly string[];
  writer?: TraceWriter;
  /** Used by an exact replay running with --no-trace, where there is no writer to own the CA. */
  runDir?: string;
  writes: SerialQueue;
  /**
   * The turn a frame belongs to, read when the frame is persisted rather than when capture is set
   * up: out-of-band traffic is attributed to whichever turn was in progress at the time, and the
   * caller's turn counter moves under us.
   */
  turn: () => number;
}

export interface TlsCapture {
  /** The CA, present only when interception was asked for. The caller disposes it. */
  ca?: RunCa;
  /** Spread into `createProxy()`. Empty when interception was not asked for. */
  proxyOptions: Record<string, unknown>;
}

export async function setupTlsCapture(req: TlsCaptureRequest): Promise<TlsCapture> {
  const { args, out, writer, writes, recordedHosts } = req;

  const askedFor = args.bool('tls-intercept');
  // `--no-tls-intercept` is the only way to tell "left unset" apart from "explicitly refused", and
  // the difference matters below: absence means orca may decide, refusal means it may not.
  const refused = args.has('tls-intercept') && !askedFor;
  const tlsHosts = args.list('tls-hosts');

  /**
   * A run that was recorded through interception has to be replayed through it.
   *
   * The agent this exists for talks to its own backend over TLS it establishes itself, so without
   * interception the replay proxy never sees the request at all: it tunnels the CONNECT to an
   * origin that is offline or, worse, live. That failed as `reused=0/n` — which reads as a broken
   * recording rather than as a missing flag, and the flag is one nobody thinks to repeat when the
   * command they type is `orca replay last`.
   *
   * So the recording decides. It already knows: every intercepted run writes a `tls_intercept`
   * note naming the hosts it decrypted, and that list is exactly the one the replay needs. Nothing
   * is inferred and nothing is widened — an operator who never turned interception on gets a
   * replay that never turns it on either.
   */
  const inherited = !askedFor && !refused && recordedHosts !== undefined;
  const interceptTls = askedFor || inherited;

  // Naming hosts without asking for interception captures nothing and says nothing, which reads
  // as "orca ignored my traffic" rather than as "orca ignored my flag".
  if (!interceptTls && tlsHosts.length > 0) {
    out.warn('tls.hosts_ignored', { hosts: tlsHosts.join(','), next: 'add --tls-intercept' });
  }
  if (!interceptTls) return { proxyOptions: {} };

  // An explicit list always wins, so a replay can be narrowed or widened by hand. Falling back to
  // the recorded list rather than to the defaults keeps the reproduction faithful: replaying with
  // a *different* policy than the recording used is how a run stops reproducing itself.
  // Resolved before anything is minted, so a contradictory list — one that both replaces the
  // defaults and adds to them — fails while the run directory still holds no private key.
  const hosts =
    tlsHosts.length > 0 ? resolveTlsHosts(tlsHosts) : (recordedHosts ?? resolveTlsHosts([]));
  HostPolicy.from([...hosts]);
  const trustedOriginCerts = await extraOriginRoots();
  const runDir = writer?.runDir ?? req.runDir;
  if (!runDir) throw new Error('TLS interception needs a run directory');
  const ca = await RunCa.create({ runDir });

  return {
    ca,
    proxyOptions: {
      tls: {
        ca,
        hosts: [...hosts],
        trustedOriginCerts,
        ...(writer
          ? {
              onNetExchange: (exchange: NetExchange) => {
                writes.push(() => persistNetExchange(writer, req.turn(), exchange));
              },
            }
          : {}),
        onTunnel: (tunnel: TunnelRecord) => {
          if (writer) writes.push(() => persistTunnel(writer, req.turn(), tunnel));
        },
        onFailure: (failure: InterceptFailure) => out.warn('tls.handshake_failed', { ...failure }),
      },
    },
  };
}

/**
 * The hosts a recorded run decrypted, read back out of its own trace.
 *
 * `trustRunCa` writes this note on every intercepted run — a digest and a host list, never the
 * certificate and never the key — so the trace is self-describing about the one thing a faithful
 * replay cannot guess. Returns undefined for a run recorded without interception, which is the
 * signal that the replay must not turn it on either.
 */
export function recordedTlsHosts(events: readonly TraceEvent[]): readonly string[] | undefined {
  for (const event of events) {
    if (event.type !== 'note' || event.attrs?.['rule'] !== 'tls_intercept') continue;
    const hosts = event.attrs['hosts'];
    if (typeof hosts !== 'string') continue;
    const parsed = hosts
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h !== '');
    if (parsed.length > 0) return parsed;
  }
  return undefined;
}

/**
 * What the launched agent needs in its environment to be intercepted, and the disclosure the
 * operator needs before it happens.
 *
 * Lived in `orca record` alongside the setup, so a fork that minted a CA would have decrypted
 * nothing: the child was never pointed at the proxy and never told to trust the root. Interception
 * is only two halves working together, so both halves belong in one place.
 */
export async function trustRunCa(
  writer: TraceWriter | undefined,
  proxyTls: TlsInterceptInfo,
  proxyUrl: string,
  env: Record<string, string>,
  out: Output,
): Promise<void> {
  // The child trusts the run CA through its own environment and through nothing else. Nothing here
  // touches a system or browser trust store, and orca will not offer to: interception ends when
  // this process does, which is the property that makes it defensible at all.
  env.HTTPS_PROXY = proxyUrl;
  env.https_proxy = proxyUrl;
  // NODE_EXTRA_CA_CERTS *adds* to Node's trust store. The rest of these *replace* an OpenSSL
  // client's store outright, so they get the bundle — the run CA plus the public roots — or the
  // child would lose its ability to reach every host orca deliberately does not intercept.
  env.NODE_EXTRA_CA_CERTS = proxyTls.caCertPath;
  for (const variable of [
    'SSL_CERT_FILE',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'AWS_CA_BUNDLE',
    'DENO_CERT',
  ]) {
    env[variable] = proxyTls.caBundlePath;
  }
  // The agent also talks to the recording proxy directly over plain HTTP via the base-URL
  // variables. Sending those through the proxy as well would be a loop.
  const existing = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  const noProxy = [existing, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;

  out.warn('tls.intercepting', {
    hosts: proxyTls.hosts,
    ca_sha256: proxyTls.fingerprint,
    ca_dir: dirname(proxyTls.caCertPath),
  });
  out.plain('  TLS interception is on for this run. Traffic to the hosts above is decrypted,');
  out.plain('  recorded and re-encrypted; everything else is tunnelled unread. The certificate');
  out.plain('  authority is unique to this run, trusted only by the agent orca launches, and');
  out.plain('  deleted when the run ends. It is not installed anywhere.');

  // A digest, never the certificate and never the key. The CA is deleted when the run ends, so
  // this line is the only lasting evidence of which authority signed what — enough to match a
  // certificate someone finds later to the run that minted it, and useless for anything else.
  if (writer) {
    await writer.append({
      type: 'note',
      actor: 'orca',
      turn: 0,
      attrs: { rule: 'tls_intercept', hosts: proxyTls.hosts, ca_sha256: proxyTls.fingerprint },
    });
  }
}

/**
 * One decrypted HTTP exchange orca did not recognise as a model call.
 *
 * `net.request` / `net.response` have been in the spec since v0 and nothing has ever emitted them;
 * this is what makes them real. The pair is deliberately shaped like `model.request` /
 * `model.response` so the timeline reads the same either way.
 */
export async function persistNetExchange(
  writer: TraceWriter,
  turn: number,
  exchange: NetExchange,
): Promise<void> {
  const request = await writer.append({
    type: 'net.request',
    // The agent made the call. No actor names "some server on the internet", so the reply is
    // attributed to orca, which is the only party that witnessed it.
    actor: 'agent',
    turn,
    attrs: {
      host: exchange.host,
      port: exchange.port,
      method: exchange.method,
      path: exchange.path,
      intercepted: true,
      headers: exchange.requestHeaders,
      truncated: exchange.requestTruncated,
    },
    payload: exchange.requestBody as never,
  });
  await writer.append({
    type: 'net.response',
    actor: 'orca',
    turn,
    causes: [request.seq],
    attrs: {
      host: exchange.host,
      port: exchange.port,
      status: exchange.status,
      intercepted: true,
      headers: exchange.responseHeaders,
      bytes: exchange.responseBytes,
      truncated: exchange.responseTruncated,
      duration_ms: exchange.durationMs,
    },
    payload: exchange.responseBody as never,
  });
}

/**
 * A connection orca refused to decrypt.
 *
 * Recorded because the refusal is itself the evidence — and because an operator whose harness talks
 * to an endpoint nobody predicted finds it here, in a line naming the host and nothing else, rather
 * than by guessing. No path, no headers, no payload: there is nothing to write, because orca never
 * held the plaintext.
 */
async function persistTunnel(
  writer: TraceWriter,
  turn: number,
  tunnel: TunnelRecord,
): Promise<void> {
  const request = await writer.append({
    type: 'net.request',
    actor: 'agent',
    turn,
    attrs: {
      host: tunnel.host,
      port: tunnel.port,
      intercepted: false,
      reason: 'host not in the TLS interception allowlist',
    },
  });
  await writer.append({
    type: 'net.response',
    actor: 'orca',
    turn,
    causes: [request.seq],
    attrs: {
      host: tunnel.host,
      port: tunnel.port,
      intercepted: false,
      bytes_to_origin: tunnel.bytesToOrigin,
      bytes_to_client: tunnel.bytesToClient,
      duration_ms: tunnel.durationMs,
      ...(tunnel.error === undefined ? {} : { error: tunnel.error }),
    },
  });
}

/**
 * Extra roots to trust when connecting onward to the real origin.
 *
 * An intercepting proxy terminates TLS, so it also has to make the outbound connection itself. In a
 * corporate environment that connection goes through another intercepting proxy whose root Node
 * does not ship, and the run fails at the first request with an opaque certificate error.
 */
async function extraOriginRoots(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const configured = env.ORCA_TLS_UPSTREAM_CA;
  if (!configured) return [];
  const roots: string[] = [];
  for (const path of configured
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    roots.push(await readFile(path, 'utf8'));
  }
  return roots;
}
