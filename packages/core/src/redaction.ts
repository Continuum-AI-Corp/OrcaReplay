import { createHash, randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { RedactionRecord } from '@orcareplay/schema';

/** Bump when a rule is added or changed, so old traces stay interpretable. */
// Bumped when a rule's *name* or pattern changes, because both reach the trace: the placeholder is
// `<secret:<kind>:<hash>>`, and a reader comparing two traces needs to know the policy differed
// rather than the content. v2 renamed `openai_key` to `sk_api_key`; v3 stopped the entropy sweep
// eating protocol identifiers (`id`, `tool_use_id`, `tool_call_id`); v4 stopped it eating whole
// PNGs, which is a change in what reaches the trace for exactly the same reason — the same body
// recorded under v3 and v4 differs, and a reader has to be able to tell that from the content
// differing. v5 judges a value a second time with its invisible characters removed, so a key with
// a zero-width space, a BOM or a Hangul filler inside it is now redacted where v4 wrote it out.
export const REDACTION_POLICY_VERSION = 5;

/** Environment capture is allowlist-only (spec §5). Everything else is denied. */
export const DEFAULT_ENV_ALLOWLIST = [
  'TERM',
  'LANG',
  'LC_ALL',
  'PATH',
  'HOME',
  'SHELL',
  'TZ',
  'USER',
  'PWD',
];

/**
 * Request headers whose value is never written, whatever it looks like (spec §5).
 *
 * The single list. There were three — here, in the recording proxy, and in the TLS interceptor —
 * and they had drifted: `api-key` and `x-goog-api-key` were known to exactly one of them, so the
 * same Azure or Google credential was stripped on the intercepted path and written on the recorded
 * one. Nothing about a header set that has to stay identical in three places will keep it that
 * way, so it is defined once and imported.
 */
export const AUTH_REQUEST_HEADERS = [
  'authorization',
  'x-api-key',
  // Azure OpenAI sends the key under its own name, and Google under another.
  'api-key',
  'x-goog-api-key',
  'cookie',
  'proxy-authorization',
];

/** A response can hand out credentials too. `set-cookie` is a session, not metadata. */
export const AUTH_RESPONSE_HEADERS = ['set-cookie'];

/** Every header name whose value is never written, in either direction. */
export const AUTH_HEADERS = [...AUTH_REQUEST_HEADERS, ...AUTH_RESPONSE_HEADERS];

interface Rule {
  kind: string;
  pattern: RegExp;
}

/**
 * Order matters: a PEM block or a JWT contains base64 that the narrower rules would otherwise
 * chew into pieces, leaving fragments of key material on disk.
 */
/**
 * Marks a recorded body held as base64 rather than as text.
 *
 * Written by the proxy when a body is not valid UTF-8, and honoured here so the encoding survives
 * the trace. Kept in this module because the redactor and the proxy have to agree on it.
 */
export const BINARY_BODY_PREFIX = 'orca-base64:';

const RULES: Rule[] = [
  {
    kind: 'private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { kind: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // `sk-` is not an OpenAI prefix, it is the convention half the industry copied: OpenAI's
  // `sk-proj-`, Anthropic's `sk-ant-`, OrcaRouter's `sk-orca-` and a dozen gateways all match here.
  // The rule name reaches the trace, `redactions.json` and the placeholder, so calling every one of
  // them an OpenAI key told a reader something false about where their credential came from.
  { kind: 'sk_api_key', pattern: /sk-[A-Za-z0-9_-]{16,}/g },
  // Every GitHub credential prefix, `ghr_` (refresh) included: it outlives the access token it
  // renews, so leaving it to the entropy sweep would miss the longest-lived secret of the set.
  { kind: 'github_token', pattern: /gh[posur]_[A-Za-z0-9]{20,}/g },
  { kind: 'aws_access_key_id', pattern: /AKIA[0-9A-Z]{16}/g },
  { kind: 'slack_token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google_api_key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
];

/**
 * A base64 run that decodes to a whole PNG, wherever it sits in the value.
 *
 * The exemption is granted on the payload, not on the syntax around it or the label in front of
 * it, because every argument for it is an argument about *pixels* — and every draft that granted
 * it on something a caller writes was a hole:
 *
 *   - the media type, so `data:image/png;base64,<credential>` bought one
 *   - the signature, so `iVBORw0KGgo<credential>` bought one
 *   - the framing, so `signature + IHDR + IDAT{<credential>} + IEND` with self-consistent lengths
 *     bought one
 *   - a *valid* container, so a 1×1 image with the credential in a `tEXt` chunk bought one, and a
 *     real screenshot with the credential appended inside `IDAT` past the end of the zlib stream
 *     bought one, and flipping IHDR's interlace byte skipped the size check altogether
 *
 * So the rule is now the narrowest one that still serves the case this exists for: **every chunk
 * has to be a chunk whose bytes the exemption can account for.** Structure (`IHDR`, `IEND`), the
 * pixel stream (`IDAT`), and a short list of fixed-size ancillary chunks each held to its spec
 * length, with every chunk's CRC checked so its four CRC bytes are not four more of the caller's.
 * Anything else — `tEXt`, `iTXt`, `zTXt`, `iCCP`, `cHRM`, `PLTE`, an unknown type — is a place a
 * caller can put bytes of their choosing, so its presence costs the whole run its exemption and the
 * sweep runs as it always did. Indexed PNGs therefore have no exemption at all, since they cannot
 * be valid without a palette.
 *
 * The pixel stream is checked, not assumed: the concatenated `IDAT` has to inflate, to consume
 * every byte of itself doing so (`inflateSync` stops at the end of the zlib stream and ignores
 * whatever follows, which is where a credential went), and to yield exactly the byte count `IHDR`
 * describes — including the seven-pass sum when the image is interlaced.
 *
 * Measured, on a 1 MB PNG: the chunk walk costs 0.2 ms and the inflate 1.2 ms, against the 55 ms
 * the base64 decode already costs.
 *
 * **PNG only.** JPEG was here and is gone. Its ancillary segments (`COM`, `APPn`) carry arbitrary
 * bytes, its `DQT`/`DHT` payloads are arbitrary within a shape, and its entropy-coded scan cannot
 * be told from a credential without a full Huffman decode — so a JPEG exemption can only ever mean
 * "a marker chain that closes", which is framing, which is what this file kept getting wrong. GIF,
 * BMP, WebP and AVIF went earlier for the same reason. A format with no validator does not get an
 * exemption; it gets the sweep, as it did before any of this. The cost is real and is the right way
 * round: an agent that sends JPEG screenshots still gets them shredded.
 *
 * What this still does not claim: a secret written into the pixels themselves is not detectable
 * here, and no content rule could be — a stored-mode deflate block whose "pixels" are a credential
 * inflates to the declared size like any other. The line is that the payload has to be a picture;
 * a picture cannot be proved innocent.
 */
/**
 * Whether `code` is a base64 alphabet character.
 *
 * A run used to be found with `/(?:[A-Za-z0-9+/]|\\[/\\])+={0,2}/g`, and a backtracking `+` over a
 * multi-megabyte run overflows V8's regexp stack: measured, `redactString` threw
 * `RangeError: Maximum call stack size exceeded` from `RegExpStringIterator.next` at 8 MB of
 * contiguous base64 — a ~6 MB screenshot, which is the thing this exemption exists to protect. The
 * entropy sweep's own `TOKEN` never had the problem because `+` and `/` are not in its class, so
 * real base64 reaches it as thousands of short matches; this prefilter was the first pattern to run
 * a quantifier across a whole payload, and the same input that the pre-change code walked without
 * complaint at 16 MB threw here. So runs are found by hand, in one left-to-right pass.
 */
function isBase64Char(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2b || // +
    code === 0x2f // /
  );
}

/** Shortest run worth decoding: below this it cannot hold a header and any pixels. */
const MIN_RASTER_CHARS = 40;

/**
 * The largest pixel stream worth inflating, as a matter of policy rather than of format.
 *
 * An 8K screenshot at four channels is about 127 MiB of raw pixels, so 256 MiB is roughly double the
 * largest thing anyone is plausibly recording. An IHDR that declares more than this is refused
 * before any memory is committed — otherwise the header itself, which is the caller's to write,
 * would set how much the redactor allocates.
 */
const MAX_RASTER_RAW_BYTES = 1 << 28;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Ancillary chunks whose length the spec fixes, mapped to that length.
 *
 * A caller cannot choose how many bytes these hold, and every one of them is shorter than
 * `MIN_ENTROPY_LENGTH`, so none can carry a run the sweep would have redacted. That is the whole
 * admission criterion — not that the chunk is harmless, but that exempting it cannot hide anything
 * the sweep was protecting. Every variable-length chunk is therefore absent, and so is `cHRM`:
 * fixed at 32 bytes, but 32 bytes is long enough to matter.
 *
 * The lengths here are what the caller gets, because the CRCs are checked: four more bytes per
 * chunk that would otherwise be theirs to fill. The largest of these is `pHYs` at nine, so the
 * longest run of chosen bytes any admitted chunk can contribute is twelve base64 characters,
 * against the sweep's threshold of twenty.
 */
const PNG_FIXED_ANCILLARY: Record<string, number> = {
  gAMA: 4,
  sRGB: 1,
  pHYs: 9,
  tIME: 7,
  sBIT: 4,
  bKGD: 6,
};

/**
 * Bytes per pixel for each PNG colour type; an unlisted type is not one this exemption accepts.
 *
 * Indexed (3) is absent, which means indexed PNGs are swept like any other unvalidated payload. It
 * was here, on the argument that an indexed image's palette *is* its pixels — but that argument
 * does not survive: `PLTE` is up to 768 uncompressed caller-chosen bytes sitting verbatim in the
 * trace, its entries need not be referenced by any pixel, and nothing about it is checked beyond a
 * length that the bit depth alone bounds. `IDAT` is not analogous, because it has to inflate to
 * exactly the size the header declares. Admitting 768 free bytes while rejecting `cHRM` at 32 as
 * "long enough to matter" was the file contradicting its own admission criterion.
 */
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** The bit depths each colour type allows. A pairing outside this is not an image a decoder reads. */
const PNG_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  4: [8, 16],
  6: [8, 16],
};

/** Adam7: `[xOffset, yOffset, xStep, yStep]` for each of the seven passes. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

/**
 * The exact length of the inflated pixel stream for these image parameters.
 *
 * Each scanline is a filter byte plus its packed samples, and an interlaced image is seven smaller
 * images by the same rule — a pass with no rows or no columns contributes nothing at all, which is
 * what the guard is for rather than tidiness. Skipping this for interlaced images was a hole: it
 * let one IHDR byte buy the exemption for an IDAT holding no pixels.
 */
function pngRawLength(
  width: number,
  height: number,
  channels: number,
  depth: number,
  interlaced: boolean,
): number {
  const rows = (w: number, h: number) =>
    w <= 0 || h <= 0 ? 0 : h * (1 + Math.ceil((w * channels * depth) / 8));
  if (!interlaced) return rows(width, height);
  let total = 0;
  for (const [x0, y0, dx, dy] of ADAM7) {
    total += rows(Math.ceil((width - x0) / dx), Math.ceil((height - y0) / dy));
  }
  return total;
}

/** The CRC-32 lookup table, built once: `0xedb88320` is the reversed polynomial PNG uses. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 of `data`.
 *
 * Not `zlib.crc32`, which arrived after the oldest runtime this repo supports: `packages/cli`
 * declares `>=20.0.0` and `doctor` enforces major 20, while `zlib.crc32` is newer than that. A
 * named import of it would be `undefined` on such a runtime, and the first screenshot would take
 * the recording down with it — `intercept.ts` looks `zstdDecompressSync` up dynamically for
 * exactly this reason, and `tls-intercept.test.ts` records what the named import did instead.
 *
 * Computing it here rather than looking it up dynamically leaves one implementation, always
 * exercised, instead of a fallback branch that only some runtimes ever run. It costs 0.75 ms on a
 * 381 KB PNG against `zlib.crc32`'s 0.10 ms, which is nothing beside the 55 ms that PNG's base64
 * decode already costs. Every "a real PNG stays exempt" case in the tests builds its CRCs with
 * `zlib.crc32`, so those tests pass only while this agrees with Node's.
 */
function crc32Of(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ data[i]!) & 0xff]!;
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Whether the chunk beginning at `at` carries the CRC its own bytes imply.
 *
 * A caller who can set a length can set a CRC too, so this proves nothing about intent. What it
 * does is stop the four CRC bytes of every admitted chunk being four bytes of the caller's
 * choosing — which is the difference between "`pHYs` contributes nine chosen bytes" and "thirteen",
 * and the whole fixed-length argument is a counting argument.
 *
 * The CRC covers the type and the data, not the length field.
 */
function hasValidCrc(b: Buffer, at: number, len: number): boolean {
  return crc32Of(b.subarray(at + 4, at + 8 + len)) === b.readUInt32BE(at + 8 + len);
}

/**
 * Whether these bytes are a PNG this exemption can account for, byte for byte.
 *
 * IHDR is read before the walk rather than during it. The spec puts it first, at a fixed size, and
 * every later decision depends on its fields — so reading it up front is the difference between
 * checking those fields and checking them after something has already used them.
 *
 * The walk then rejects on the first chunk it cannot account for, so an unknown type never reaches
 * the part that grants anything.
 */
function isWholePng(b: Buffer): boolean {
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) return false;

  // Signature, then IHDR's length and type: 13 bytes of data at a known offset.
  if (b.length < 33) return false;
  if (b.readUInt32BE(8) !== 13 || b.subarray(12, 16).toString('latin1') !== 'IHDR') return false;
  if (!hasValidCrc(b, 8, 13)) return false;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const depth = b[24]!;
  const colour = b[25]!;
  const interlace = b[28]!;
  const channels = PNG_CHANNELS[colour];
  if (width === 0 || height === 0 || channels === undefined) return false;
  if (!PNG_DEPTHS[colour]!.includes(depth)) return false;
  // Compression and filter: the spec defines one value each, and two interlace methods.
  if (b[26] !== 0 || b[27] !== 0 || interlace > 1) return false;

  let at = 33; // 8 signature + 4 length + 4 type + 13 data + 4 CRC
  let sawEnd = false;
  const idat: Buffer[] = [];
  while (!sawEnd) {
    if (at + 12 > b.length) return false;
    const len = b.readUInt32BE(at);
    const type = b.subarray(at + 4, at + 8).toString('latin1');
    const next = at + 12 + len; // length + type + data + CRC
    if (next > b.length) return false;

    if (!hasValidCrc(b, at, len)) return false;

    if (type === 'IDAT') {
      idat.push(Buffer.from(b.subarray(at + 8, at + 8 + len)));
    } else if (type === 'IEND') {
      if (len !== 0 || next !== b.length || idat.length === 0) return false;
      sawEnd = true;
    } else if (type === 'IHDR') {
      return false; // exactly one, already read
    } else {
      const fixed = PNG_FIXED_ANCILLARY[type];
      // A chunk whose size the caller picks is a chunk the caller can fill.
      if (fixed === undefined || len > fixed) return false;
    }
    at = next;
  }

  // The size is known before the inflate, not after it, so the inflate is bounded by it. Deciding
  // afterwards meant a 400 KB IDAT declaring 1×1 could expand to whatever it liked: measured, one
  // 531 KB base64 payload took RSS up by 821 MB, and `--max-old-space-size` does not bound it
  // because zlib writes outside the JS heap. This is the one place in the write path that runs
  // over bytes an agent's tools, an MCP server, or (for `orca scrub`) somebody else's trace file
  // chose.
  const expected = pngRawLength(width, height, channels, depth, interlace === 1);
  if (expected > MAX_RASTER_RAW_BYTES) return false;

  const stream = Buffer.concat(idat);
  let raw: Buffer;
  try {
    // `info: true` for `bytesWritten`, which is the input the stream actually consumed. Without it
    // anything past the end of the zlib stream is never looked at, and `IDAT{<pixels><credential>}`
    // inflates to the declared size with the credential still in the trace. `@types/node` models
    // only the plain-Buffer overload, so the shape is spelled out here; only `bytesWritten` and
    // `buffer` are read from it.
    const result = inflateSync(stream, { info: true, maxOutputLength: expected }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (result.engine.bytesWritten !== stream.length) return false;
    raw = result.buffer;
  } catch {
    // Not a zlib stream, or a stream that wanted more room than the header asked for — which is
    // what a decompression bomb is. Either way: not an image, so the sweep runs as it always did.
    return false;
  }
  return raw.length === expected;
}

/** Whether these bytes are one complete image this exemption can account for. */
function isWholeRasterImage(b: Buffer): boolean {
  if (b.length < 16) return false;
  return isWholePng(b);
}

/**
 * The spans of `value` that are whole raster images.
 *
 * The signature is checked before anything is decoded, so a long run that is not an image costs
 * six characters rather than a decode — which matters because this runs over every string a trace
 * writes.
 */
function rasterSpans(value: string): [number, number][] {
  const spans: [number, number][] = [];
  let at = 0;
  while (at < value.length) {
    const start = at;
    // One maximal run of the base64 alphabet, `\/` and `\\` counting as the character they stand
    // for. Advancing to the run's end rather than past its first character is what keeps this
    // linear: a signature *inside* a run does not start one, so there is nothing to come back for.
    while (at < value.length) {
      const code = value.charCodeAt(at);
      if (isBase64Char(code)) {
        at += 1;
        continue;
      }
      if (code === 0x5c) {
        const next = value.charCodeAt(at + 1);
        if (next === 0x2f || next === 0x5c) {
          at += 2;
          continue;
        }
      }
      break;
    }
    if (at === start) {
      at += 1;
      continue;
    }
    // Padding only where padding belongs. `Buffer.from(x, 'base64')` stops at the first `=` and
    // ignores the rest, so a run of `<image>==<credential>` decoded to a valid image and the span
    // covered the credential with it. Ending the run at the padding splits the two, and an interior
    // `=` ends a run for the same reason.
    let end = at;
    for (let pad = 0; pad < 2 && value.charCodeAt(end) === 0x3d; pad += 1) end += 1;
    at = end;

    // `iVBORw` is what a PNG signature looks like once base64-encoded.
    if (end - start < MIN_RASTER_CHARS || !value.startsWith('iVBORw', start)) continue;
    // `\/` and `\\` stand for payload characters; they are stripped before decoding and the span
    // still covers them, or the sweep would resume inside the image.
    const payload = value.slice(start, end).replace(/\\(.)/g, '$1');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(payload, 'base64');
    } catch {
      continue;
    }
    if (!isWholeRasterImage(bytes)) continue;
    spans.push([start, end]);
  }
  return spans;
}

const TOKEN = /[A-Za-z0-9_-]{20,}/g;
const PLACEHOLDER = /<secret:[a-z_]+:[0-9a-f]{8}>/g;
const MIN_ENTROPY_LENGTH = 20;
const ENTROPY_BITS_PER_CHAR = 4.0;

/** Shannon entropy of the token's own character distribution, in bits per character. */
function entropy(token: string): number {
  const freq = new Map<string, number>();
  for (const ch of token) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * A long identifier clears 4 bits/char on length alone: `getUserAuthenticationTokenFromRequest`
 * scores 4.08. Agent traces are mostly source code, so redacting identifiers would corrupt the
 * payloads the trace exists to preserve. Requiring both digits and letters keeps every random
 * token (base64url has a digit with p≈0.98 at 20 chars) and drops prose-shaped ones.
 */
function looksRandom(token: string): boolean {
  return /[0-9]/.test(token) && /[A-Za-z]/.test(token);
}

/**
 * Protocol identifiers, which are not secrets and must survive a recording verbatim.
 *
 * A `tool_use` id is generated per call, means nothing outside its own conversation, and the API
 * requires it to match `^[a-zA-Z0-9_-]+$`. It is also ~25 characters of mixed-case base62, so the
 * entropy sweep took it every time — and a fork replays recorded assistant turns, the agent echoes
 * those ids back, and the placeholder then arrives at the live API, which rejects the request:
 *
 *   messages.1.content.2.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'
 *
 * So `orca compare`, the feature the tool is pitched on, could not work against any real recording.
 * Found by forking one, which no fixture could have shown.
 *
 * This shields these values from the *entropy heuristic* only. The pattern rules run first and are
 * untouched, so a real credential parked under a key called `id` is still redacted by shape — what
 * is relaxed is the guess, not the detection. The value must already look like a protocol id
 * (`^[A-Za-z0-9_-]*$`, the shape the API demands); anything else under that key is left to the
 * ordinary sweep.
 *
 * The quotes are matched as `\\*"` because a response body is stored as a *string* inside the
 * event's JSON, so by the time the scanner sees it the text reads `\\"id\\":\\"toolu_…\\"`. A
 * pattern that only accepted bare quotes matched nothing where it mattered and passed its own test,
 * which is how the first version of this shipped and still broke every fork.
 */
const PROTOCOL_ID_VALUE = /(\\*")(?:id|tool_use_id|tool_call_id)\1\s*:\s*\1[A-Za-z0-9_-]*\1/g;

/**
 * The same problem with a different alphabet. An Anthropic `thinking` block carries a `signature`
 * over its own contents, and the API rejects a turn whose signature does not verify — so a fork,
 * which replays recorded assistant turns for the agent to echo back, died on
 * `messages.1.content.0: Invalid \`signature\` in \`thinking\` block`. It is base64, not an
 * identifier, hence a second shape.
 *
 * It is not a credential either: it authenticates thinking text the trace already holds in full, so
 * keeping it costs no secrecy that was not already spent.
 */
const PROTOCOL_SIGNATURE_VALUE = /(\\*")signature\1\s*:\s*\1[A-Za-z0-9+/=_-]*\1/g;

/**
 * Regions the entropy sweep must not touch: what it already replaced, and what is not a secret.
 *
 * Returned sorted by start, which is what {@link Redactor.redactString}'s sweep relies on to test
 * containment in one pass rather than one scan of the whole list per token.
 *
 * The rasters are appended one at a time, not spread. `push(...spans)` passes one argument per
 * element and V8 stops at about 125k of them — and a string can hold one span per image, so ~130k
 * of the smallest PNG this file accepts (a 1×1 greyscale, 92 base64 characters: about 12 MB of
 * payload, which any tool result or MCP frame can carry) raised
 * `RangeError: Maximum call stack size exceeded` from here, out through `redactString`, with
 * nothing on the write path to catch it.
 */
function spansOf(value: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const m of value.matchAll(PLACEHOLDER)) spans.push([m.index, m.index + m[0].length]);
  for (const m of value.matchAll(PROTOCOL_ID_VALUE)) spans.push([m.index, m.index + m[0].length]);
  for (const m of value.matchAll(PROTOCOL_SIGNATURE_VALUE)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  for (const span of rasterSpans(value)) spans.push(span);
  return spans.sort((a, b) => a[0] - b[0]);
}

/**
 * WHAT A READER DOES NOT SEE AS A CHARACTER.
 *
 * Every shape rule above and the entropy sweep judge runs of `[A-Za-z0-9_-]`, so any character
 * outside that class placed inside a credential splits it — and one with no visible form splits
 * it without anyone noticing. `sk-abc` + U+200B + `defghijklmnopqrstuvwxyz` matched no rule, the
 * run after the space was one the sweep does not consider random, and the key was written to the
 * trace verbatim: the file `orca push` shares. Interleave one every fifteen characters and no run
 * the sweep measures is long enough to be measured at all.
 *
 * It is a named set, not "whatever renders blank", and the edges are deliberate. In: Unicode's
 * Default_Ignorable_Code_Point (the zero-width characters, the BOM, the soft hyphen, the Hangul
 * fillers, variation selectors, tag characters), every format character, every combining mark,
 * the C0 and C1 controls other than tab, line feed and carriage return, and U+2800, the one blank
 * glyph outside all of those that exists to be used as nothing. Out: whitespace, and every visible
 * character including lookalikes from other scripts. A key broken by a space or a dot is broken
 * where the reader can see it, and no pattern follows every way a person might put visible pieces
 * back together — whoever can write the field could as easily write the key into two of them.
 */
const INVISIBLE_CLASS = String.raw`\p{Default_Ignorable_Code_Point}\p{Cf}\p{M}\u2800\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F`;
const HAS_INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, 'u');
const EVERY_INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, 'gu');
const VISIBLE_RUN = new RegExp(`[^${INVISIBLE_CLASS}]+`, 'gu');

/**
 * `s` as a reader would retype it: every character in the set above removed.
 *
 * The one definition every secret judgement in the product uses — this redactor, the CLI's
 * renderer, the adapters' opaque-token nets — so that "invisible" cannot mean one thing in the
 * write path and another on the terminal, which is how each of them came to be fixed separately.
 */
export function withoutInvisible(s: string): string {
  return HAS_INVISIBLE.test(s) ? s.replace(EVERY_INVISIBLE, '') : s;
}

/** `s` without its invisible characters, and the way back to `s` from any offset in the result. */
interface HiddenView {
  text: string;
  /** One entry per visible run: where it starts in `s`, and where in `text`. */
  runs: { from: number; to: number }[];
}

function hiddenView(s: string): HiddenView | undefined {
  if (!HAS_INVISIBLE.test(s)) return undefined;
  let text = '';
  const runs: { from: number; to: number }[] = [];
  for (const m of s.matchAll(VISIBLE_RUN)) {
    runs.push({ from: m.index, to: text.length });
    text += m[0];
  }
  return { text, runs };
}

/** Where offset `k` of the view's text sits in the source. Runs are sorted, so a binary search. */
function sourceOffset(view: HiddenView, k: number): number {
  let lo = 0;
  let hi = view.runs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (view.runs[mid]!.to <= k) lo = mid;
    else hi = mid - 1;
  }
  const run = view.runs[lo]!;
  return run.from + (k - run.to);
}

export interface RedactionOptions {
  /** Per-run salt. Defaults to fresh randomness, and is deliberately never persisted. */
  salt?: string;
  /** Replaces {@link DEFAULT_ENV_ALLOWLIST} outright — this is a deny-by-default control. */
  envAllowlist?: string[];
}

export interface RedactionResult<T> {
  value: T;
  hits: RedactionRecord[];
}

/**
 * Write-path redactor (spec §5).
 *
 * The placeholder is `<secret:kind:hash8>` where hash8 is sha256(salt + secret) truncated, so the
 * same secret always yields the same placeholder — replay still matches structurally — while the
 * secret itself is unrecoverable. The salt is per run and never written down, which is what stops
 * a short secret from being brute-forced out of a published trace.
 */
export class Redactor {
  readonly #salt: string;
  readonly #envAllowlist: Set<string>;
  readonly #records = new Map<string, RedactionRecord>();

  constructor(opts: RedactionOptions = {}) {
    this.#salt = opts.salt ?? randomBytes(16).toString('hex');
    this.#envAllowlist = new Set(opts.envAllowlist ?? DEFAULT_ENV_ALLOWLIST);
  }

  redactString(s: string, context?: string): RedactionResult<string> {
    const hits = new Map<string, RedactionRecord>();
    const value = this.#scan(s, context, hits);
    this.#merge(hits);
    return { value, hits: [...hits.values()] };
  }

  redactHeaders(headers: Record<string, string>): RedactionResult<Record<string, string>> {
    const hits = new Map<string, RedactionRecord>();
    const value: Record<string, string> = {};
    for (const [name, raw] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      const context = `header:${lower}`;
      value[name] = AUTH_HEADERS.includes(lower)
        ? this.#hit(`header_${lower.replace(/-/g, '_')}`, raw, context, hits)
        : this.#scan(raw, context, hits);
    }
    this.#merge(hits);
    return { value, hits: [...hits.values()] };
  }

  redactEnv(env: Record<string, string | undefined>): Record<string, string> {
    const hits = new Map<string, RedactionRecord>();
    const out: Record<string, string> = {};
    for (const key of this.#envAllowlist) {
      const raw = env[key];
      if (raw === undefined) continue;
      out[key] = this.#scan(raw, `env:${key}`, hits);
    }
    this.#merge(hits);
    return out;
  }

  /** Every removal so far, aggregated by rule and identifier. Never contains a value. */
  records(): RedactionRecord[] {
    return [...this.#records.values()].map((r) => ({ ...r }));
  }

  rulesFired(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.#records.values()) out[r.rule] = (out[r.rule] ?? 0) + r.count;
    return out;
  }

  #scan(input: string, context: string | undefined, hits: Map<string, RedactionRecord>): string {
    let value = input;
    for (const rule of RULES) {
      value = value.replace(rule.pattern, (m) => this.#hit(rule.kind, m, context, hits));
    }
    // A body recorded as base64 is one long high-entropy run by construction, and the entropy
    // scanner shredded a 14 KB Connect/protobuf response into 226 placeholders -- destroying it
    // outright while protecting nothing, since a credential inside a binary body is not matchable
    // once encoded anyway. The named rules above still run: those look for shapes, not randomness.
    // `includes`, not `startsWith`: a body reaches the trace inside a JSON-encoded blob, so the
    // marker sits one quote in. The marker is only ever written by the proxy around a body it
    // base64-encoded itself, so its presence identifies the value rather than merely appearing in
    // it.
    const binary = value.includes(BINARY_BODY_PREFIX);
    if (!binary) value = this.#scanEntropy(value, context, hits);
    return this.#scanHidden(value, context, hits, !binary);
  }

  /**
   * The same judgement again, over what a reader would see.
   *
   * It only ever adds to the pass above. A match here is acted on only when its extent in the
   * source is longer than in the view — when an invisible character sits INSIDE it, which is the
   * one case the raw pass cannot see — so text without such a character is untouched, byte for
   * byte, and so is everything around a hidden key: a ZWJ emoji two sentences away survives. The
   * placeholder is computed from the visible characters, so a key spelled with an invisible
   * character inside it redacts to the same placeholder as the same key without one, and a replay
   * still matches it structurally.
   */
  #scanHidden(
    value: string,
    context: string | undefined,
    hits: Map<string, RedactionRecord>,
    sweep: boolean,
  ): string {
    const view = hiddenView(value);
    if (view === undefined) return value;
    const found: { a: number; b: number; kind: string; secret: string }[] = [];
    for (const rule of RULES) {
      for (const m of view.text.matchAll(rule.pattern)) {
        found.push({ a: m.index, b: m.index + m[0].length, kind: rule.kind, secret: m[0] });
      }
    }
    if (sweep) {
      // The raw sweep's own filters, over the view: placeholders and protocol values stay exempt.
      const spans = spansOf(view.text);
      let cursor = 0;
      let reach = -1;
      for (const m of view.text.matchAll(TOKEN)) {
        const token = m[0];
        const start = m.index;
        while (cursor < spans.length && spans[cursor]![0] <= start) {
          if (spans[cursor]![1] > reach) reach = spans[cursor]![1];
          cursor += 1;
        }
        if (start + token.length <= reach) continue;
        if (token.length < MIN_ENTROPY_LENGTH || !looksRandom(token)) continue;
        if (entropy(token) <= ENTROPY_BITS_PER_CHAR) continue;
        found.push({ a: start, b: start + token.length, kind: 'high_entropy', secret: token });
      }
    }
    found.sort((x, y) => x.a - y.a || y.b - x.b);
    let out = '';
    let cut = 0;
    let end = -1;
    let changed = false;
    for (const f of found) {
      if (f.a < end) continue;
      const from = sourceOffset(view, f.a);
      const to = sourceOffset(view, f.b - 1) + 1;
      // Nothing invisible inside it: the raw pass saw exactly this and judged it. Not ours.
      if (to - from === f.b - f.a) continue;
      out += value.slice(cut, from) + this.#hit(f.kind, f.secret, context, hits);
      cut = to;
      end = f.b;
      changed = true;
    }
    return changed ? out + value.slice(cut) : value;
  }

  #scanEntropy(
    value: string,
    context: string | undefined,
    hits: Map<string, RedactionRecord>,
  ): string {
    // Placeholders already written by the pattern rules must not be rescanned as tokens.
    const spans = spansOf(value);
    let out = '';
    let cut = 0;
    // `spans.some(...)` per token walked the whole list every time, which is quadratic once a value
    // holds many images — measured, 40k small PNGs cost 2.7 s against 0.14 s before the exemption
    // existed. Spans arrive sorted by start and `matchAll` yields tokens the same way, so one
    // cursor carrying the furthest end seen so far answers the same question in a single pass:
    // `reach` is max(b) over every span with a <= start, and a token is inside one of them exactly
    // when it ends at or before that.
    let cursor = 0;
    let reach = -1;
    for (const m of value.matchAll(TOKEN)) {
      const token = m[0];
      const start = m.index;
      while (cursor < spans.length && spans[cursor]![0] <= start) {
        if (spans[cursor]![1] > reach) reach = spans[cursor]![1];
        cursor += 1;
      }
      // Wholly inside, not merely starting inside. A TOKEN is `[A-Za-z0-9_-]+`, which runs on
      // past an image payload through a `_` or `-` that base64 has no use for — so a token that
      // began in the image and ended in a credential was skipped entire, and the credential with
      // it. Overlap would be wrong the other way: it would exempt text outside the image.
      if (start + token.length <= reach) continue;
      if (token.length < MIN_ENTROPY_LENGTH || !looksRandom(token)) continue;
      if (entropy(token) <= ENTROPY_BITS_PER_CHAR) continue;
      out += value.slice(cut, start) + this.#hit('high_entropy', token, context, hits);
      cut = start + token.length;
    }
    return out + value.slice(cut);
  }

  #hit(
    kind: string,
    secret: string,
    context: string | undefined,
    hits: Map<string, RedactionRecord>,
  ): string {
    const hash8 = createHash('sha256').update(this.#salt).update(secret).digest('hex').slice(0, 8);
    const placeholder = `<secret:${kind}:${hash8}>`;
    const identifier = context ? `${context}:${hash8}` : hash8;
    // `\0` as an escape, not a raw NUL byte: a literal NUL in the source makes git classify
    // this file as binary, so every diff of the redactor — the one file that most needs reading in
    // review — comes out as "Bin 7248 -> 7441 bytes" instead of lines.
    const key = `${kind}\0${identifier}`;
    const seen = hits.get(key);
    if (seen) seen.count += 1;
    else hits.set(key, { rule: kind, identifier, placeholder, count: 1 });
    return placeholder;
  }

  #merge(hits: Map<string, RedactionRecord>): void {
    for (const [key, hit] of hits) {
      const seen = this.#records.get(key);
      if (seen) seen.count += hit.count;
      else this.#records.set(key, { ...hit });
    }
  }
}
