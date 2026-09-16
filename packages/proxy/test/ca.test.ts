import { execFile } from 'node:child_process';
import { createPublicKey, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunCa } from '../src/ca.js';

/**
 * 0600 and 0700 say nothing on Windows: `chmod` there sets the read-only attribute and `stat`
 * answers 0o666 whatever was asked for. What actually decides who may read the file is its ACL, so
 * that is what gets checked — `(I)` marks an inherited entry, and an inherited entry on this path
 * is one the workspace handed down to it. `restrictToOwner`'s own tests in @orcareplay/core cover
 * exactly which trustees are left; the property here is that none of them came from outside.
 */
async function expectOwnerOnly(path: string, mode: number): Promise<void> {
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777, path).toBe(mode);
    return;
  }
  const icacls = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const { stdout } = await promisify(execFile)(icacls, [path]);
  // Nothing inherited...
  expect(stdout, path).not.toContain('(I)');
  // ...and nothing else granted. `(I)` alone would pass a surviving *explicit* ACE for a third
  // party, which is exactly what `/inheritance:r` plus `/grant:r` used to leave behind. Counted
  // rather than named, because the names icacls prints are localized.
  const granted = stdout.split(/\r?\n/).filter((line) => line.includes(':(')).length;
  expect(granted, `${path}: expected owner, SYSTEM and Administrators only`).toBe(3);
}

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

  it('keeps the private key to its owner, in whatever the filesystem uses to say so', async () => {
    // This key signs the certificates the agent has been told to trust for the life of the run.
    // Anyone who can read it can impersonate every intercepted host to that agent; anyone who can
    // write it can substitute a CA of their own. On Windows the inherited ACL granted both to
    // every account on the machine, and the 0600 that was supposed to prevent it did nothing.
    await expectOwnerOnly(ca.dir, 0o700);
    await expectOwnerOnly(ca.keyPath, 0o600);
    await expectOwnerOnly(ca.certPath, 0o600);
    await expectOwnerOnly(ca.bundlePath, 0o600);
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

  it('arms a removal for the exits that never reach dispose, and disarms it after', async () => {
    // A run that throws or is interrupted never reaches its own teardown. A private key surviving
    // that is not an acceptable failure mode, so the removal is armed at creation.
    const before = process.listenerCount('exit');
    const extra = await RunCa.create({ runDir });
    expect(process.listenerCount('exit')).toBe(before + 1);
    await extra.dispose();
    // And disarmed again, or a process recording many runs would accumulate one listener each.
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('reports a fingerprint an operator can match against the certificate on disk', async () => {
    const onDisk = new X509Certificate(await readFile(ca.certPath, 'utf8'));
    expect(ca.fingerprint).toBe(onDisk.fingerprint256);
  });
});
