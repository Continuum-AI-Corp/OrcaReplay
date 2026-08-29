/**
 * A stand-in for a harness that ignores base-URL variables and talks HTTPS to its own backend.
 *
 * It does what such a harness does: read `HTTPS_PROXY`, `CONNECT` through it, and speak TLS on the
 * tunnel. Node's own client does not honour proxy environment variables before v24, so the CONNECT
 * is written by hand here — which is also what makes this a test of orca's proxy rather than of
 * Node's.
 *
 * Everything it reports goes to files named in the environment, so the test can assert on what the
 * *child* saw rather than on what the parent believes it set.
 */
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';

if (process.env.ORCA_TEST_ENV_OUT) {
  writeFileSync(process.env.ORCA_TEST_ENV_OUT, JSON.stringify(process.env, null, 2));
}

// The run CA's private key, copied out by the child exactly as an attacker with the agent's own
// privileges could. The test greps the finished trace for these bytes.
if (process.env.ORCA_TEST_CA_KEY_OUT && process.env.NODE_EXTRA_CA_CERTS) {
  const keyPath = process.env.NODE_EXTRA_CA_CERTS.replace(/ca\.crt$/, 'ca.key');
  if (existsSync(keyPath)) writeFileSync(process.env.ORCA_TEST_CA_KEY_OUT, readFileSync(keyPath));
}

const trust = [];
for (const path of [process.env.NODE_EXTRA_CA_CERTS, process.env.ORCA_TEST_ORIGIN_CA]) {
  if (path && existsSync(path)) trust.push(readFileSync(path, 'utf8'));
}

async function callThroughProxy(target) {
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

const targets = process.env.ORCA_TEST_TARGETS ? JSON.parse(process.env.ORCA_TEST_TARGETS) : [];
const results = [];
for (const target of targets) {
  try {
    results.push({ target, ...(await callThroughProxy(target)) });
  } catch (err) {
    results.push({ target, error: String(err) });
  }
}
if (process.env.ORCA_TEST_RESULT_OUT) {
  writeFileSync(process.env.ORCA_TEST_RESULT_OUT, JSON.stringify(results, null, 2));
}
