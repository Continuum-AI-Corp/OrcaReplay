/**
 * A CONNECT-then-TLS call through `HTTPS_PROXY`, shared by the fixture agents.
 *
 * Node's own client does not honour proxy environment variables before v24, so the CONNECT is
 * written by hand — which is also what makes this a test of orca's proxy rather than of Node's.
 * It lives here because two fixtures need it: the harness that only speaks TLS, and the ordinary
 * agent that has to make one side-call so a *fork* can be checked for interception too.
 */
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';

/** The roots this child was given, which is the only trust an intercepted child ever has. */
export function trustFromEnv() {
  const trust = [];
  for (const path of [process.env.NODE_EXTRA_CA_CERTS, process.env.ORCA_TEST_ORIGIN_CA]) {
    if (path && existsSync(path)) trust.push(readFileSync(path, 'utf8'));
  }
  return trust;
}

export async function callThroughProxy(target, trust = trustFromEnv()) {
  const proxy = new URL(process.env.HTTPS_PROXY ?? 'http://127.0.0.1:1');
  const authority = `${target.host}:${target.port}`;
  const tunnel = httpRequest({
    host: proxy.hostname,
    port: Number(proxy.port),
    method: 'CONNECT',
    path: authority,
    headers: { host: authority },
  });
  tunnel.end();
  const [res, socket, head] = await once(tunnel, 'connect');
  if (res.statusCode !== 200) {
    socket.destroy();
    throw new Error(`CONNECT ${authority} → ${res.statusCode}`);
  }
  if (head.length > 0) socket.unshift(head);

  const secure = tlsConnect({ socket, ca: trust, host: target.host, port: target.port });
  await once(secure, 'secureConnect');
  const issuer = String(secure.getPeerCertificate().issuer.CN ?? '');

  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        createConnection: () => secure,
        host: target.host,
        port: target.port,
        method: target.method ?? 'GET',
        path: target.path ?? '/',
        headers: { host: authority, 'content-type': 'application/json' },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => {
          secure.destroy();
          resolve({ status: response.statusCode, body, issuer });
        });
      },
    );
    req.on('error', (err) => {
      secure.destroy();
      reject(err);
    });
    if (target.body !== undefined) req.write(target.body);
    req.end();
  });
}

/** Every target in `ORCA_TEST_TARGETS`, attempted in order, errors captured rather than thrown. */
export async function callConfiguredTargets(trust = trustFromEnv()) {
  const targets = process.env.ORCA_TEST_TARGETS ? JSON.parse(process.env.ORCA_TEST_TARGETS) : [];
  const results = [];
  for (const target of targets) {
    try {
      results.push({ target, ...(await callThroughProxy(target, trust)) });
    } catch (err) {
      results.push({ target, error: String(err) });
    }
  }
  return results;
}
