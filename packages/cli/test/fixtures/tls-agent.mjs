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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { callConfiguredTargets } from './proxy-call.mjs';

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

const results = await callConfiguredTargets(trust);
if (process.env.ORCA_TEST_RESULT_OUT) {
  writeFileSync(process.env.ORCA_TEST_RESULT_OUT, JSON.stringify(results, null, 2));
}
