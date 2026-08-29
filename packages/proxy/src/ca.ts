import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import {
  derBitString,
  derBoolean,
  derContext,
  derInteger,
  derOctetString,
  derOid,
  derSequence,
  derSet,
  derTime,
  derTlv,
  derUtf8String,
  toPem,
} from './der.js';

const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  extendedKeyUsage: '2.5.29.37',
  subjectKeyIdentifier: '2.5.29.14',
  authorityKeyIdentifier: '2.5.29.35',
  serverAuth: '1.3.6.1.5.5.7.3.1',
} as const;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * How long a run CA lives.
 *
 * A day, not a decade. The key is deleted when the run ends, but a run can be killed with SIGKILL
 * and leave the file behind; an expiry short enough to outlive nothing but the session it was
 * minted for is the backstop for that. Nobody's agent session lasts twenty-five hours.
 */
const DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Backdated a little, because a clock a few seconds behind ours should not see a future cert. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface RunCaOptions {
  /** The run directory. The CA lives in `<runDir>/tls`, never anywhere global. */
  runDir: string;
  /** Overridable for tests that need to reason about expiry. */
  lifetimeMs?: number;
}

/** A minted certificate and the private key that goes with it, both PEM. */
export interface IssuedCertificate {
  certPem: string;
  keyPem: string;
}

/** The X.509 tail: sign the TBS bytes and wrap them into a Certificate. */
function signCertificate(tbs: Buffer, issuerKey: KeyObject): string {
  const algorithm = derSequence(derOid(OID.ecdsaWithSha256));
  // Node signs EC keys with a DER-encoded ECDSA-Sig-Value by default, which is exactly the
  // BIT STRING content RFC 5280 wants. No re-encoding needed.
  const signature = sign('sha256', tbs, issuerKey);
  return toPem('CERTIFICATE', derSequence(tbs, algorithm, derBitString(signature)));
}

function distinguishedName(commonName: string): Buffer {
  return derSequence(
    derSet(derSequence(derOid(OID.organization), derUtf8String('OrcaReplay'))),
    derSet(derSequence(derOid(OID.commonName), derUtf8String(commonName))),
  );
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return derSequence(
    derOid(id),
    ...(critical ? [derBoolean(true)] : []),
    // An extension's value is always wrapped in an OCTET STRING, whatever its own type.
    derOctetString(value),
  );
}

/**
 * A KeyUsage BIT STRING.
 *
 * Bits are numbered from the most significant bit of the first byte, and the leading count byte
 * says how many trailing bits are padding — get it wrong and a strict verifier reads a different
 * set of usages than you meant.
 */
function keyUsage(...bits: number[]): Buffer {
  const highest = Math.max(...bits);
  const bytes = Buffer.alloc(Math.floor(highest / 8) + 1);
  for (const bit of bits) bytes[Math.floor(bit / 8)]! |= 0x80 >> (bit % 8);
  const unused = bytes.length * 8 - (highest + 1);
  return derTlv(0x03, Buffer.concat([Buffer.from([unused]), bytes]));
}

/**
 * The uncompressed EC point, `04 || x || y`.
 *
 * Taken from the JWK export rather than by walking the SPKI DER: this module encodes ASN.1 and
 * never decodes it, and a key identifier is not worth introducing a parser for.
 */
function publicKeyPoint(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new Error('expected an EC public key');
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

function keyIdentifier(key: KeyObject): Buffer {
  // SHA-1 here is RFC 5280's own recommendation for a key identifier. It is a uniqueness label
  // for chain building, not a signature, so its collision resistance is not load-bearing.
  return createHash('sha1').update(publicKeyPoint(key)).digest();
}

/**
 * A subjectAltName for one host. Literal addresses become iPAddress, names become dNSName.
 *
 * Getting this wrong is silent: every modern TLS client ignores the subject CN entirely, so a
 * certificate with the right CN and the wrong SAN type simply fails to match anything.
 */
function subjectAltName(host: string): Buffer {
  if (isIPv4(host)) {
    return derSequence(derTlv(0x87, Buffer.from(host.split('.').map(Number))));
  }
  if (isIPv6(host)) {
    const groups = expandIPv6(host);
    return derSequence(derTlv(0x87, Buffer.from(groups)));
  }
  return derSequence(derTlv(0x82, Buffer.from(host, 'ascii')));
}

/** IPv6 text to its sixteen bytes, `::` expanded. */
function expandIPv6(host: string): number[] {
  const [head, tail] = host.split('::');
  const parse = (part: string): number[] =>
    part
      .split(':')
      .filter((s) => s.length > 0)
      .flatMap((s) => {
        const v = Number.parseInt(s, 16);
        return [(v >> 8) & 0xff, v & 0xff];
      });
  const left = parse(head ?? '');
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array<number>(16 - left.length - right.length).fill(0), ...right];
}

/**
 * The certificate authority for one recorded run.
 *
 * Per run, in the run directory, never in a trust store. The child process is told about it
 * through its own environment and nothing else, so the interception ends when the process does.
 * `dispose()` takes the key with it.
 */
export class RunCa {
  readonly dir: string;
  readonly certPath: string;
  readonly keyPath: string;
  readonly bundlePath: string;
  readonly certPem: string;
  readonly fingerprint: string;
  readonly notAfter: Date;

  /** Never exposed, never serialized, never written anywhere but `keyPath`. */
  readonly #key: KeyObject;
  readonly #subject: Buffer;
  readonly #authorityKeyId: Buffer;
  /** One key pair for every host certificate — minting is then a signature, not a keygen. */
  readonly #leafPublicSpki: Buffer;
  readonly #leafKeyPem: string;
  readonly #leafKeyId: Buffer;
  readonly #issued = new Map<string, IssuedCertificate>();
  readonly #lifetimeMs: number;
  readonly #atExit: () => void;

  private constructor(init: {
    dir: string;
    certPem: string;
    key: KeyObject;
    subject: Buffer;
    authorityKeyId: Buffer;
    leafPublicSpki: Buffer;
    leafKeyPem: string;
    leafKeyId: Buffer;
    lifetimeMs: number;
    notAfter: Date;
  }) {
    this.#atExit = () => {
      // `exit` handlers must be synchronous, which is why this is the one place the module reaches
      // for the sync API. Best effort by construction: if it fails there is nothing left to do.
      try {
        rmSync(init.dir, { recursive: true, force: true });
      } catch {
        /* the directory is already gone, or was never ours to remove */
      }
    };
    // The backstop for every path that never reaches the ordinary teardown: an agent that fails to
    // launch, a throw mid-recording, a Ctrl-C. Deleting the key is normally the run's own job; a
    // private key surviving a crashed run is not an acceptable failure mode for it to have.
    process.once('exit', this.#atExit);
    this.dir = init.dir;
    this.certPath = join(init.dir, 'ca.crt');
    this.keyPath = join(init.dir, 'ca.key');
    this.bundlePath = join(init.dir, 'ca-bundle.crt');
    this.certPem = init.certPem;
    this.fingerprint = new X509Certificate(init.certPem).fingerprint256;
    this.notAfter = init.notAfter;
    this.#key = init.key;
    this.#subject = init.subject;
    this.#authorityKeyId = init.authorityKeyId;
    this.#leafPublicSpki = init.leafPublicSpki;
    this.#leafKeyPem = init.leafKeyPem;
    this.#leafKeyId = init.leafKeyId;
    this.#lifetimeMs = init.lifetimeMs;
  }

  static async create(options: RunCaOptions): Promise<RunCa> {
    const lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
    // P-256 rather than RSA: generation is instantaneous, so standing up interception costs
    // nothing at the top of a run, and every TLS stack from the last decade accepts it.
    const authority = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

    const notBefore = new Date(Date.now() - CLOCK_SKEW_MS);
    const notAfter = new Date(Date.now() + lifetimeMs);
    // Names the run directory it belongs to, so a certificate found in a browser's warning dialog
    // can be traced back to the run that minted it — and so two concurrent runs never collide.
    const subject = distinguishedName(`OrcaReplay run CA ${randomBytes(4).toString('hex')}`);
    const spki = authority.publicKey.export({ type: 'spki', format: 'der' });
    const authorityKeyId = keyIdentifier(authority.publicKey);

    const tbs = derSequence(
      // [0] version, EXPLICIT: v3 is the integer 2. Extensions are illegal below v3.
      derContext(0, derInteger(Buffer.from([2]))),
      derInteger(randomBytes(16)),
      derSequence(derOid(OID.ecdsaWithSha256)),
      subject,
      derSequence(derTime(notBefore), derTime(notAfter)),
      subject,
      spki,
      derContext(
        3,
        derSequence(
          // pathLenConstraint 0: this CA may sign leaves and nothing else. A run CA that could
          // mint further CAs would be a broader capability than the feature needs.
          extension(
            OID.basicConstraints,
            true,
            derSequence(derBoolean(true), derInteger(Buffer.from([0]))),
          ),
          extension(OID.keyUsage, true, keyUsage(5, 6)),
          extension(OID.subjectKeyIdentifier, false, derOctetString(authorityKeyId)),
        ),
      ),
    );

    const certPem = signCertificate(tbs, authority.privateKey);
    const dir = join(options.runDir, 'tls');
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    // Explicit, because the mode passed to mkdir is only a ceiling — umask can lower it, and
    // "0700" is a promise this feature makes rather than a preference.
    await chmod(dir, DIR_MODE);

    const keyPem = authority.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    await writeFile(join(dir, 'ca.key'), keyPem, { mode: FILE_MODE });
    await chmod(join(dir, 'ca.key'), FILE_MODE);
    await writeFile(join(dir, 'ca.crt'), certPem, { mode: FILE_MODE });
    await chmod(join(dir, 'ca.crt'), FILE_MODE);

    // SSL_CERT_FILE and REQUESTS_CA_BUNDLE *replace* an OpenSSL client's trust store rather than
    // adding to it. Handing the child a file with only our CA in it would break every host we
    // deliberately refuse to intercept — the tunnelled ones — so the bundle is ours plus the
    // roots Node ships.
    await writeFile(join(dir, 'ca-bundle.crt'), `${certPem}${rootCertificates.join('\n')}\n`, {
      mode: FILE_MODE,
    });
    await chmod(join(dir, 'ca-bundle.crt'), FILE_MODE);

    return new RunCa({
      dir,
      certPem,
      key: authority.privateKey,
      subject,
      authorityKeyId,
      leafPublicSpki: leaf.publicKey.export({ type: 'spki', format: 'der' }),
      leafKeyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      leafKeyId: keyIdentifier(leaf.publicKey),
      lifetimeMs,
      notAfter,
    });
  }

  /**
   * A certificate for one host, minted on demand and cached.
   *
   * Only ever called for a host the allowlist already approved — this class does no policy of its
   * own, and a mint is the point of no return for interception.
   */
  issue(host: string): IssuedCertificate {
    const cached = this.#issued.get(host);
    if (cached) return cached;

    const notBefore = new Date(Date.now() - CLOCK_SKEW_MS);
    // Never outlive the CA that signed it: a leaf valid past its issuer is a certificate no
    // verifier will accept anyway, and pretending otherwise only produces confusing failures.
    const notAfter = new Date(Math.min(Date.now() + this.#lifetimeMs, this.notAfter.getTime()));

    const tbs = derSequence(
      derContext(0, derInteger(Buffer.from([2]))),
      derInteger(randomBytes(16)),
      derSequence(derOid(OID.ecdsaWithSha256)),
      this.#subject,
      derSequence(derTime(notBefore), derTime(notAfter)),
      distinguishedName(host),
      this.#leafPublicSpki,
      derContext(
        3,
        derSequence(
          // Empty SEQUENCE: cA is DEFAULT FALSE and DER forbids encoding a default.
          extension(OID.basicConstraints, true, derSequence()),
          extension(OID.keyUsage, true, keyUsage(0)),
          extension(OID.extendedKeyUsage, false, derSequence(derOid(OID.serverAuth))),
          extension(OID.subjectAltName, false, subjectAltName(host)),
          extension(OID.subjectKeyIdentifier, false, derOctetString(this.#leafKeyId)),
          extension(
            OID.authorityKeyIdentifier,
            false,
            // keyIdentifier is [0] IMPLICIT, so the raw bytes sit directly under the tag.
            derSequence(derContext(0, this.#authorityKeyId, false)),
          ),
        ),
      ),
    );

    const issued: IssuedCertificate = {
      certPem: signCertificate(tbs, this.#key),
      keyPem: this.#leafKeyPem,
    };
    this.#issued.set(host, issued);
    return issued;
  }

  /**
   * End the CA's life with the run.
   *
   * The whole directory goes, key included. Idempotent, because it is called both on the normal
   * path and from a failure handler.
   */
  async dispose(): Promise<void> {
    // Removed first: a listener left behind would keep the closure — and a reference to this run —
    // alive for the life of the process, and orca records more than one run per process.
    process.off('exit', this.#atExit);
    await rm(this.dir, { recursive: true, force: true });
  }
}
