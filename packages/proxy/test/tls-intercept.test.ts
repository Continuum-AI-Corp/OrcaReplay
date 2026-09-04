import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connect as h2Connect,
  createSecureServer as createHttp2Origin,
  type Http2SecureServer,
  type ClientHttp2Session,
} from 'node:http2';
import type { IncomingHttpHeaders } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunCa } from '../src/ca.js';

/**
 * zstd landed in Node's `zlib` after the oldest runtime this CLI supports, so on Node 20 the named
 * import was simply `undefined` and the test below died on `zstdCompressSync is not a function` —
 * a red build on every pull request, saying nothing about the change that triggered it.
 *
 * Looked up dynamically, the same way `decodeRequestBody` looks up the other half of the pair, so
 * the module still loads. Skipped rather than deleted: the behaviour is real on the runtimes that
 * have zstd, and a skipped test names the runtime that is missing something where a deleted one
 * would just be gone.
 */
const zstdCompressSync = (zlib as typeof zlib & { zstdCompressSync?: (input: Buffer) => Buffer })
  .zstdCompressSync;
import {
  createProxy,
  type NetExchange,
  type ProxyHandle,
  type TunnelRecord,
} from '../src/server.js';
import type { RecordedExchange } from '../src/server.js';
import { defaultDialects } from '../src/server.js';

/**
 * The interception itself, driven the way a real agent drives it: an HTTP `CONNECT` to the proxy,
 * a TLS handshake on the tunnel, and an HTTP request inside it.
 *
 * Two origins run throughout — one the run is allowed to decrypt, one it is not — and both are
 * real HTTPS servers with their own certificates. That is what makes the negative case meaningful:
 * the un-allowlisted origin is reached with *its own* certificate, over a connection orca could
 * not read even if it wanted to.
 */

/** Where the client is pointed and what it is willing to trust. */
interface ProxiedRequest {
  proxyPort: number;
  host: string;
  port: number;
  trust: string[];
  method?: string;
  path?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
  onFirstChunk?: (chunk: string) => void;
}

interface ProxiedResponse {
  status: number;
  body: string;
  /** Who signed the certificate the client actually saw. The tell for "was this decrypted?". */
  peerIssuer: string;
}

/** CONNECT, then TLS over the tunnel, then one HTTP request — a proxy-aware client in 30 lines. */
/**
 * A client that stops reading before the response is over.
 *
 * `through` resolves on `end`, which is the one thing this case never reaches. A harness reading a
 * streaming reply only until it has its answer -- and one that gives up before the origin answers
 * at all -- both leave the exchange half-finished, and half-finished is what has to be recorded.
 * Returns whatever arrived before the client walked away.
 */
async function abandoned(
  opts: ProxiedRequest & { leaveAfter: 'first-chunk' | 'request' },
): Promise<string> {
  const target = `${opts.host}:${opts.port}`;
  const tunnel = httpRequest({
    host: '127.0.0.1',
    port: opts.proxyPort,
    method: 'CONNECT',
    path: target,
    headers: { host: target },
  });
  tunnel.end();

  const [res, socket, head] = (await once(tunnel, 'connect')) as [IncomingMessage, Socket, Buffer];
  if (res.statusCode !== 200) {
    socket.destroy();
    throw new Error(`CONNECT refused: ${res.statusCode}`);
  }
  if (head.length > 0) socket.unshift(head);

  const secure = tlsConnect({ socket, ca: opts.trust, host: opts.host, port: opts.port });
  await once(secure, 'secureConnect');

  return await new Promise<string>((resolve) => {
    let seen = '';
    const req = httpRequest(
      {
        createConnection: () => secure,
        host: opts.host,
        port: opts.port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: { host: target, ...opts.headers },
      },
      (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          seen += chunk;
          if (opts.leaveAfter === 'first-chunk') {
            secure.destroy();
            resolve(seen);
          }
        });
      },
    );
    // No `error` rejection: tearing the socket down is the behaviour under test, so the errors it
    // raises on this side are the expected consequence rather than a failure.
    req.on('error', () => undefined);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
    if (opts.leaveAfter === 'request') {
      // Gone while the origin is still thinking. One beat first, so the request is on the wire
      // before the socket goes -- that is what makes the recorded request body non-empty.
      setTimeout(() => {
        secure.destroy();
        resolve(seen);
      }, 150);
    }
  });
}

/** Long enough for the proxy to notice the client left and file what it had. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

async function through(opts: ProxiedRequest): Promise<ProxiedResponse> {
  const target = `${opts.host}:${opts.port}`;
  const tunnel = httpRequest({
    host: '127.0.0.1',
    port: opts.proxyPort,
    method: 'CONNECT',
    path: target,
    headers: { host: target },
  });
  tunnel.end();

  const [res, socket, head] = (await once(tunnel, 'connect')) as [IncomingMessage, Socket, Buffer];
  if (res.statusCode !== 200) {
    socket.destroy();
    throw new Error(`CONNECT refused: ${res.statusCode}`);
  }
  if (head.length > 0) socket.unshift(head);

  const secure = tlsConnect({ socket, ca: opts.trust, host: opts.host, port: opts.port });
  try {
    await once(secure, 'secureConnect');
  } catch (err) {
    secure.destroy();
    throw err;
  }
  if (!secure.authorized) {
    const reason = secure.authorizationError;
    secure.destroy();
    throw reason ?? new Error('unauthorized');
  }
  const peerIssuer = String(secure.getPeerCertificate().issuer.CN ?? '');

  return await new Promise<ProxiedResponse>((resolve, reject) => {
    const req = httpRequest(
      {
        createConnection: () => secure,
        host: opts.host,
        port: opts.port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: { host: target, ...opts.headers },
      },
      (response) => {
        let body = '';
        let first = true;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
          if (first) {
            first = false;
            opts.onFirstChunk?.(chunk);
          }
        });
        response.on('end', () => {
          secure.destroy();
          resolve({ status: response.statusCode ?? 0, body, peerIssuer });
        });
      },
    );
    req.on('error', (err) => {
      secure.destroy();
      reject(err);
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** The CN a client sees as the issuer of whatever certificate it was handed. */
function commonName(certPem: string): string {
  return /CN=(.*)/.exec(new X509Certificate(certPem).subject)?.[1] ?? '';
}

/**
 * The same idea as `startOrigin`, over HTTP/2.
 *
 * A separate helper rather than an option on the first one, because an h2 origin answers on
 * `stream` rather than with a request/response pair, and because the interesting cases here are
 * about *when* it answers: `delayMs` lets the origin reply after the client has already gone,
 * which is the shape that used to take the proxy down.
 */
async function startH2Origin(
  ca: RunCa,
  opts: { delayMs?: number; onStream?: (headers: IncomingHttpHeaders) => void } = {},
): Promise<{ port: number; hits: number; close: () => Promise<void> }> {
  const issued = ca.issue('127.0.0.1');
  const server: Http2SecureServer = createHttp2Origin({
    key: issued.keyPem,
    cert: issued.certPem,
  });
  const state = { hits: 0 };
  // Tracked so `close` can force them down. `server.close()` waits for open sessions, and the
  // proxy holds its upstream h2 session in a cache until the whole handle is closed -- so an
  // origin waiting politely deadlocks the teardown.
  const sessions = new Set<{ destroy: () => void }>();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    state.hits += 1;
    opts.onStream?.(headers);
    stream.on('error', () => undefined);
    stream.on('data', () => undefined);
    const answer = (): void => {
      if (stream.destroyed) return;
      stream.respond({ ':status': 200, 'content-type': 'text/plain' });
      stream.end('from-origin');
    };
    stream.on('end', () => {
      if (opts.delayMs) setTimeout(answer, opts.delayMs);
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    get hits() {
      return state.hits;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) session.destroy();
        sessions.clear();
        server.close(() => resolve());
      }),
  };
}

/** An h2 session to `host:port` through the proxy's CONNECT tunnel. */
async function h2Through(opts: {
  proxyPort: number;
  host: string;
  port: number;
  trust: string[];
}): Promise<ClientHttp2Session> {
  const target = `${opts.host}:${opts.port}`;
  const tunnel = httpRequest({
    host: '127.0.0.1',
    port: opts.proxyPort,
    method: 'CONNECT',
    path: target,
    headers: { host: target },
  });
  tunnel.end();
  const [res, socket, head] = (await once(tunnel, 'connect')) as [IncomingMessage, Socket, Buffer];
  if (res.statusCode !== 200) {
    socket.destroy();
    throw new Error(`CONNECT refused: ${res.statusCode}`);
  }
  if (head.length > 0) socket.unshift(head);
  // The TLS handshake is done here rather than left to `http2.connect`: given a
  // `createConnection`, http2 uses that stream as the transport as-is and adds no encryption, so
  // an unwrapped socket would speak cleartext h2 frames at a TLS server.
  const secure = tlsConnect({
    socket,
    ca: opts.trust,
    host: opts.host,
    port: opts.port,
    ALPNProtocols: ['h2'],
  });
  await once(secure, 'secureConnect');
  const session = h2Connect(`https://${target}`, { createConnection: () => secure });
  session.on('error', () => undefined);
  await once(session, 'connect');
  return session;
}

type OriginHandler = Parameters<typeof createHttpsServer>[1];

async function startOrigin(
  ca: RunCa,
  handler: OriginHandler,
): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const issued = ca.issue('127.0.0.1');
  const server: HttpsServer = createHttpsServer(
    { key: issued.keyPem, cert: issued.certPem },
    handler,
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => void server.close(() => resolve())),
  };
}

describe('TLS interception', () => {
  let runDir: string;
  let originDir: string;
  /** The run's own CA — the one an intercepted client has to trust. */
  let runCa: RunCa;
  /** A stand-in for the public web's CAs, so the origins have credible certificates of their own. */
  let originCa: RunCa;
  let model: Awaited<ReturnType<typeof startOrigin>>;
  let bank: Awaited<ReturnType<typeof startOrigin>>;
  let proxy: ProxyHandle | undefined;
  let netExchanges: NetExchange[];
  let tunnels: TunnelRecord[];
  let modelExchanges: RecordedExchange[];
  let release: (() => void) | undefined;
  /** What the origin actually received, so "forwarded" can be asserted without echoing it back. */
  let originSawAuth: string | undefined;
  /** The same, for the headers a provider attributes traffic by. */
  let originSawAttribution: Record<string, string | undefined>;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'orca-mitm-run-'));
    originDir = await mkdtemp(join(tmpdir(), 'orca-mitm-origin-'));
    runCa = await RunCa.create({ runDir });
    originCa = await RunCa.create({ runDir: originDir });
    netExchanges = [];
    tunnels = [];
    modelExchanges = [];
    originSawAuth = undefined;
    originSawAttribution = {};

    model = await startOrigin(originCa, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => void chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: first\n\n');
          // Held until the client confirms it saw the first chunk. A proxy that buffered the
          // whole response before forwarding a byte would deadlock here rather than pass.
          void new Promise<void>((resolve) => {
            release = resolve;
          }).then(() => {
            res.write('data: second\n\n');
            res.end();
          });
          return;
        }
        if (req.url === '/v1/chat/completions' && req.headers['x-test-hold'] !== undefined) {
          // Held before a single response header is written, which is the state a client that
          // gives up early leaves the exchange in: a request orca decrypted and a response that
          // never began. Released in `afterEach` along with `/stream`.
          void new Promise<void>((resolve) => {
            release = resolve;
          }).then(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
          });
          return;
        }
        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion',
              model: 'gpt-5.2',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
            }),
          );
          return;
        }
        originSawAuth = req.headers.authorization;
        originSawAttribution = {
          'http-referer': req.headers['http-referer'] as string | undefined,
          'x-title': req.headers['x-title'] as string | undefined,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ saw: body, path: req.url }));
      });
    });

    bank = await startOrigin(originCa, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ balance: 'SUPER-SECRET-BALANCE-42' }));
    });
  });

  afterEach(async () => {
    release?.();
    await proxy?.close();
    proxy = undefined;
    await model.close();
    await bank.close();
    await runCa.dispose();
    await originCa.dispose();
    await rm(runDir, { recursive: true, force: true });
    await rm(originDir, { recursive: true, force: true });
  });

  async function startProxy(hosts: string[]): Promise<ProxyHandle> {
    proxy = await createProxy({
      mode: 'record',
      onExchange: (e) => void modelExchanges.push(e),
      tls: {
        ca: runCa,
        hosts,
        // The origins here are signed by a CA no machine trusts, exactly as a corporate
        // TLS-inspecting middlebox would be. Verification of the origin stays on either way.
        trustedOriginCerts: [originCa.certPem],
        onNetExchange: (e) => void netExchanges.push(e),
        onTunnel: (t) => void tunnels.push(t),
      },
    });
    return proxy;
  }

  /**
   * HTTP/2, which reaches a different forwarder inside the interceptor.
   *
   * These exist because the h2 path was added without them and three failures followed from that:
   * a replay that went live, a late origin response that killed the process, and an undecodable
   * body that did the same. Each test below is one of those.
   */
  describe('over HTTP/2', () => {
    let h2Origin: Awaited<ReturnType<typeof startH2Origin>>;

    afterEach(async () => {
      await h2Origin?.close();
    });

    /** `createProxy` with a replay hook, which is what makes the origin off-limits. */
    async function startReplayProxy(
      hosts: string[],
      reply: (path: string) => { status: number; headers?: Record<string, string>; body: string },
    ): Promise<ProxyHandle> {
      proxy = await createProxy({
        mode: 'record',
        onExchange: (e) => void modelExchanges.push(e),
        tls: {
          ca: runCa,
          hosts,
          trustedOriginCerts: [originCa.certPem],
          onNetExchange: (e) => void netExchanges.push(e),
          onRequest: async (req) => reply(req.path),
        },
      });
      return proxy;
    }

    /**
     * The same guarantee over h2, which is the path that actually matters here: `openrouter.ai`
     * negotiates h2, so every OpenRouter-attributed request reaches the interceptor through
     * `forwardH2` rather than the HTTP/1.1 forwarder. The two forwarders build their header maps
     * separately, so the property has to be pinned on both or it holds only where it was tested.
     */
    it('forwards the app attribution headers untouched over h2 too', async () => {
      const referer = 'https://github.com/Continuum-AI-Corp/OrcaReplay';
      const title = 'Some Coding Agent';
      let seen: IncomingHttpHeaders = {};
      h2Origin = await startH2Origin(originCa, { onStream: (h) => void (seen = h) });
      const handle = await startProxy([`127.0.0.1:${h2Origin.port}`]);

      const session = await h2Through({
        proxyPort: handle.port,
        host: '127.0.0.1',
        port: h2Origin.port,
        trust: [runCa.certPem],
      });
      const request = session.request({
        ':method': 'POST',
        ':path': '/v1/embeddings',
        authorization: 'Bearer sk-live-abcdefghijklmnop',
        'http-referer': referer,
        'x-title': title,
      });
      request.on('error', () => undefined);
      // The response has to be drained, or h2 flow control keeps the stream open and `close`
      // never fires.
      request.setEncoding('utf8');
      request.on('data', () => undefined);
      request.end('{}');
      await once(request, 'close');
      session.destroy();

      expect(seen['http-referer']).toBe(referer);
      expect(seen['x-title']).toBe(title);
      const recorded = netExchanges.find((e) => e.path === '/v1/embeddings');
      expect(recorded?.requestHeaders['http-referer']).toBe(referer);
      expect(recorded?.requestHeaders['x-title']).toBe(title);
      expect(recorded?.requestHeaders.authorization).toBeUndefined();
    });

    it('answers from the replay hook without opening a connection to the origin', async () => {
      h2Origin = await startH2Origin(originCa);
      const handle = await startReplayProxy([`127.0.0.1:${h2Origin.port}`], () => ({
        status: 418,
        headers: { 'content-type': 'text/plain' },
        body: 'from-recording',
      }));

      const session = await h2Through({
        proxyPort: handle.port,
        host: '127.0.0.1',
        port: h2Origin.port,
        trust: [runCa.certPem],
      });
      const request = session.request({ ':method': 'POST', ':path': '/replay' });
      let status = 0;
      let body = '';
      request.on('response', (h) => void (status = Number(h[':status'])));
      request.setEncoding('utf8');
      request.on('data', (c: string) => void (body += c));
      request.end('hello');
      await once(request, 'close');
      session.destroy();

      expect(status).toBe(418);
      expect(body).toBe('from-recording');
      // The point of the whole test: a strict replay must not reach the provider.
      expect(h2Origin.hits).toBe(0);
    });

    it('survives an origin response that arrives after the client has gone', async () => {
      let answered = false;
      // Waited for rather than slept past. The assertion below is that the origin saw the stream,
      // and the proxy has to complete a TLS handshake and open an h2 session upstream before it
      // can — so a fixed 40ms was a bet on how long that takes. It came in under the wire on one
      // CI runner and not on another, and `expected +0 to be 1` is what losing that bet looks
      // like. Shortening the sleep to zero reproduces it three times out of three.
      let sawStream = (): void => undefined;
      const streamReached = new Promise<void>((resolve) => {
        sawStream = resolve;
      });
      h2Origin = await startH2Origin(originCa, { delayMs: 250, onStream: () => sawStream() });
      const handle = await startProxy([`127.0.0.1:${h2Origin.port}`]);

      const session = await h2Through({
        proxyPort: handle.port,
        host: '127.0.0.1',
        port: h2Origin.port,
        trust: [runCa.certPem],
      });
      const request = session.request({ ':method': 'POST', ':path': '/abort' });
      request.on('error', () => undefined);
      request.end('hello');
      await streamReached;
      // The client gives up while the origin is still thinking. Responding on this stream
      // afterwards raises ERR_HTTP2_INVALID_STREAM from inside an event callback, which used to
      // be an uncaught exception and took the proxy process with it.
      request.destroy();
      await new Promise((r) => setTimeout(r, 500));
      answered = true;
      session.destroy();

      expect(answered).toBe(true);
      expect(h2Origin.hits).toBe(1);
    });

    it('records an h2 exchange the client abandoned before the origin answered', async () => {
      // The test above proves the proxy survives this. This one proves the run remembers it.
      let sawStream = (): void => undefined;
      const streamReached = new Promise<void>((resolve) => {
        sawStream = resolve;
      });
      h2Origin = await startH2Origin(originCa, { delayMs: 250, onStream: () => sawStream() });
      const handle = await startProxy([`127.0.0.1:${h2Origin.port}`]);

      const session = await h2Through({
        proxyPort: handle.port,
        host: '127.0.0.1',
        port: h2Origin.port,
        trust: [runCa.certPem],
      });
      const request = session.request({ ':method': 'POST', ':path': '/abort' });
      request.on('error', () => undefined);
      request.end('hello');
      await streamReached;
      request.destroy();
      await new Promise((r) => setTimeout(r, 500));
      session.destroy();

      expect(netExchanges).toHaveLength(1);
      expect(netExchanges[0]!.abandoned).toBe(true);
      expect(netExchanges[0]!.alpn).toBe('h2');
      // The request reached the origin, so the bytes the agent sent are the part worth keeping.
      expect(netExchanges[0]!.requestBody).toBe('hello');
      expect(netExchanges[0]!.status).toBe(0);
    });

    it('records an exchange whose request body it cannot decode', async () => {
      h2Origin = await startH2Origin(originCa);
      const handle = await startProxy([`127.0.0.1:${h2Origin.port}`]);
      const failures: string[] = [];
      // `onFailure` is the channel the opaque case reports on, and the proxy under test already
      // has one wired by `startProxy`; this asserts the exchange, which is the load-bearing half.

      const session = await h2Through({
        proxyPort: handle.port,
        host: '127.0.0.1',
        port: h2Origin.port,
        trust: [runCa.certPem],
      });
      const request = session.request({
        ':method': 'POST',
        ':path': '/v1/embeddings',
        // Claims an encoding the body does not have. `decodeRequestBody` throws either because
        // the runtime has no zstd or because the stream is corrupt; both used to escape the
        // `end` handler as an uncaught exception.
        'content-encoding': 'zstd',
      });
      request.on('error', () => undefined);
      request.setEncoding('utf8');
      let body = '';
      request.on('data', (c: string) => void (body += c));
      request.end(Buffer.from('not zstd at all'));
      await once(request, 'close');
      session.destroy();
      expect(failures).toHaveLength(0);

      expect(body).toBe('from-origin');
      const opaque = netExchanges.find((e) => e.path === '/v1/embeddings');
      expect(opaque).toBeDefined();
      expect(opaque?.alpn).toBe('h2');
      expect(opaque?.status).toBe(200);
    });
  });

  it('refuses CONNECT entirely when interception was not asked for', async () => {
    proxy = await createProxy({ mode: 'record' });
    await expect(
      through({
        proxyPort: proxy.port,
        host: '127.0.0.1',
        port: model.port,
        trust: [runCa.certPem, originCa.certPem],
      }),
    ).rejects.toThrow();
    expect(netExchanges).toHaveLength(0);
  });

  // `/v1/embeddings` throughout the opaque-capture tests, and the choice is load-bearing: these
  // assert what happens to traffic *no dialect recognises*, so the path has to be one orca has no
  // translator for. They were written against `/v1/responses`, which stopped being such a path the
  // day the Responses dialect landed — and then failed, correctly, by recording a model exchange.
  it('decrypts an allowlisted host and captures both halves of the exchange', async () => {
    const handle = await startProxy([`127.0.0.1:${model.port}`]);

    const response = await through({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: model.port,
      trust: [runCa.certPem],
      method: 'POST',
      path: '/v1/embeddings',
      body: JSON.stringify({ prompt: 'hello' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).toBe(200);
    // The origin's real answer, relayed intact.
    expect(JSON.parse(response.body).saw).toBe(JSON.stringify({ prompt: 'hello' }));
    // Signed by the run CA, not by the origin's: this connection was terminated and re-encrypted.
    expect(response.peerIssuer).toBe(commonName(runCa.certPem));

    expect(netExchanges).toHaveLength(1);
    const captured = netExchanges[0]!;
    expect(captured.host).toBe('127.0.0.1');
    expect(captured.port).toBe(model.port);
    expect(captured.method).toBe('POST');
    expect(captured.path).toBe('/v1/embeddings');
    expect(captured.requestBody).toBe(JSON.stringify({ prompt: 'hello' }));
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.responseBody).path).toBe('/v1/embeddings');
    expect(tunnels).toHaveLength(0);
  });

  it('cannot be reached by a client that does not trust the run CA', async () => {
    const handle = await startProxy([`127.0.0.1:${model.port}`]);
    // Interception is not invisible, and should not be: a client trusting only the real origin's
    // CA gets a handshake failure rather than a quietly rewritten connection.
    await expect(
      through({
        proxyPort: handle.port,
        host: '127.0.0.1',
        port: model.port,
        trust: [originCa.certPem],
      }),
    ).rejects.toThrow();
  });

  it('tunnels a host outside the allowlist without decrypting it', async () => {
    const handle = await startProxy([`127.0.0.1:${model.port}`]);

    const response = await through({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: bank.port,
      // Only the origin's CA. If orca had terminated this connection the handshake would fail.
      trust: [originCa.certPem],
      path: '/accounts',
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).balance).toBe('SUPER-SECRET-BALANCE-42');
    // The origin's own certificate reached the client untouched. Orca never held the plaintext.
    expect(response.peerIssuer).toBe(commonName(originCa.certPem));
    expect(response.peerIssuer).not.toBe(commonName(runCa.certPem));

    expect(netExchanges).toHaveLength(0);
    // A tunnel's record is only complete when it closes — byte counts are the only thing there is
    // to say about it, and they are not final until then.
    await vi.waitFor(() => expect(tunnels).toHaveLength(1));
    const tunnel = tunnels[0]!;
    expect(tunnel.host).toBe('127.0.0.1');
    expect(tunnel.port).toBe(bank.port);
    expect(tunnel.bytesToClient).toBeGreaterThan(0);
    // What a tunnel records is an address and a byte count. Not a path, not a header, not a body.
    expect(JSON.stringify(tunnel)).not.toContain('SUPER-SECRET-BALANCE-42');
    expect(JSON.stringify(tunnel)).not.toContain('accounts');
  });

  it('records an intercepted model API call as a model exchange, not as net traffic', async () => {
    const handle = await startProxy([`127.0.0.1:${model.port}`]);

    await through({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: model.port,
      trust: [runCa.certPem],
      method: 'POST',
      path: '/v1/chat/completions',
      body: JSON.stringify({ model: 'gpt-5.2', messages: [{ role: 'user', content: 'hello' }] }),
      headers: { 'content-type': 'application/json' },
    });

    // This is the payoff for a harness that ignores base-URL variables: its model traffic lands
    // in the trace as model traffic, indistinguishable from a run captured the ordinary way.
    expect(modelExchanges).toHaveLength(1);
    expect(modelExchanges[0]!.dialect).toBe('openai');
    expect(modelExchanges[0]!.canonicalRequest.model).toBe('gpt-5.2');
    expect(modelExchanges[0]!.status).toBe(200);
    expect(netExchanges).toHaveLength(0);
  });

  it.skipIf(zstdCompressSync === undefined)(
    'replays a zstd-compressed Codex request inside intercepted TLS',
    async () => {
      const dialect = defaultDialects().find((candidate) => candidate.id === 'codex')!;
      const request = {
        model: 'gpt-5.6-luna',
        instructions: 'Answer briefly.',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'say hello' }],
          },
        ],
        stream: true,
      };
      const response =
        'event: response.created\n' +
        'data: ' +
        JSON.stringify({
          type: 'response.created',
          response: { id: 'resp_test', model: 'gpt-5.6-luna', status: 'in_progress' },
        }) +
        '\n\n' +
        'event: response.output_text.delta\n' +
        'data: ' +
        JSON.stringify({ type: 'response.output_text.delta', delta: 'CODEX_REPLAY_OK' }) +
        '\n\n' +
        'event: response.completed\n' +
        'data: ' +
        JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_test',
            model: 'gpt-5.6-luna',
            status: 'completed',
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        }) +
        '\n\n';
      proxy = await createProxy({
        mode: 'replay',
        exchanges: [
          {
            seq: 0,
            dialect: 'codex',
            path: '/backend-api/codex/responses',
            rawRequest: JSON.stringify(request),
            rawResponse: response,
            status: 200,
            streamed: true,
            canonicalRequest: dialect.toCanonicalRequest(request),
            canonicalResponse: dialect.parseStream(response),
          },
        ],
        tls: {
          ca: runCa,
          hosts: [`127.0.0.1:${model.port}`],
          trustedOriginCerts: [originCa.certPem],
        },
      });

      const replayed = await through({
        proxyPort: proxy.port,
        host: '127.0.0.1',
        port: model.port,
        trust: [runCa.certPem],
        method: 'POST',
        path: '/backend-api/codex/responses',
        body: zstdCompressSync(Buffer.from(JSON.stringify(request))),
        headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      });

      expect(replayed.status).toBe(200);
      expect(replayed.body).toBe(response);
      expect(proxy.stats().matchedExact).toBe(1);
      expect(proxy.stats().unmatched).toBe(0);
      expect(netExchanges).toHaveLength(0);
    },
  );

  it('never records the credentials it forwards', async () => {
    const handle = await startProxy([`127.0.0.1:${model.port}`]);

    const response = await through({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: model.port,
      trust: [runCa.certPem],
      method: 'POST',
      path: '/v1/embeddings',
      body: '{}',
      headers: { authorization: 'Bearer sk-live-abcdefghijklmnop', 'x-api-key': 'secret-key' },
    });

    expect(response.status).toBe(200);
    // Forwarded — an agent that cannot authenticate cannot run.
    expect(originSawAuth).toBe('Bearer sk-live-abcdefghijklmnop');
    // Not recorded, in any form.
    const recorded = JSON.stringify(netExchanges[0]);
    expect(recorded).not.toContain('sk-live-abcdefghijklmnop');
    expect(recorded).not.toContain('secret-key');
    expect(netExchanges[0]!.requestHeaders.authorization).toBeUndefined();
  });

  /**
   * The mirror image of the credential test above: these two headers must survive, and must be
   * recorded.
   *
   * `HTTP-Referer` and `X-Title` are how a provider attributes a request to the app that made it —
   * OpenRouter builds its public app leaderboard from exactly these. A proxy that rewrote or
   * dropped them would re-attribute the agent's tokens to whoever ran the recording, silently
   * changing a third party's published ranking; that is not orca's to alter, and a debugger is the
   * last thing that should be editing attribution. Recording them, unlike recording a credential,
   * is the right call: they say which app produced the exchange, which is the one thing a trace
   * holding several agents' traffic cannot otherwise recover.
   */
  it('forwards the app attribution headers untouched, and records them', async () => {
    const handle = await startProxy([`127.0.0.1:${model.port}`]);
    const referer = 'https://github.com/Continuum-AI-Corp/OrcaReplay';
    const title = 'Some Coding Agent';

    const response = await through({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: model.port,
      trust: [runCa.certPem],
      method: 'POST',
      path: '/v1/embeddings',
      body: '{}',
      headers: {
        authorization: 'Bearer sk-live-abcdefghijklmnop',
        'http-referer': referer,
        'x-title': title,
      },
    });

    expect(response.status).toBe(200);
    // Byte-identical at the origin: not re-cased, not re-written, not orca's own.
    expect(originSawAttribution['http-referer']).toBe(referer);
    expect(originSawAttribution['x-title']).toBe(title);
    // And present in the trace, which is what lets one recording separate two agents.
    expect(netExchanges[0]!.requestHeaders['http-referer']).toBe(referer);
    expect(netExchanges[0]!.requestHeaders['x-title']).toBe(title);
    // The credential rule still holds alongside them.
    expect(netExchanges[0]!.requestHeaders.authorization).toBeUndefined();
  });

  it('never lets the run CA private key reach anything it records', async () => {
    // The property this whole feature stands on. The key exists so orca can impersonate a host to
    // the child; a copy of it in a trace someone attaches to an issue is a signing key handed to
    // whoever reads the issue. Nothing in the capture path has any reason to touch it, which is
    // exactly why this is worth asserting: it is the kind of invariant a later refactor breaks
    // silently, and there is no error to notice when it does.
    const handle = await startProxy([`127.0.0.1:${model.port}`]);

    await through({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: model.port,
      trust: [runCa.certPem],
      method: 'POST',
      path: '/v1/embeddings',
      body: '{"model":"gpt-5.2"}',
    });

    // Read from disk, because `RunCa` does not expose the key at all — it is a private field, and
    // the file is the only place it exists. That is the stronger guarantee: the capture path
    // cannot reach the key even by mistake. This test defends the remaining route, which is
    // something copying the file's contents into a record.
    //
    // Both shapes it could take: the PEM as written, and its base64 body with the armour and
    // newlines stripped, which is how it would survive being embedded in JSON.
    const keyPem = await readFile(runCa.keyPath, 'utf8');
    const keyBody = keyPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    expect(keyBody.length).toBeGreaterThan(64);

    const everythingRecorded = JSON.stringify({
      net: netExchanges,
      tunnels,
      model: modelExchanges,
    });
    expect(everythingRecorded).not.toContain(keyPem);
    expect(everythingRecorded).not.toContain(keyBody);
    expect(everythingRecorded).not.toContain('PRIVATE KEY');
    // The certificate is public and may legitimately appear; the key must not. Assert the search
    // was capable of finding something, so a future refactor cannot make this pass by recording
    // nothing at all.
    expect(everythingRecorded.length).toBeGreaterThan(100);
  });

  it('forwards a streaming response as it arrives rather than buffering it', async () => {
    const handle = await startProxy([`127.0.0.1:${model.port}`]);

    const response = await through({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: model.port,
      trust: [runCa.certPem],
      path: '/stream',
      onFirstChunk: (chunk) => {
        expect(chunk).toContain('first');
        // The origin is waiting on this. If the proxy had read the whole body first, nothing
        // would ever call it.
        release?.();
      },
    });

    expect(response.body).toBe('data: first\n\ndata: second\n\n');
    expect(netExchanges[0]!.responseBody).toBe('data: first\n\ndata: second\n\n');
  });

  /**
   * The failure that made Hermes look uncapturable.
   *
   * Recording used to happen only when the response reached `end`, so a client that stopped
   * reading a streaming reply the moment it had its answer left nothing behind -- and the run
   * reported `capture.empty` with "the agent never called the proxy", about a request orca had
   * decrypted and forwarded itself. The prefix is the evidence, and the prefix is what gets kept.
   */
  it('records a streaming exchange the client walks away from mid-flight', async () => {
    const handle = await startProxy([`127.0.0.1:${model.port}`]);

    const seen = await abandoned({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: model.port,
      trust: [runCa.certPem],
      path: '/stream',
      leaveAfter: 'first-chunk',
    });
    expect(seen).toBe('data: first\n\n');
    // The origin is left holding the second chunk on purpose. Releasing it here would let
    // the response reach `end` and be filed the ordinary way, which is the path this test is
    // not about; `afterEach` releases it into a socket that has already gone.
    await settle();

    expect(netExchanges).toHaveLength(1);
    const captured = netExchanges[0]!;
    expect(captured.abandoned).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.responseBody).toContain('first');
    // Not a capture-limit truncation: orca kept everything it was handed.
    expect(captured.responseTruncated).toBe(false);
  });

  /**
   * An exchange with no response is evidence, not a model call.
   *
   * `onDecrypted` promotes a decrypted POST to a model exchange when a dialect claims the path,
   * and a call abandoned before the answer would satisfy that on the path alone. Promoting it puts
   * an entry in the replay set that can answer nothing and cannot be forked, so it is kept as
   * network traffic instead -- which is what it is.
   */
  it('keeps a model call abandoned before the origin answered as network traffic', async () => {
    const handle = await startProxy([`127.0.0.1:${model.port}`]);

    await abandoned({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: model.port,
      trust: [runCa.certPem],
      method: 'POST',
      path: '/v1/chat/completions',
      body: JSON.stringify({ model: 'gpt-5.2', messages: [{ role: 'user', content: 'hello' }] }),
      headers: { 'content-type': 'application/json', 'x-test-hold': '1' },
      leaveAfter: 'request',
    });
    // Deliberately not released here: the point is an exchange whose response never began, and
    // letting the origin answer first would give it the status that makes it a model call.
    // `afterEach` releases it into a socket that has already gone.
    await settle();

    expect(modelExchanges).toHaveLength(0);
    expect(netExchanges).toHaveLength(1);
    expect(netExchanges[0]!.abandoned).toBe(true);
    expect(netExchanges[0]!.status).toBe(0);
    expect(netExchanges[0]!.requestBody).toContain('gpt-5.2');
  });

  it('refuses an origin whose certificate it cannot verify instead of downgrading', async () => {
    // A CA the proxy was never told about — the shape of a real MITM sitting in front of the
    // origin. Interception must not become an excuse to stop checking.
    const strangerDir = await mkdtemp(join(tmpdir(), 'orca-mitm-stranger-'));
    const stranger = await RunCa.create({ runDir: strangerDir });
    const impostor = await startOrigin(stranger, (_req, res) => res.end('{}'));
    try {
      const handle = await startProxy([`127.0.0.1:${impostor.port}`]);
      const response = await through({
        proxyPort: handle.port,
        host: '127.0.0.1',
        port: impostor.port,
        trust: [runCa.certPem],
      });
      expect(response.status).toBe(502);
      expect(response.body).toContain('certificate');
    } finally {
      await impostor.close();
      await stranger.dispose();
      await rm(strangerDir, { recursive: true, force: true });
    }
  });

  it('reports what it is intercepting, so a run can say so before it starts', async () => {
    const handle = await startProxy(['api.openai.com', '*.chatgpt.com']);
    expect(handle.tls?.hosts).toBe('api.openai.com, *.chatgpt.com');
    expect(handle.tls?.fingerprint).toBe(runCa.fingerprint);
    expect(handle.tls?.caCertPath).toBe(runCa.certPath);
    expect(handle.tls?.caBundlePath).toBe(runCa.bundlePath);
  });

  it('counts what it decrypted and what it refused to', async () => {
    const handle = await startProxy([`127.0.0.1:${model.port}`]);
    await through({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: model.port,
      trust: [runCa.certPem],
      path: '/one',
    });
    await through({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: bank.port,
      trust: [originCa.certPem],
      path: '/two',
    });
    expect(handle.stats().intercepted).toBe(1);
    expect(handle.stats().tunnelled).toBe(1);
  });
});
