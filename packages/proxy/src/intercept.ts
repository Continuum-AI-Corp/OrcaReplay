import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { createSecureContext, rootCertificates, TLSSocket, type SecureContext } from 'node:tls';
import { AUTH_REQUEST_HEADERS, AUTH_RESPONSE_HEADERS } from '@orcareplay/core';
import type { RunCa } from './ca.js';
import { HostPolicy } from './tls-hosts.js';

/**
 * HTTP CONNECT: tunnel it, or terminate it and look inside.
 *
 * Capture is normally base-URL injection — point an environment variable at a local origin server
 * and the agent's traffic arrives in plaintext. A harness that reads no such variable (a Codex CLI
 * signed in with a ChatGPT subscription is the case that forced this) is invisible to that
 * mechanism, because it talks to its own backend over TLS it established itself.
 *
 * So: a proxy the child is pointed at with `HTTPS_PROXY`, a CA minted for this run alone, and a
 * certificate for exactly the hosts the operator named. Everything else is copied byte for byte
 * between two sockets, which is the difference between a debugger and a wiretap.
 */

/** Described by this connection rather than by the message, so never forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  // Stripped so the origin answers in plaintext. A recorded gzip frame is a recording nobody can
  // read, and the agent is no worse off for receiving the bytes uncompressed.
  'accept-encoding',
]);

/**
 * Forwarded upstream, never written down. Same rule the origin-server path already applies: an
 * agent that cannot authenticate cannot run, and spec §7 forbids writing auth material, which is
 * a different requirement from relaying it.
 */
const SECRET_REQUEST_HEADERS = new Set(AUTH_REQUEST_HEADERS);

/** A response can hand out credentials too. `set-cookie` is a session, not metadata. */
const SECRET_RESPONSE_HEADERS = new Set(AUTH_RESPONSE_HEADERS);

/** Enough to hold any model exchange; short of enough to hold somebody's video download. */
const DEFAULT_MAX_CAPTURED_BYTES = 1024 * 1024;

/** One decrypted HTTP request and its reply, as seen inside an intercepted TLS session. */
export interface NetExchange {
  host: string;
  port: number;
  method: string;
  path: string;
  /** Auth headers removed; see `SECRET_REQUEST_HEADERS`. */
  requestHeaders: Record<string, string>;
  requestBody: string;
  requestTruncated: boolean;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  responseTruncated: boolean;
  /** The full size on the wire, even where the captured body was truncated. */
  responseBytes: number;
  durationMs: number;
}

/**
 * A connection orca deliberately did not read.
 *
 * Recorded anyway, because "orca opened a tunnel to this host and looked at none of it" is the
 * evidence for the claim the feature makes about itself — and because it is how an operator finds
 * out which host to add to the allowlist when a harness surprises them.
 */
export interface TunnelRecord {
  host: string;
  port: number;
  bytesToOrigin: number;
  bytesToClient: number;
  durationMs: number;
  error?: string;
}

export interface InterceptFailure {
  host: string;
  port: number;
  reason: string;
}

export interface TlsInterceptOptions {
  /** The run's certificate authority. Minted per run, deleted with it. */
  ca: RunCa;
  /** Host patterns to decrypt. Everything else is tunnelled. Defaults to model API hosts. */
  hosts?: readonly string[];
  /**
   * Extra roots trusted when re-encrypting to the origin.
   *
   * Verification of the origin stays on regardless — interception is not licence to stop checking
   * who we are talking to. This exists for a machine already behind a TLS-inspecting middlebox,
   * whose corporate root is not in Node's bundle, and for tests.
   */
  trustedOriginCerts?: readonly string[];
  maxCapturedBytes?: number;
  onNetExchange?: (exchange: NetExchange) => void;
  onTunnel?: (tunnel: TunnelRecord) => void;
  onFailure?: (failure: InterceptFailure) => void;
}

export interface TlsInterceptHandle {
  /** The policy actually in force, so a run can report what it is about to decrypt. */
  policy: HostPolicy;
  /** Destroys every tunnel and decrypted session. Without it a run hangs on an idle keep-alive. */
  close: () => void;
}

interface Target {
  host: string;
  port: number;
}

interface CaptureCounters {
  intercepted: number;
  tunnelled: number;
}

/** `host:port` from a CONNECT request line, with the default HTTPS port when it is omitted. */
function parseTarget(authority: string): Target | undefined {
  const trimmed = authority.trim();
  const colon = trimmed.lastIndexOf(':');
  // A colon inside brackets belongs to an IPv6 literal, not to a port.
  const hasPort = colon > trimmed.lastIndexOf(']');
  const hostText = hasPort ? trimmed.slice(0, colon) : trimmed;
  const host = hostText.replace(/^\[|\]$/g, '');
  if (host.length === 0) return undefined;
  if (!hasPort) return { host, port: 443 };
  const port = Number(trimmed.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return { host, port };
}

/**
 * Attach CONNECT handling to an existing origin server.
 *
 * Only ever called when interception was asked for. With no `'connect'` listener Node destroys
 * the socket, which is the right answer for a proxy that was not asked to be one — so "off" is
 * the absence of this function, not a branch inside it.
 */
export function attachTlsIntercept(
  server: {
    on(
      event: 'connect',
      listener: (req: IncomingMessage, socket: Socket, head: Buffer) => void,
    ): unknown;
  },
  options: TlsInterceptOptions,
  counters: CaptureCounters,
): TlsInterceptHandle {
  const policy = HostPolicy.from(options.hosts ?? []);
  const maxCaptured = options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURED_BYTES;
  const extraRoots = options.trustedOriginCerts ?? [];
  // `ca` replaces the default store rather than adding to it, so an extra root has to be supplied
  // alongside the whole bundle or the proxy would stop trusting the public web.
  const originTrust = extraRoots.length > 0 ? [...rootCertificates, ...extraRoots] : undefined;
  const agent = new Agent({ keepAlive: true, maxSockets: 64 });

  /** One secure context per intercepted host; minting is cheap but not free. */
  const contexts = new Map<string, SecureContext>();
  /**
   * Which origin a decrypted request was destined for, keyed by the socket we created for it.
   *
   * Keyed on `object` rather than `TLSSocket` so a lookup from `req.socket` needs no cast: a
   * socket this map does not know is simply a miss, which is exactly the answer wanted.
   */
  const targets = new WeakMap<object, Target>();
  const open = new Set<Socket | TLSSocket>();

  const decrypted = createHttpServer((req, res) => {
    void forward(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `orca tls-intercept: ${String(err)}` } }));
    });
  });

  /**
   * A protocol switch inside a session we decrypted — a WebSocket, usually.
   *
   * Not relayed: this proxy understands request/response exchanges and nothing else, and a
   * half-implemented WebSocket relay would drop frames rather than fail. Refusing outright and
   * saying so leaves the operator with a message instead of a hang, and the remedy is to take the
   * host off the allowlist so the whole connection is tunnelled untouched instead.
   */
  decrypted.on('upgrade', (req, socket: Socket) => {
    const target = targets.get(req.socket);
    options.onFailure?.({
      host: target?.host ?? 'unknown',
      port: target?.port ?? 0,
      reason: `orca cannot relay an ${String(req.headers.upgrade)} upgrade through an intercepted connection`,
    });
    socket.end('HTTP/1.1 501 Not Implemented\r\nconnection: close\r\n\r\n');
  });

  function contextFor(host: string): SecureContext {
    const cached = contexts.get(host);
    if (cached) return cached;
    const issued = options.ca.issue(host);
    const context = createSecureContext({ key: issued.keyPem, cert: issued.certPem });
    contexts.set(host, context);
    return context;
  }

  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = targets.get(req.socket);
    if (!target) throw new Error('decrypted request arrived on an unknown connection');

    const startedAt = Date.now();
    const path = req.url ?? '/';
    const outboundHeaders: Record<string, string | string[]> = {};
    const recordableHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const key = name.toLowerCase();
      if (HOP_BY_HOP.has(key) || value === undefined) continue;
      outboundHeaders[name] = value;
      if (!SECRET_REQUEST_HEADERS.has(key) && typeof value === 'string') {
        recordableHeaders[key] = value;
      }
    }
    // Node lower-cases every incoming header name, so this replaces the client's own `host`
    // rather than adding a second one. Forwarded as the client wrote it, because virtual hosting
    // depends on it; the CONNECT target is the fallback for an HTTP/1.0 client that sent none.
    outboundHeaders.host = req.headers.host ?? target.host;

    const requestBody = new Capture(maxCaptured);
    const upstream = httpsRequest({
      host: target.host,
      port: target.port,
      method: req.method ?? 'GET',
      path,
      headers: outboundHeaders,
      agent,
      // SNI is a name, never an address.
      ...(isIP(target.host) === 0 ? { servername: target.host } : {}),
      ...(originTrust ? { ca: originTrust } : {}),
    });

    req.on('data', (chunk: Buffer) => requestBody.add(chunk));

    const finished = new Promise<void>((resolve, reject) => {
      upstream.on('error', reject);
      upstream.on('response', (originRes) => {
        const responseHeaders: Record<string, string> = {};
        const outHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(originRes.headers)) {
          const key = name.toLowerCase();
          if (HOP_BY_HOP.has(key) || value === undefined) continue;
          outHeaders[name] = value;
          if (!SECRET_RESPONSE_HEADERS.has(key) && typeof value === 'string') {
            responseHeaders[key] = value;
          }
        }
        res.writeHead(originRes.statusCode ?? 502, outHeaders);

        // Tee, never buffer. A model reply arrives over seconds and the agent renders it as it
        // lands; reading it to completion first would make every turn appear to hang.
        const responseBody = new Capture(maxCaptured);
        originRes.on('data', (chunk: Buffer) => {
          responseBody.add(chunk);
          if (!res.write(chunk)) {
            originRes.pause();
            res.once('drain', () => originRes.resume());
          }
        });
        originRes.on('error', reject);
        originRes.on('end', () => {
          res.end();
          counters.intercepted += 1;
          options.onNetExchange?.({
            host: target.host,
            port: target.port,
            method: req.method ?? 'GET',
            path,
            requestHeaders: recordableHeaders,
            requestBody: requestBody.text(),
            requestTruncated: requestBody.truncated,
            status: originRes.statusCode ?? 0,
            responseHeaders,
            responseBody: responseBody.text(),
            responseTruncated: responseBody.truncated,
            responseBytes: responseBody.bytes,
            durationMs: Date.now() - startedAt,
          });
          resolve();
        });
      });
    });

    req.pipe(upstream);
    await finished;
  }

  function intercept(clientSocket: Socket, head: Buffer, target: Target): void {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) clientSocket.unshift(head);
    const secure = new TLSSocket(clientSocket, {
      isServer: true,
      secureContext: contextFor(target.host),
      // Pin HTTP/1.1. A client that offers h2 and gets no answer would otherwise speak HTTP/2
      // frames into an HTTP/1.1 parser.
      ALPNProtocols: ['http/1.1'],
    });
    targets.set(secure, target);
    open.add(secure);
    secure.on('close', () => open.delete(secure));
    secure.on('error', (err) => {
      // Usually the client rejecting our certificate, which is the correct outcome for a client
      // that was never told to trust this run. Report it; do not crash the recording.
      options.onFailure?.({ host: target.host, port: target.port, reason: String(err) });
      secure.destroy();
    });
    decrypted.emit('connection', secure);
  }

  function tunnel(clientSocket: Socket, head: Buffer, target: Target): void {
    const startedAt = Date.now();
    let bytesToOrigin = head.length;
    let bytesToClient = 0;
    let settled = false;

    // Counted at the decision, not at the close. The number an operator wants is "how many
    // connections did orca refuse to look inside", and a connection still open when the run ends
    // was refused just as firmly as one that closed.
    counters.tunnelled += 1;
    const origin = netConnect(target.port, target.host);
    open.add(origin);

    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      options.onTunnel?.({
        host: target.host,
        port: target.port,
        bytesToOrigin,
        bytesToClient,
        durationMs: Date.now() - startedAt,
        ...(error === undefined ? {} : { error }),
      });
    };

    origin.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) origin.write(head);
      // Byte counts only. Nothing here inspects, decodes or stores what passes through — that is
      // the entire promise a tunnel makes.
      clientSocket.on('data', (chunk: Buffer) => void (bytesToOrigin += chunk.length));
      origin.on('data', (chunk: Buffer) => void (bytesToClient += chunk.length));
      clientSocket.pipe(origin);
      origin.pipe(clientSocket);
    });
    origin.on('error', (err) => {
      if (!clientSocket.destroyed && !settled) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      finish(String(err));
      clientSocket.destroy();
      origin.destroy();
    });
    origin.on('close', () => {
      open.delete(origin);
      finish();
      clientSocket.destroy();
    });
    clientSocket.on('error', () => origin.destroy());
    clientSocket.on('close', () => origin.destroy());
  }

  server.on('connect', (req, clientSocket, head) => {
    open.add(clientSocket);
    clientSocket.on('close', () => open.delete(clientSocket));
    clientSocket.on('error', () => clientSocket.destroy());

    const target = parseTarget(req.url ?? '');
    if (!target) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    if (policy.allows(target.host, target.port)) {
      intercept(clientSocket, head, target);
    } else {
      tunnel(clientSocket, head, target);
    }
  });

  return {
    policy,
    close: () => {
      agent.destroy();
      for (const socket of open) socket.destroy();
      open.clear();
    },
  };
}

/** A bounded copy of a stream, so recording a large upload cannot exhaust memory. */
class Capture {
  readonly #chunks: Buffer[] = [];
  #captured = 0;
  #total = 0;
  #truncated = false;

  constructor(private readonly limit: number) {}

  add(chunk: Buffer): void {
    this.#total += chunk.length;
    const room = this.limit - this.#captured;
    if (room <= 0) {
      this.#truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.#chunks.push(chunk.subarray(0, room));
      this.#captured += room;
      this.#truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#captured += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  get bytes(): number {
    return this.#total;
  }
}
