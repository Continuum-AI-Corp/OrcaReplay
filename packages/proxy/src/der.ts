/**
 * Just enough DER to build an X.509 certificate.
 *
 * `node:crypto` can generate keys, sign, hash and *parse* certificates, but it cannot mint one —
 * there is no API for it and there never has been. Every MITM proxy in the ecosystem reaches for
 * `node-forge` or `selfsigned` at this point. This project has near-zero runtime dependencies on
 * purpose, and pulling a general-purpose ASN.1 and crypto library into a debugger people install
 * to diagnose a broken machine is a poor trade for the two hundred lines below.
 *
 * The surface is deliberately tiny: the exact handful of ASN.1 types RFC 5280 needs for a
 * certificate we ourselves construct. It is an encoder, never a decoder — nothing here parses
 * untrusted bytes, so the usual ASN.1 attack surface does not exist. Verification is left to
 * OpenSSL, which is where it belongs.
 */

/** ASN.1 universal tag numbers, plus the two class bits DER spends on context tags. */
const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  oid: 0x06,
  utf8String: 0x0c,
  sequence: 0x30,
  set: 0x31,
  utcTime: 0x17,
  generalizedTime: 0x18,
} as const;

const CONTEXT = 0x80;
const CONSTRUCTED = 0x20;

/**
 * DER length: short form under 128, otherwise a byte count followed by big-endian length bytes.
 * BER's indefinite form is not legal in DER and is not produced here.
 */
function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Tag-length-value, the shape every other function here is built from. */
export function derTlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

export function derSequence(...parts: Buffer[]): Buffer {
  return derTlv(TAG.sequence, Buffer.concat(parts));
}

export function derSet(...parts: Buffer[]): Buffer {
  return derTlv(TAG.set, Buffer.concat(parts));
}

/**
 * A non-negative INTEGER from raw big-endian bytes.
 *
 * Two DER rules, both of which produce certificates OpenSSL rejects if you get them wrong: leading
 * zero bytes are forbidden, and a value whose top bit is set needs a zero byte in front or it
 * would read as negative. Serial numbers are random, so roughly half of them hit the second rule.
 */
export function derInteger(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && (bytes[start + 1]! & 0x80) === 0) {
    start += 1;
  }
  let body = bytes.subarray(start);
  if (body.length === 0) body = Buffer.from([0]);
  if ((body[0]! & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body]);
  return derTlv(TAG.integer, body);
}

export function derBoolean(value: boolean): Buffer {
  // DER pins TRUE to all-ones; BER would accept any non-zero byte.
  return derTlv(TAG.boolean, Buffer.from([value ? 0xff : 0x00]));
}

/** A BIT STRING whose content is a whole number of bytes, which is all a certificate needs. */
export function derBitString(bits: Buffer): Buffer {
  return derTlv(TAG.bitString, Buffer.concat([Buffer.from([0]), bits]));
}

export function derOctetString(bytes: Buffer): Buffer {
  return derTlv(TAG.octetString, bytes);
}

export function derUtf8String(text: string): Buffer {
  return derTlv(TAG.utf8String, Buffer.from(text, 'utf8'));
}

/**
 * An OBJECT IDENTIFIER from dotted decimal.
 *
 * The first two arcs are packed into one byte as `40 * a + b`; the rest are base-128 with the
 * continuation bit set on every byte but the last.
 */
export function derOid(dotted: string): Buffer {
  const arcs = dotted.split('.').map((part) => {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0) throw new Error(`not an object identifier: ${dotted}`);
    return n;
  });
  if (arcs.length < 2) throw new Error(`not an object identifier: ${dotted}`);
  const bytes: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [];
    let v = arc;
    do {
      chunk.unshift(v & 0x7f);
      v >>>= 7;
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i]! |= 0x80;
    bytes.push(...chunk);
  }
  return derTlv(TAG.oid, Buffer.from(bytes));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A certificate time.
 *
 * RFC 5280 requires UTCTime through 2049 and GeneralizedTime from 2050 — a certificate that uses
 * the wrong one for its year is malformed. Run CAs live for a day so they will always take the
 * first branch, but the rule is cheap to honour and expensive to remember later.
 */
export function derTime(when: Date): Buffer {
  const year = when.getUTCFullYear();
  const tail =
    `${pad2(when.getUTCMonth() + 1)}${pad2(when.getUTCDate())}` +
    `${pad2(when.getUTCHours())}${pad2(when.getUTCMinutes())}${pad2(when.getUTCSeconds())}Z`;
  return year < 2050
    ? derTlv(TAG.utcTime, Buffer.from(`${pad2(year % 100)}${tail}`, 'ascii'))
    : derTlv(TAG.generalizedTime, Buffer.from(`${year}${tail}`, 'ascii'));
}

/** A context-specific tag, `[n]`. Constructed wraps another DER value; primitive wraps raw bytes. */
export function derContext(n: number, body: Buffer, constructed = true): Buffer {
  return derTlv(CONTEXT | (constructed ? CONSTRUCTED : 0) | n, body);
}

/** DER bytes as a PEM block, wrapped at the 64 columns every tool expects. */
export function toPem(label: string, der: Buffer): string {
  const body = der.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += 64) lines.push(body.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
