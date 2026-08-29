import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunCa } from '../src/ca.js';
import {
  createProxy,
  type NetExchange,
  type ProxyHandle,
  type TunnelRecord,
} from '../src/server.js';
import type { RecordedExchange } from '../src/server.js';

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
  body?: string;
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

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'orca-mitm-run-'));
    originDir = await mkdtemp(join(tmpdir(), 'orca-mitm-origin-'));
    runCa = await RunCa.create({ runDir });
    originCa = await RunCa.create({ runDir: originDir });
    netExchanges = [];
    tunnels = [];
    modelExchanges = [];
    originSawAuth = undefined;

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

  it('decrypts an allowlisted host and captures both halves of the exchange', async () => {
    const handle = await startProxy([`127.0.0.1:${model.port}`]);

    const response = await through({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: model.port,
      trust: [runCa.certPem],
      method: 'POST',
      path: '/v1/responses',
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
    expect(captured.path).toBe('/v1/responses');
    expect(captured.requestBody).toBe(JSON.stringify({ prompt: 'hello' }));
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.responseBody).path).toBe('/v1/responses');
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

  it('never records the credentials it forwards', async () => {
    const handle = await startProxy([`127.0.0.1:${model.port}`]);

    const response = await through({
      proxyPort: handle.port,
      host: '127.0.0.1',
      port: model.port,
      trust: [runCa.certPem],
      method: 'POST',
      path: '/v1/responses',
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
