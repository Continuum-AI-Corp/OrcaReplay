import { createPublicKey, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunCa } from '../src/ca.js';

/**
 * The certificate authority a `--tls-intercept` run mints for itself.
 *
 * Every assertion here is a security property from the feature's specification, not a
 * nice-to-have: the key stays on disk at 0600 and dies with the run, the CA expires in a day, and
 * nothing anywhere offers to put it in a trust store. `X509Certificate` is OpenSSL's own parser,
 * so a certificate it accepts is a certificate a TLS stack accepts — which is the only way to
 * prove a hand-rolled DER encoder produced something real.
 */
describe('per-run certificate authority', () => {
  let runDir: string;
  let ca: RunCa;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'orca-ca-'));
    ca = await RunCa.create({ runDir });
  });

  afterEach(async () => {
    await ca.dispose();
    await rm(runDir, { recursive: true, force: true });
  });

  it('mints a self-signed CA certificate that OpenSSL parses', () => {
    const cert = new X509Certificate(ca.certPem);
    expect(cert.ca).toBe(true);
    expect(cert.subject).toContain('OrcaReplay');
    // Self-signed: the issuer is itself, and it verifies under its own key.
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.verify(cert.publicKey)).toBe(true);
  });

  it('expires within a day, so a leaked key is worthless tomorrow', () => {
    const cert = new X509Certificate(ca.certPem);
    const life = new Date(cert.validTo).getTime() - Date.now();
    expect(life).toBeGreaterThan(0);
    expect(life).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
  });

  it('issues a host certificate that chains to the run CA', () => {
    const issued = ca.issue('api.openai.com');
    const leaf = new X509Certificate(issued.certPem);
    const caCert = new X509Certificate(ca.certPem);

    expect(leaf.ca).toBe(false);
    expect(leaf.checkHost('api.openai.com')).toBe('api.openai.com');
    expect(leaf.verify(caCert.publicKey)).toBe(true);
    expect(leaf.issuer).toBe(caCert.subject);
    // The private key in the pair actually belongs to the certificate.
    expect(createPublicKey(issued.keyPem).export({ type: 'spki', format: 'der' })).toEqual(
      leaf.publicKey.export({ type: 'spki', format: 'der' }),
    );
  });

  it('gives a literal address an IP SAN, which is the only kind a client will match', () => {
    const leaf = new X509Certificate(ca.issue('127.0.0.1').certPem);
    expect(leaf.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1');
  });

  it('does not vouch for a host it was not asked about', () => {
    const leaf = new X509Certificate(ca.issue('api.openai.com').certPem);
    expect(leaf.checkHost('bank.example.com')).toBeUndefined();
  });

  it('reuses one certificate per host, so a reconnect is not a fresh mint', () => {
    expect(ca.issue('api.openai.com').certPem).toBe(ca.issue('api.openai.com').certPem);
    expect(ca.issue('api.openai.com').certPem).not.toBe(ca.issue('api.anthropic.com').certPem);
  });

  it('keeps the private key at 0600 inside a 0700 directory', async () => {
    const dirMode = (await stat(ca.dir)).mode & 0o777;
    const keyMode = (await stat(ca.keyPath)).mode & 0o777;
    const certMode = (await stat(ca.certPath)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(keyMode).toBe(0o600);
    expect(certMode).toBe(0o600);
    expect(ca.dir.startsWith(runDir)).toBe(true);
  });

  it('writes a trust bundle that adds the run CA to the system roots rather than replacing them', async () => {
    const bundle = await readFile(ca.bundlePath, 'utf8');
    expect(bundle).toContain(ca.certPem.trim());
    // SSL_CERT_FILE replaces the whole store for OpenSSL clients. A bundle holding only our CA
    // would break the child's connection to every host we deliberately do not intercept.
    expect(bundle).toContain(rootCertificates[0]!.trim());
    expect(bundle.match(/BEGIN CERTIFICATE/g)?.length).toBe(rootCertificates.length + 1);
  });

  it('deletes the key material when the run ends', async () => {
    await ca.dispose();
    await expect(stat(ca.keyPath)).rejects.toThrow();
    await expect(stat(ca.dir)).rejects.toThrow();
  });

  it('reports a fingerprint an operator can match against the certificate on disk', async () => {
    const onDisk = new X509Certificate(await readFile(ca.certPath, 'utf8'));
    expect(ca.fingerprint).toBe(onDisk.fingerprint256);
  });
});
