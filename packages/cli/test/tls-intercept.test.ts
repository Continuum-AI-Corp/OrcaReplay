import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader } from '@orcareplay/core';
import { RunCa } from '@orcareplay/proxy';
import { validateEvent } from '@orcareplay/schema';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';

const here = dirname(fileURLToPath(import.meta.url));
const TLS_AGENT = join(here, 'fixtures', 'tls-agent.mjs');

/**
 * `orca record --tls-intercept`, end to end, with a child process that really does CONNECT through
 * the proxy and really does speak TLS on the other side.
 *
 * The properties under test are the ones that make the feature defensible rather than the ones
 * that make it work: off unless asked for, announced when on, trusted only by the child, gone when
 * the run ends, and never — under any circumstance — written into the trace.
 */
describe('orca record --tls-intercept', () => {
  let workspace: string;
  let originDir: string;
  let scratch: string;
  let originCa: RunCa;
  let model: { port: number; close: () => Promise<void> };
  let bank: { port: number; close: () => Promise<void> };
  let out: Output;
  let lines: string[];
  let envOut: string;
  let resultOut: string;
  let keyOut: string;
  /**
   * The environment as it stood before the run. Asserting against `undefined` would be wrong on
   * any machine that already sets a proxy or a CA bundle of its own — and orca leaving those
   * exactly as it found them is the property worth pinning anyway.
   */
  let ambient: Record<string, string | undefined>;

  async function startOrigin(
    handler: (path: string) => { status: number; body: string },
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const issued = originCa.issue('127.0.0.1');
    const server = createHttpsServer({ key: issued.keyPem, cert: issued.certPem }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => void chunks.push(c));
      req.on('end', () => {
        const reply = handler(req.url ?? '/');
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: (server.address() as AddressInfo).port,
      close: () => new Promise<void>((resolve) => void server.close(() => resolve())),
    };
  }

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-mitmcli-'));
    originDir = await mkdtemp(join(tmpdir(), 'orca-mitmorigin-'));
    scratch = await mkdtemp(join(tmpdir(), 'orca-mitmscratch-'));
    originCa = await RunCa.create({ runDir: originDir });
    envOut = join(scratch, 'env.json');
    resultOut = join(scratch, 'results.json');
    keyOut = join(scratch, 'stolen-ca.key');

    model = await startOrigin((path) => ({
      status: 200,
      body: JSON.stringify({ served: path, note: 'MODEL-BODY-MARKER' }),
    }));
    bank = await startOrigin(() => ({
      status: 200,
      body: JSON.stringify({ balance: 'BANK-BODY-MARKER' }),
    }));

    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    ambient = { ...process.env };

    process.env.ORCA_TEST_ENV_OUT = envOut;
    process.env.ORCA_TEST_RESULT_OUT = resultOut;
    process.env.ORCA_TEST_CA_KEY_OUT = keyOut;
    process.env.ORCA_TEST_ORIGIN_CA = originCa.certPath;
    // The origins here are signed by a CA no machine trusts. Real interception verifies the
    // origin, so the proxy has to be told about that root the same way a corporate one would be.
    process.env.ORCA_TLS_UPSTREAM_CA = originCa.certPath;
  });

  afterEach(async () => {
    for (const key of [
      'ORCA_TEST_ENV_OUT',
      'ORCA_TEST_RESULT_OUT',
      'ORCA_TEST_CA_KEY_OUT',
      'ORCA_TEST_ORIGIN_CA',
      'ORCA_TEST_TARGETS',
      'ORCA_TLS_UPSTREAM_CA',
    ]) {
      delete process.env[key];
    }
    await model.close();
    await bank.close();
    await originCa.dispose();
    await rm(workspace, { recursive: true, force: true });
    await rm(originDir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  function record(flags: string[]): ReturnType<typeof recordCommand> {
    return recordCommand(
      parseArgs([
        'record',
        'generic-openai',
        '--no-fs',
        '--no-shell',
        ...flags,
        '--',
        'node',
        TLS_AGENT,
      ]),
      out,
      workspace,
    );
  }

  function childEnv(): Promise<Record<string, string>> {
    return readFile(envOut, 'utf8').then((raw) => JSON.parse(raw) as Record<string, string>);
  }

  it('is off unless it is asked for', async () => {
    const result = await record([]);
    const env = await childEnv();

    for (const key of ['HTTPS_PROXY', 'https_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
      expect(env[key], key).toBe(ambient[key]);
    }
    await expect(stat(join(result.runDir, 'tls'))).rejects.toThrow();
    expect(lines.join('')).not.toMatch(/tls/i);
  });

  it('takes the key with it when the run fails before it ever starts', async () => {
    // The likeliest failure there is: the agent is not installed. Nothing in the ordinary teardown
    // runs, and a private key surviving that is the outcome this feature must not have.
    await expect(
      recordCommand(
        parseArgs([
          'record',
          'generic-openai',
          '--tls-intercept',
          '--no-fs',
          '--no-shell',
          '--',
          'orca-definitely-not-a-real-binary',
        ]),
        out,
        workspace,
      ),
    ).rejects.toThrow(/could not launch/);

    const runs = join(workspace, '.orca', 'runs');
    for (const run of await readdir(runs)) {
      await expect(stat(join(runs, run, 'tls'))).rejects.toThrow();
      expect(await grepRunDir(join(runs, run), 'PRIVATE KEY')).toEqual([]);
    }
  });

  it('says out loud that it is intercepting, and what', async () => {
    await record(['--tls-intercept', '--tls-hosts', 'api.openai.com,*.chatgpt.com']);
    const printed = lines.join('');
    expect(printed).toContain('tls.intercepting');
    expect(printed).toContain('api.openai.com');
    expect(printed).toContain('*.chatgpt.com');
  });

  it('decrypts model API hosts and nothing else when no list is given', async () => {
    process.env.ORCA_TEST_TARGETS = JSON.stringify([
      { host: '127.0.0.1', port: bank.port, path: '/accounts' },
    ]);
    const result = await record(['--tls-intercept']);

    const printed = lines.join('');
    expect(printed).toContain('api.openai.com');
    expect(printed).toContain('api.anthropic.com');
    expect(printed).not.toContain('github.com');

    // A local address is on nobody's model API list, so the default policy tunnels it.
    const events = await (await TraceReader.open(result.runDir)).events();
    const net = events.filter((e) => e.type.startsWith('net.'));
    expect(net).toHaveLength(2);
    for (const event of net) expect(event.attrs?.intercepted).toBe(false);
    expect(await grepRunDir(result.runDir, 'BANK-BODY-MARKER')).toEqual([]);
  });

  it('warns rather than silently ignoring hosts named without the flag', async () => {
    await record(['--tls-hosts', 'api.openai.com']);
    expect(lines.join('')).toContain('tls.hosts_ignored');
  });

  it('trusts the run CA through the child environment and nowhere else', async () => {
    const result = await record(['--tls-intercept', '--tls-hosts', `127.0.0.1:${model.port}`]);
    const env = await childEnv();

    expect(env.HTTPS_PROXY).toBe(env.https_proxy);
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Additive for Node, whole-store replacements for the OpenSSL family — hence two files.
    expect(env.NODE_EXTRA_CA_CERTS).toBe(join(result.runDir, 'tls', 'ca.crt'));
    for (const key of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) {
      expect(env[key], key).toBe(join(result.runDir, 'tls', 'ca-bundle.crt'));
    }
    // The agent's own calls to the recording proxy must not be sent through the recording proxy.
    expect(env.NO_PROXY).toContain('127.0.0.1');

    // Nothing global. Orca's own process was never asked to trust the run CA, and the variables
    // it set on the child are absent from — or unchanged in — its own environment.
    for (const key of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NO_PROXY']) {
      expect(process.env[key], key).toBe(ambient[key]);
    }
    expect(process.env.NODE_EXTRA_CA_CERTS ?? '').not.toContain(result.runDir);
  });

  it('captures an allowlisted host and tunnels everything else', async () => {
    process.env.ORCA_TEST_TARGETS = JSON.stringify([
      { host: '127.0.0.1', port: model.port, path: '/v1/embeddings', method: 'POST', body: '{}' },
      { host: '127.0.0.1', port: bank.port, path: '/accounts' },
    ]);

    const result = await record(['--tls-intercept', '--tls-hosts', `127.0.0.1:${model.port}`]);
    const results = JSON.parse(await readFile(resultOut, 'utf8')) as {
      status?: number;
      body?: string;
      issuer?: string;
      error?: string;
    }[];

    expect(results).toHaveLength(2);
    // Both calls succeeded — interception is transparent to a child that trusts the run CA, and
    // the tunnel is transparent to everything.
    expect(results[0]!.status).toBe(200);
    expect(results[1]!.status).toBe(200);
    // The intercepted call saw a certificate orca minted; the tunnelled one saw the origin's own.
    const originIssuer = /CN=(.*)/.exec(new X509Certificate(originCa.certPem).subject)?.[1];
    expect(results[0]!.issuer).not.toBe(originIssuer);
    expect(results[0]!.issuer).toContain('OrcaReplay run CA');
    expect(results[1]!.issuer).toBe(originIssuer);

    const events = await (await TraceReader.open(result.runDir)).events();
    const net = events.filter((e) => e.type === 'net.request' || e.type === 'net.response');
    expect(net.length).toBeGreaterThanOrEqual(4);
    for (const event of net) expect(validateEvent(event).valid).toBe(true);

    const intercepted = net.filter((e) => e.attrs?.intercepted === true);
    expect(intercepted.map((e) => e.type)).toEqual(['net.request', 'net.response']);
    expect(intercepted[0]!.attrs?.path).toBe('/v1/embeddings');
    expect(JSON.stringify(intercepted[1]?.payload)).toContain('MODEL-BODY-MARKER');

    const tunnelled = net.filter((e) => e.attrs?.intercepted === false);
    expect(tunnelled.map((e) => e.type)).toEqual(['net.request', 'net.response']);
    expect(tunnelled[0]!.attrs?.host).toBe('127.0.0.1');
    expect(tunnelled[0]!.attrs?.port).toBe(bank.port);
    // A tunnel is an address and a byte count. It has no path and no body, because orca never
    // held the plaintext to write one.
    expect(tunnelled[0]!.payload).toBeUndefined();
    expect(tunnelled[1]!.payload).toBeUndefined();
    expect(Number(tunnelled[1]!.attrs?.bytes_to_client)).toBeGreaterThan(0);
  });

  it('never writes the bank host it tunnelled into the trace as content', async () => {
    process.env.ORCA_TEST_TARGETS = JSON.stringify([
      { host: '127.0.0.1', port: bank.port, path: '/accounts' },
    ]);
    const result = await record(['--tls-intercept', '--tls-hosts', `127.0.0.1:${model.port}`]);
    expect(await grepRunDir(result.runDir, 'BANK-BODY-MARKER')).toEqual([]);
    expect(await grepRunDir(result.runDir, 'accounts')).toEqual([]);
  });

  it('never writes the CA private key into the trace', async () => {
    process.env.ORCA_TEST_TARGETS = JSON.stringify([
      { host: '127.0.0.1', port: model.port, path: '/v1/embeddings', method: 'POST', body: '{}' },
    ]);
    const result = await record(['--tls-intercept', '--tls-hosts', `127.0.0.1:${model.port}`]);

    // The child copied the key out while the run was live, so this is the real material rather
    // than a shape that resembles it.
    const stolen = await readFile(keyOut, 'utf8');
    expect(stolen).toContain('PRIVATE KEY');
    const material = stolen
      .split('\n')
      .filter((line) => line.length > 0 && !line.includes('PRIVATE KEY'))
      .join('');
    expect(material.length).toBeGreaterThan(40);

    expect(await grepRunDir(result.runDir, material)).toEqual([]);
    for (const shape of ['PRIVATE KEY', 'BEGIN EC PARAMETERS']) {
      expect(await grepRunDir(result.runDir, shape)).toEqual([]);
    }
  });

  it('takes the CA off disk when the run ends', async () => {
    const result = await record(['--tls-intercept', '--tls-hosts', `127.0.0.1:${model.port}`]);
    await expect(stat(join(result.runDir, 'tls'))).rejects.toThrow();
  });

  it('records which CA it used, so a certificate found later can be traced to a run', async () => {
    const result = await record(['--tls-intercept', '--tls-hosts', `127.0.0.1:${model.port}`]);
    const events = await (await TraceReader.open(result.runDir)).events();
    const note = events.find((e) => e.type === 'note' && e.attrs?.rule === 'tls_intercept');
    expect(note).toBeDefined();
    expect(String(note?.attrs?.ca_sha256)).toMatch(/^[0-9A-F:]{50,}$/);
    expect(note?.attrs?.hosts).toBe(`127.0.0.1:${model.port}`);
  });

  it('refuses to intercept everything, however it is asked', async () => {
    await expect(record(['--tls-intercept', '--tls-hosts', '*'])).rejects.toThrow(/every host/i);
  });

  it('leaves the fingerprint out of the CA certificate it deleted, but not the record of it', async () => {
    const result = await record(['--tls-intercept', '--tls-hosts', `127.0.0.1:${model.port}`]);
    const events = await (await TraceReader.open(result.runDir)).events();
    const note = events.find((e) => e.attrs?.rule === 'tls_intercept');
    // Not a certificate, not a key: a digest. Nothing recoverable, everything auditable.
    expect(JSON.stringify(note)).not.toContain('BEGIN');
    expect(() => new X509Certificate(JSON.stringify(note))).toThrow();
  });
});

/** Every file under a run directory that contains `needle`. */
async function grepRunDir(runDir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const contents = await readFile(full, 'utf8').catch(() => '');
      if (contents.includes(needle)) hits.push(full);
    }
  };
  await walk(runDir);
  return hits;
}
