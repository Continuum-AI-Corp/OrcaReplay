import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  connect as http2Connect,
  createSecureServer as createHttp2SecureServer,
  constants as H2,
  type ClientHttp2Session,
  type Http2SecureServer,
  type ServerHttp2Stream,
} from 'node:http2';
import { Agent, request as httpsRequest } from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { createSecureContext, rootCertificates, TLSSocket, type SecureContext } from 'node:tls';
import * as zlib from 'node:zlib';
import { AUTH_REQUEST_HEADERS, AUTH_RESPONSE_HEADERS, BINARY_BODY_PREFIX } from '@orcareplay/core';
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
  /**
   * Which application protocol the client negotiated: `h2`, `http/1.1`, or absent when the client
   * offered no ALPN at all.
   *
   * Recorded because the interceptor now speaks both, and which one a given agent picks is the
   * difference between two code paths. Without it, "did this run go through the h2 path" is a
   * question a trace cannot answer.
   */
  alpn?: string;
  durationMs: number;
}

/** A decrypted request before it is sent to the origin. */
export interface NetRequest {
  host: string;
  port: number;
  method: string;
  path: string;
  requestHeaders: Record<string, string>;
  /** The original bytes, needed for clients that use a binary content encoding such as zstd. */
  requestBytes: Buffer;
  requestTruncated: boolean;
}

/** A response supplied by replay for a request inside an intercepted TLS session. */
export interface InterceptResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

/** Decode a request body for model-dialect parsing while leaving forwarding byte-for-byte. */
/** Decode a recorded body, whichever of the two forms it was stored in. */
export function readRecordedBody(body: string): Buffer {
  return body.startsWith(BINARY_BODY_PREFIX)
    ? Buffer.from(body.slice(BINARY_BODY_PREFIX.length), 'base64')
    : Buffer.from(body, 'utf8');
}

export function decodeRequestBody(bytes: Buffer, contentEncoding?: string): string {
  const encoding = contentEncoding?.split(',')[0]?.trim().toLowerCase();
  if (encoding === 'zstd') {
    // zstd was added to Node's built-in zlib API after the oldest runtime Orca supports. Keep the
    // import compatible there; a Codex call degrades to opaque net capture with a clear error.
    const decompress = (
      zlib as typeof zlib & {
        zstdDecompressSync?: (input: Buffer) => Buffer;
      }
    ).zstdDecompressSync;
    if (!decompress)
      throw new Error('zstd request encoding requires a Node runtime with zstd support');
    return recordableBody(decompress(bytes));
  }
  return recordableBody(bytes);
}

/** Text when the bytes are text, base64 behind a marker when they are not. */
function recordableBody(bytes: Buffer): string {
  const asText = bytes.toString('utf8');
  if (Buffer.compare(Buffer.from(asText, 'utf8'), bytes) === 0) return asText;
  return `${BINARY_BODY_PREFIX}${bytes.toString('base64')}`;
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
  /** Answer a decrypted request from a recording. Undefined falls through to the live origin. */
  onRequest?: (
    request: NetRequest,
  ) => InterceptResponse | undefined | Promise<InterceptResponse | undefined>;
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
  /**
   * The same answer as `targets`, reachable from an h2 session.
   *
   * `session.socket` is a Proxy standing in for the real socket, so it is never a key `targets`
   * knows -- the lookup silently missed and every h2 stream was rejected as arriving on an unknown
   * connection. A property on the socket survives the Proxy, which forwards unknown reads through.
   */
  const TARGET = Symbol('orca.intercept.target');
  /**
   * Which origin a decrypted request was destined for.
   *
   * Two indirections to get through, both of them somebody else's wrapper. The h2 server hands out
   * a Proxy in place of the socket, which forwards unknown property reads to the real one; and the
   * socket it terminated is a `TLSSocket` wrapping the socket we tagged, reachable as `_parent`.
   */
  const targetOf = (socket: unknown): Target | undefined => {
    let cursor: unknown = socket;
    for (let depth = 0; depth < 4 && typeof cursor === 'object' && cursor !== null; depth += 1) {
      const own = (cursor as Record<symbol, Target | undefined>)[TARGET] ?? targets.get(cursor);
      if (own) return own;
      cursor = (cursor as { _parent?: unknown })._parent;
    }
    return undefined;
  };
  const open = new Set<Socket | TLSSocket>();

  /**
   * A protocol switch inside a session we decrypted — a WebSocket, usually.
   *
   * Not relayed: this proxy understands request/response exchanges and nothing else, and a
   * half-implemented WebSocket relay would drop frames rather than fail. Refusing outright and
   * saying so leaves the operator with a message instead of a hang, and the remedy is to take the
   * host off the allowlist so the whole connection is tunnelled untouched instead.
   */
  const onUpgrade = (req: IncomingMessage, socket: Socket): void => {
    const target = targetOf(req.socket);
    options.onFailure?.({
      host: target?.host ?? 'unknown',
      port: target?.port ?? 0,
      reason: `orca cannot relay an ${String(req.headers.upgrade)} upgrade through an intercepted connection`,
    });
    socket.end('HTTP/1.1 501 Not Implemented\r\nconnection: close\r\n\r\n');
  };

  /**
   * One upstream h2 session per origin, reused across streams the way `Agent` is for HTTP/1.1.
   *
   * `ALPNProtocols: ['h2']` on purpose: this session exists only because the client asked for h2,
   * and an origin answering `http/1.1` here would leave us holding a session that cannot carry the
   * request. Failing loudly beats forwarding into a protocol mismatch.
   */
  const h2Upstreams = new Map<string, ClientHttp2Session>();

  function upstreamH2(target: Target): ClientHttp2Session {
    const key = `${target.host}:${target.port}`;
    const existing = h2Upstreams.get(key);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2Connect(`https://${target.host}:${target.port}`, {
      ALPNProtocols: ['h2'],
      ...(originTrust ? { ca: originTrust } : {}),
    });
    session.on('error', (err) => {
      options.onFailure?.({ host: target.host, port: target.port, reason: String(err) });
      h2Upstreams.delete(key);
    });
    session.on('close', () => h2Upstreams.delete(key));
    h2Upstreams.set(key, session);
    return session;
  }

  /**
   * One TLS-terminating server per intercepted host, and the reason it is a server rather than a
   * socket we terminate ourselves.
   *
   * The obvious shape -- `new TLSSocket({ isServer: true })`, then hand the decrypted socket to an
   * HTTP server -- works for HTTP/1.1 and silently does not for h2. An `Http2Session` takes over
   * the socket's handle rather than reading the stream, so the client's connection preface and its
   * first PING, already buffered by the time the handshake callback runs, are never seen: the
   * session establishes, nothing flows, and the client gives up with a keepalive timeout. Verified
   * on a loopback with no agent involved. Letting the h2 server do the TLS itself is what fixes
   * it, and `allowHTTP1` keeps one server able to serve both.
   *
   * Per host rather than one server with `SNICallback`, so the certificate is still chosen by the
   * CONNECT target exactly as before. SNI would work for every client that sends it and quietly
   * pick the wrong certificate for one that does not.
   */
  const h2Servers = new Map<string, Http2SecureServer>();

  function serverFor(host: string): Http2SecureServer {
    const cached = h2Servers.get(host);
    if (cached) return cached;
    const issued = options.ca.issue(host);
    const server = createHttp2SecureServer({
      key: issued.keyPem,
      cert: issued.certPem,
      allowHTTP1: true,
      ALPNProtocols: ['h2', 'http/1.1'],
    });

    // An h2 request emits both `stream` and `request` when `allowHTTP1` is set, so `request` has
    // to serve HTTP/1.1 only or the same exchange is answered twice and the second attempt throws
    // ERR_HTTP2_HEADERS_SENT.
    server.on('request', (req, res) => {
      // The event is typed for h2 because the server can serve it, but `allowHTTP1` means an
      // HTTP/1.1 session delivers the node:http pair instead. The version check above is what
      // makes the cast true rather than hopeful.
      if (req.httpVersionMajor >= 2) return;
      const req1 = req as unknown as IncomingMessage;
      const res1 = res as unknown as ServerResponse;
      void forward(req1, res1).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `orca tls-intercept: ${String(err)}` } }));
      });
    });

    server.on('stream', (stream: ServerHttp2Stream, headers) => {
      void forwardH2(stream, headers).catch((err: unknown) => {
        // Reported as well as answered, because the guard below returns without writing anything
        // when the client has already gone -- and a failure nobody is left to receive is exactly
        // the one worth having in the run's failure list.
        reportH2(stream.session?.socket, err, 'forward');
        // Guarded for the same reason as the response path: by the time a failure surfaces the
        // client may be gone, and respond/end would then throw out of a rejection handler.
        if (stream.destroyed) return;
        try {
          if (!stream.headersSent) stream.respond({ ':status': 502 });
          stream.end(JSON.stringify({ error: { message: `orca tls-intercept h2: ${String(err)}` } }));
        } catch {
          stream.destroy();
        }
      });
    });

    server.on('upgrade', onUpgrade);
    server.on('tlsClientError', (err, socket) => reportH2(socket, err));
    server.on('sessionError', (err, session) => reportH2(session?.socket, err));
    server.on('clientError', (err, socket) => reportH2(socket, err));
    server.on('error', (err) => reportH2(undefined, err));
    server.on('session', (session) => {
      session.on('error', (err) => reportH2(session.socket, err));
    });

    h2Servers.set(host, server);
    return server;
  }

  /**
   * Errors inside an h2 session, reported rather than swallowed.
   *
   * Without these the only symptom of a session that never became usable was the *client*
   * complaining -- "HTTP/2 keepalive ping timed out" -- with nothing on this side saying why, which
   * is the same blindness the HTTP/1.1 path avoids by reporting handshake failures.
   */
  const reportH2 = (socket: unknown, reason: unknown, what = 'session'): void => {
    const target = targetOf(socket);
    options.onFailure?.({
      host: target?.host ?? 'unknown',
      port: target?.port ?? 0,
      reason: `h2 ${what}: ${String(reason)}`,
    });
  };
  /**
   * The h2 twin of `forward`, recording the same exchange.
   *
   * Two differences from HTTP/1.1, both protocol rules rather than choices: the method, path and
   * authority arrive as `:`-prefixed pseudo-headers and have to be rebuilt rather than copied, and
   * h2 forbids the hop-by-hop headers outright, so passing one through is an error rather than
   * merely being wrong.
   */
  async function forwardH2(
    stream: ServerHttp2Stream,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    // `session` is optional on the type because a stream outlives a destroyed session; a stream
    // being served cannot have lost it, but the lookup needs a socket either way.
    const target = stream.session ? targetOf(stream.session.socket) : undefined;
    if (!target) throw new Error('decrypted h2 stream arrived on an unknown connection');

    const startedAt = Date.now();
    const method = String(headers[H2.HTTP2_HEADER_METHOD] ?? 'GET');
    const path = String(headers[H2.HTTP2_HEADER_PATH] ?? '/');
    const outbound: Record<string, string | string[]> = {
      [H2.HTTP2_HEADER_METHOD]: method,
      [H2.HTTP2_HEADER_PATH]: path,
      [H2.HTTP2_HEADER_SCHEME]: 'https',
      [H2.HTTP2_HEADER_AUTHORITY]: String(
        headers[H2.HTTP2_HEADER_AUTHORITY] ?? `${target.host}:${target.port}`,
      ),
    };
    const recordableHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase();
      if (key.startsWith(':') || HOP_BY_HOP.has(key) || value === undefined) continue;
      outbound[key] = value;
      if (!SECRET_REQUEST_HEADERS.has(key) && typeof value === 'string') {
        recordableHeaders[key] = value;
      }
    }

    const requestBody = new Capture(maxCaptured);
    const responseBody = new Capture(maxCaptured);
    const contentEncoding =
      typeof headers['content-encoding'] === 'string' ? headers['content-encoding'] : undefined;

    // Replay answers from the recording and must never reach the origin. The HTTP/1.1 twin has
    // consulted this hook since interception existed; without the same call here, a run recorded
    // over HTTP/1.1 and replayed by a client that now negotiates h2 would be forwarded live --
    // real model calls, on the caller's own credential, during what the operator ran offline.
    if (options.onRequest) {
      for await (const chunk of stream) requestBody.add(Buffer.from(chunk as Buffer));
      const reply = await options.onRequest({
        host: target.host,
        port: target.port,
        method,
        path,
        requestHeaders: recordableHeaders,
        requestBytes: requestBody.buffer(),
        requestTruncated: requestBody.truncated,
      });
      if (reply) {
        if (stream.destroyed) return;
        stream.respond({ ':status': reply.status, ...(reply.headers ?? {}) });
        stream.end(reply.body);
        counters.intercepted += 1;
        return;
      }
      // The bounded capture size is also the maximum replayable request size: forwarding a
      // truncated body upstream is worse than refusing clearly, which is what HTTP/1.1 does.
      if (requestBody.truncated) {
        throw new Error(`request exceeded capture limit of ${maxCaptured} bytes`);
      }
    }

    await new Promise<void>((resolve, reject) => {
      const upstream = upstreamH2(target).request(outbound);
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      /**
       * The client can go at any point, and every write after that throws.
       *
       * `stream.respond` on a destroyed stream raises ERR_HTTP2_INVALID_STREAM synchronously from
       * inside an upstream event callback, where nothing catches it: the promise is already
       * constructed, so the throw is an uncaught exception and the proxy exits. Reproduced against
       * Node 22 with a client RST at 60 ms and an origin answering at 400 ms.
       */
      const abandon = (): void => {
        upstream.destroy();
        finish();
      };
      stream.on('aborted', abandon);
      stream.on('close', abandon);

      if (options.onRequest) {
        // The hook above consumed the body, so replay the bytes it read rather than the stream.
        upstream.end(requestBody.buffer());
      } else {
        stream.on('data', (chunk: Buffer) => {
          requestBody.add(chunk);
          if (!upstream.write(chunk)) {
            stream.pause();
            upstream.once('drain', () => stream.resume());
          }
        });
        // Without this, a client that aborts mid-upload never emits `end`, `upstream.end()` is
        // never called, and the origin waits for a body that will not arrive.
        stream.on('end', () => upstream.end());
      }
      stream.on('error', reject);

      upstream.on('error', reject);
      upstream.on('response', (responseHeaders) => {
        const status = Number(responseHeaders[H2.HTTP2_HEADER_STATUS] ?? 0);
        const recordableResponse: Record<string, string> = {};
        const downstream: Record<string, string | string[] | number> = { ':status': status };
        for (const [name, value] of Object.entries(responseHeaders)) {
          const key = name.toLowerCase();
          if (key.startsWith(':') || HOP_BY_HOP.has(key) || value === undefined) continue;
          downstream[key] = value;
          if (!SECRET_RESPONSE_HEADERS.has(key) && typeof value === 'string') {
            recordableResponse[key] = value;
          }
        }
        if (stream.destroyed) {
          abandon();
          return;
        }
        stream.respond(downstream);

        // Tee, never buffer, for the same reason as HTTP/1.1: a model reply arrives over seconds
        // and the agent renders it as it lands.
        upstream.on('data', (chunk: Buffer) => {
          responseBody.add(chunk);
          if (stream.destroyed) {
            abandon();
            return;
          }
          if (!stream.write(chunk)) {
            // `drain` never fires on a destroyed stream, so a client that goes mid-response would
            // otherwise leave upstream paused for good and the exchange never recorded.
            upstream.pause();
            stream.once('drain', () => upstream.resume());
          }
        });
        upstream.on('end', () => {
          if (settled) return;
          if (!stream.destroyed) stream.end();
          counters.intercepted += 1;
          // A body orca cannot decode is still an exchange worth having. `decodeRequestBody`
          // throws for zstd on a runtime without it -- inside `engines`, and why the repo's own
          // zstd test is skipped there -- and an exception in this callback would take the process
          // down with the exchange unrecorded. server.ts already decodes inside a try/catch for
          // the same reason.
          let recordedRequest: string;
          try {
            recordedRequest = decodeRequestBody(requestBody.buffer(), contentEncoding);
          } catch (err) {
            options.onFailure?.({
              host: target.host,
              port: target.port,
              reason: `request body left opaque: ${String(err)}`,
            });
            recordedRequest = requestBody.text();
          }
          options.onNetExchange?.({
            host: target.host,
            port: target.port,
            method,
            path,
            requestHeaders: recordableHeaders,
            requestBody: recordedRequest,
            requestTruncated: requestBody.truncated,
            status,
            alpn: 'h2',
            responseHeaders: recordableResponse,
            responseBody: responseBody.text(),
            responseTruncated: responseBody.truncated,
            responseBytes: responseBody.bytes,
            durationMs: Date.now() - startedAt,
          });
          finish();
        });
      });
    });
  }

  /** The negotiated protocol, looked up through the TLS wrapper the server put in place. */
  const alpnOf = (socket: unknown): string | undefined => {
    let cursor: unknown = socket;
    for (let depth = 0; depth < 4 && typeof cursor === 'object' && cursor !== null; depth += 1) {
      const value = (cursor as { alpnProtocol?: unknown }).alpnProtocol;
      if (typeof value === 'string') return value;
      cursor = (cursor as { _parent?: unknown })._parent;
    }
    return undefined;
  };

  function contextFor(host: string): SecureContext {
    const cached = contexts.get(host);
    if (cached) return cached;
    const issued = options.ca.issue(host);
    const context = createSecureContext({ key: issued.keyPem, cert: issued.certPem });
    contexts.set(host, context);
    return context;
  }

  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = targetOf(req.socket);
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

    // Replay has to decide before opening an origin connection. Buffer only when that hook is in
    // use; the recording path below retains the original streaming behaviour and bounded capture.
    if (options.onRequest) {
      for await (const chunk of req) requestBody.add(Buffer.from(chunk as Buffer));
      const reply = await options.onRequest({
        host: target.host,
        port: target.port,
        method: req.method ?? 'GET',
        path,
        requestHeaders: recordableHeaders,
        requestBytes: requestBody.buffer(),
        requestTruncated: requestBody.truncated,
      });
      if (reply) {
        res.writeHead(reply.status, reply.headers ?? {});
        res.end(reply.body);
        counters.intercepted += 1;
        return;
      }
    }

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

    if (options.onRequest) {
      // The hook consumed the request. The bounded size is deliberately also the maximum replay
      // request size; sending a truncated body upstream would be worse than a clear failure.
      if (requestBody.truncated) {
        upstream.destroy(new Error(`request exceeded capture limit of ${maxCaptured} bytes`));
      } else {
        upstream.end(requestBody.buffer());
      }
    } else {
      req.on('data', (chunk: Buffer) => requestBody.add(chunk));
      req.pipe(upstream);
    }

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
            requestBody: decodeRequestBody(
              requestBody.buffer(),
              typeof req.headers['content-encoding'] === 'string'
                ? req.headers['content-encoding']
                : undefined,
            ),
            requestTruncated: requestBody.truncated,
            status: originRes.statusCode ?? 0,
            alpn: alpnOf(req.socket),
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

    await finished;
  }

  function intercept(clientSocket: Socket, head: Buffer, target: Target): void {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) clientSocket.unshift(head);
    // Tagged before the handover, because the server wraps this socket in a TLSSocket of its own
    // and the request that comes back out carries the wrapper, not this.
    (clientSocket as unknown as Record<symbol, Target>)[TARGET] = target;
    serverFor(target.host).emit('connection', clientSocket);
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
      for (const session of h2Upstreams.values()) session.destroy();
      h2Upstreams.clear();
      for (const server of h2Servers.values()) server.close();
      h2Servers.clear();
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

  /**
   * The captured bytes as something a trace can hold.
   *
   * Text when the bytes are text, and base64 behind a marker when they are not. `toString('utf8')`
   * on a binary body replaces every invalid sequence with U+FFFD and is not reversible: a Connect
   * protobuf body came back with 974 replacement characters in 8,459 bytes, which is enough to
   * make the payload undecodable while still looking like it was captured. The round-trip test is
   * what tells the two cases apart.
   */
  text(): string {
    return recordableBody(Buffer.concat(this.#chunks));
  }

  buffer(): Buffer {
    return Buffer.concat(this.#chunks);
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  get bytes(): number {
    return this.#total;
  }
}
