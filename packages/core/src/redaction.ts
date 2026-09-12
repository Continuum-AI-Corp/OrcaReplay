import { createHash, randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { RedactionRecord } from '@orcareplay/schema';

/** Bump when a rule is added or changed, so old traces stay interpretable. */
// Bumped when a rule's *name* or pattern changes, because both reach the trace: the placeholder is
// `<secret:<kind>:<hash>>`, and a reader comparing two traces needs to know the policy differed
// rather than the content. v2 renamed `openai_key` to `sk_api_key`; v3 stopped the entropy sweep
// eating protocol identifiers (`id`, `tool_use_id`, `tool_call_id`).
export const REDACTION_POLICY_VERSION = 3;

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
 * A base64 run that decodes to a whole raster image, wherever it sits in the value.
 *
 * The exemption is granted on the payload, not on the syntax around it or the label in front of
 * it, because every argument for it is an argument about *pixels* — bytes that cannot hide a
 * credential a reader could recover, and that the sweep was never protecting. Three earlier drafts
 * each granted it on something a caller writes, and each was a hole:
 *
 *   - the media type, so `data:image/png;base64,<credential>` bought one
 *   - the signature, so `iVBORw0KGgo<credential>` bought one
 *   - the *framing*, so `PNG signature + IHDR + IDAT{<credential>} + IEND` with self-consistent
 *     lengths bought one — five bytes of decoration for JPEG, seven for GIF
 *
 * The last of those is why the check now looks at the content. A PNG has to have an IDAT stream
 * that actually inflates, to exactly the size its own IHDR declares; a JPEG has to have a marker
 * chain that reaches EOI with a frame header in it. A credential wrapped in framing is neither.
 *
 * Measured, on a 1 MB PNG: the chunk walk costs 0.2 ms and the inflate 1.2 ms, against the 55 ms
 * the base64 decode already costs. The cheap version of this check was not cheaper in any way that
 * matters.
 *
 * Only PNG and JPEG. Earlier drafts listed GIF, BMP, WebP and AVIF as well, on no evidence — the
 * case this exists for is a browser screenshot, which is one of these two, and every one of those
 * formats validated by a size field the same caller computes. A format with no validator does not
 * get an exemption; it gets the sweep, as it did before any of this.
 *
 * What this still does not claim: a secret hidden *inside* real pixel data is not detectable here,
 * and no content rule could be. The line is that the payload has to be a picture — not that a
 * picture cannot be abused.
 */
// Padding only where padding belongs. `Buffer.from(x, 'base64')` stops at the first `=` and
// ignores the rest, so a run of `<image>==<credential>` decoded to a valid image and the span
// covered the credential with it. Ending the run at the padding splits the two, and an interior
// `=` ends a run for the same reason.
const BASE64_RUN = /(?:[A-Za-z0-9+/]|\\[/\\])+={0,2}/g;

/** Shortest run worth decoding: below this it cannot hold a header and any pixels. */
const MIN_RASTER_CHARS = 40;

/**
 * Whether these bytes are a PNG whose pixel data is really pixel data.
 *
 * The chunk walk has to close at `IEND` having consumed the buffer, *and* the concatenated `IDAT`
 * stream has to inflate to exactly the size `IHDR` describes. The walk alone is framing — lengths
 * a caller sets — and framing is what the previous version accepted.
 *
 * Adam7 is not reconstructed: an interlaced image is accepted on a successful inflate alone,
 * because the seven passes do not sum to the plain formula and a wrong rejection here puts a real
 * screenshot back through the shredder. Inflating at all is the part a wrapped credential fails.
 */
function isWholePng(b: Buffer): boolean {
  if (!b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return false;
  }
  let at = 8;
  let ihdr: Buffer | undefined;
  const idat: Buffer[] = [];
  for (;;) {
    if (at + 12 > b.length) return false;
    const len = b.readUInt32BE(at);
    const type = b.subarray(at + 4, at + 8).toString('latin1');
    const next = at + 12 + len; // length + type + data + CRC
    if (len < 0 || next > b.length) return false;
    const data = b.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') ihdr = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') {
      if (next !== b.length || ihdr === undefined || ihdr.length < 13 || idat.length === 0) {
        return false;
      }
      break;
    }
    at = next;
  }

  const width = ihdr!.readUInt32BE(0);
  const height = ihdr!.readUInt32BE(4);
  const depth = ihdr![8]!;
  const colour = ihdr![9]!;
  const interlace = ihdr![12]!;
  if (width === 0 || height === 0) return false;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    // Not a zlib stream, which is what a credential wrapped in an IDAT chunk is.
    return false;
  }
  if (interlace !== 0) return raw.length > 0;

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  if (channels === undefined) return false;
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  return raw.length === height * (rowBytes + 1);
}

/**
 * Whether these bytes are a JPEG whose marker chain closes.
 *
 * Segment by segment to `EOI`, requiring a frame header along the way, and requiring the scan's
 * entropy-coded data to be delimited the way a decoder would read it. `FF D8 FF <credential> FF D9`
 * — the previous version's whole test — has no frame and no coherent chain.
 */
function isWholeJpeg(b: Buffer): boolean {
  if (b[0] !== 0xff || b[1] !== 0xd8) return false;
  let at = 2;
  let sawFrame = false;
  while (at + 1 < b.length) {
    if (b[at] !== 0xff) return false;
    let marker = b[at + 1]!;
    // Fill bytes are legal between segments.
    while (marker === 0xff && at + 2 < b.length) {
      at += 1;
      marker = b[at + 1]!;
    }
    at += 2;
    if (marker === 0xd9) return at === b.length; // EOI, and nothing after it
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone
    if (at + 2 > b.length) return false;
    const len = b.readUInt16BE(at);
    if (len < 2 || at + len > b.length) return false;
    // SOF0..SOF15, excluding the huffman/arithmetic/restart markers in that range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      sawFrame = true;
    }
    at += len;
    if (marker === 0xda) {
      if (!sawFrame) return false;
      // Entropy-coded data: any `FF` that is not a stuffed `FF 00` or a restart ends it.
      while (at + 1 < b.length) {
        if (b[at] === 0xff && b[at + 1] !== 0x00 && !(b[at + 1]! >= 0xd0 && b[at + 1]! <= 0xd7)) {
          break;
        }
        at += 1;
      }
    }
  }
  return false;
}

/** Whether these bytes are one complete raster image and nothing else. */
function isWholeRasterImage(b: Buffer): boolean {
  if (b.length < 16) return false;
  return isWholePng(b) || isWholeJpeg(b);
}

/**
 * The spans of `value` that are whole raster images.
 *
 * The signature is checked before anything is decoded, so a long run that is not an image costs
 * two bytes rather than a decode — which matters because this runs over every string a trace
 * writes.
 */
function rasterSpans(value: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const m of value.matchAll(BASE64_RUN)) {
    const run = m[0];
    if (run.length < MIN_RASTER_CHARS) continue;
    // `iVBORw` and `/9j/` are what PNG and JPEG signatures look like once base64-encoded.
    if (!run.startsWith('iVBORw') && !run.startsWith('/9j/') && !run.startsWith('\\/9j\\/')) {
      continue;
    }
    // `\/` and `\\` stand for payload characters; they are stripped before decoding and the span
    // still covers them, or the sweep would resume inside the image.
    const payload = run.replace(/\\(.)/g, '$1');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(payload, 'base64');
    } catch {
      continue;
    }
    if (!isWholeRasterImage(bytes)) continue;
    spans.push([m.index, m.index + run.length]);
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

/** Regions the entropy sweep must not touch: what it already replaced, and what is not a secret. */
function spansOf(value: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const m of value.matchAll(PLACEHOLDER)) spans.push([m.index, m.index + m[0].length]);
  for (const m of value.matchAll(PROTOCOL_ID_VALUE)) spans.push([m.index, m.index + m[0].length]);
  for (const m of value.matchAll(PROTOCOL_SIGNATURE_VALUE)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  spans.push(...rasterSpans(value));
  return spans;
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
    if (value.includes(BINARY_BODY_PREFIX)) return value;
    return this.#scanEntropy(value, context, hits);
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
    for (const m of value.matchAll(TOKEN)) {
      const token = m[0];
      const start = m.index;
      // Wholly inside, not merely starting inside. A TOKEN is `[A-Za-z0-9_-]+`, which runs on
      // past an image payload through a `_` or `-` that base64 has no use for — so a token that
      // began in the image and ended in a credential was skipped entire, and the credential with
      // it. Overlap would be wrong the other way: it would exempt text outside the image.
      if (spans.some(([a, b]) => start >= a && start + token.length <= b)) continue;
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
