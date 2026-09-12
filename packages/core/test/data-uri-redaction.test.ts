import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/redaction.js';

/**
 * A raster image is not a secret, and shredding one protects nothing.
 *
 * The entropy sweep looks for long random-looking runs, and a base64 image is exactly that by
 * construction. `#scan` already skips a body the proxy base64-encoded itself, for a reason its own
 * comment states — the sweep "shredded a 14 KB Connect/protobuf response into 226 placeholders,
 * destroying it outright while protecting nothing". An image the *agent* encoded is the same
 * problem arriving through a different door, and it was not covered. Measured on one browser-use
 * run against Wikipedia: 47,314 placeholders, 1.96 MB of a 3.39 MB trace rewritten into holes.
 *
 * The exemption is granted on the **content**, and the second half of this file is why. Each of
 * these bought one in an earlier draft, and each is now pinned:
 *
 *   - the media type — `data:image/png;base64,<credential>`
 *   - the signature — `iVBORw0KGgo<credential>`
 *   - the framing — a PNG signature, an IHDR, an IDAT holding a credential, an IEND
 *   - base64 padding — `<image>==<credential>`, because the decoder stops at the first `=`
 *   - a token that begins in the image and ends outside it
 *   - a *valid* container — a 1×1 image with the credential in a `tEXt` chunk
 *   - a valid image with the credential inside `IDAT`, past the end of the zlib stream
 *   - IHDR's interlace byte, which skipped the size check altogether
 *   - a JPEG, whose every segment is bytes a caller picks
 *
 * What it does not claim: a secret written into the pixels themselves is not detectable here, and
 * no content rule could be. The payload has to be a picture; a picture cannot be proved innocent.
 */
describe('a whole PNG is excluded from the entropy sweep', () => {
  /** Incompressible and not an image: what the sweep is for. */
  const NOISE = randomBytes(600).toString('base64').replace(/=+$/, '');

  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    // The CRC is not checked — a caller who can set a length can set a CRC — so it is not faked
    // here either.
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  }

  function ihdrOf(w: number, h: number, depth = 8, colour = 2, interlace = 0): Buffer {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(w, 0);
    b.writeUInt32BE(h, 4);
    b[8] = depth;
    b[9] = colour;
    b[12] = interlace;
    return b;
  }

  /** Independent of the implementation's closed form: count the rows each Adam7 pass really has. */
  function rawLength(w: number, h: number, channels: number, depth: number, interlaced: boolean) {
    const passes = interlaced
      ? [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ]
      : [[0, 0, 1, 1]];
    let total = 0;
    for (const [x0, y0, dx, dy] of passes) {
      let cols = 0;
      for (let x = x0!; x < w; x += dx!) cols += 1;
      let rows = 0;
      for (let y = y0!; y < h; y += dy!) rows += 1;
      if (cols === 0 || rows === 0) continue;
      total += rows * (1 + Math.ceil((cols * channels * depth) / 8));
    }
    return total;
  }

  /** A PNG whose IDAT really inflates to the size its IHDR declares. */
  function png(
    w = 16,
    h = 16,
    opts: { colour?: number; depth?: number; interlace?: boolean; extra?: Buffer[] } = {},
  ): string {
    const colour = opts.colour ?? 2;
    const depth = opts.depth ?? 8;
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour]!;
    const raw = Buffer.alloc(rawLength(w, h, channels, depth, opts.interlace ?? false));
    randomBytes(raw.length).copy(raw);
    return Buffer.concat([
      SIG,
      chunk('IHDR', ihdrOf(w, h, depth, colour, opts.interlace ? 1 : 0)),
      ...(opts.extra ?? []),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
  }

  /**
   * The shortest image at or above `from` rows whose base64 carries exactly `pad` `=` characters.
   *
   * Height, not width: the encoded length is `57 + deflate(h * (1 + 3w))`, and for random pixels
   * deflate adds a constant, so widening steps the total by `48` — a multiple of 3, which leaves
   * the padding exactly where it was. One padding class is unreachable that way.
   */
  function pngWithPadding(pad: 0 | 1 | 2, from = 16): string {
    for (let h = from; h < from + 400; h += 1) {
      const image = png(16, h);
      if ((image.match(/=*$/)?.[0].length ?? 0) === pad) return image;
    }
    throw new Error(`no image with ${pad} padding characters`);
  }

  const swept = (v: string) => v.includes('<secret:high_entropy');

  it('leaves a PNG byte for byte, and records nothing for it', () => {
    const image = png();
    const redactor = new Redactor({});
    const { value } = redactor.redactString(
      JSON.stringify({ image_url: { url: `data:image/png;base64,${image}` } }),
    );
    expect(value).toContain(image);
    expect(swept(value)).toBe(false);
    expect(redactor.rulesFired()).toEqual({});
  });

  /**
   * The only evidence in this file that is not circular.
   *
   * Every other image here is built by the same understanding of the format that the code under
   * test holds, so the two can agree and both be wrong. This one came out of a real encoder.
   */
  it('leaves a PNG a real encoder produced', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = join(here, '..', '..', '..', 'docs', 'chain-card.png');
    if (!existsSync(fixture)) return; // the asset is documentation's, not this test's, to keep
    const image = readFileSync(fixture).toString('base64');
    expect(image.length).toBeGreaterThan(10_000);
    const redactor = new Redactor({});
    const { value } = redactor.redactString(JSON.stringify({ url: image }));
    expect(value).toContain(image);
    expect(redactor.rulesFired()).toEqual({});
  });

  it.each([0, 1, 2] as const)('handles whichever base64 padding the image lands on (%i)', (pad) => {
    const image = pngWithPadding(pad);
    const { value } = new Redactor({}).redactString(
      JSON.stringify({ image_url: { url: `data:image/png;base64,${image}` } }),
    );
    expect(value).toContain(image);
    expect(swept(value)).toBe(false);
  });

  it('handles several images in one body, which is what a multi-step run sends', () => {
    const a = png();
    const b = png(24, 24);
    const redactor = new Redactor({});
    const { value } = redactor.redactString(
      JSON.stringify({
        messages: [{ content: [{ image: a }, { text: 'step' }, { image: b }] }],
      }),
    );
    expect(value).toContain(a);
    expect(value).toContain(b);
    expect(redactor.rulesFired()).toEqual({});
  });

  /**
   * The spelling is not the thing: OpenAI sends a `data:` URI, Anthropic sends
   * `{"type":"base64","media_type":"image/png","data":"…"}` with no prefix at all.
   */
  it('spares the same image in Anthropic’s spelling, which carries no data: prefix', () => {
    const image = png();
    const { value } = new Redactor({}).redactString(
      JSON.stringify({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: image },
      }),
    );
    expect(value).toContain(image);
    expect(swept(value)).toBe(false);
  });

  it('still redacts a named key sitting next to one', () => {
    const image = png();
    const { value } = new Redactor({}).redactString(
      JSON.stringify({
        url: `data:image/png;base64,${image}`,
        key: 'sk-abcdefghijklmnop1234567890',
      }),
    );
    expect(value).toContain(image);
    expect(value).not.toContain('sk-abcdefghijklmnop1234567890');
    expect(value).toContain('<secret:sk_api_key');
  });

  // ---- interlacing, which is pixels arranged differently and nothing else ----

  it.each([
    [8, 8, 2],
    [64, 48, 2],
    [17, 23, 6],
  ])('spares an interlaced %ix%i image, whose size is a seven-pass sum', (w, h, colour) => {
    const image = png(w, h, { colour, interlace: true });
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: image }));
    expect(value, 'the Adam7 sum rejected a real interlaced image').toContain(image);
  });

  /**
   * `if (interlace !== 0) return raw.length > 0` accepted any IDAT that inflated to anything, so
   * one IHDR byte — written by whoever wrote the payload — skipped the content check entirely.
   */
  it('sweeps an interlaced PNG whose IDAT is a credential rather than pixels', () => {
    const forged = Buffer.concat([
      SIG,
      chunk('IHDR', ihdrOf(16, 16, 8, 2, 1)),
      chunk('IDAT', deflateSync(Buffer.from(NOISE))),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
    const { value } = new Redactor({}).redactString(
      JSON.stringify({ url: `data:image/png;base64,${forged}` }),
    );
    expect(value, 'the interlace byte bought an exemption').toContain('<secret:high_entropy');
  });

  it.each([-1, 1])('sweeps an interlaced PNG whose pixel stream is %i byte off', (delta) => {
    const w = 64;
    const h = 48;
    const raw = Buffer.alloc(rawLength(w, h, 3, 8, true) + delta);
    randomBytes(raw.length).copy(raw);
    const forged = Buffer.concat([
      SIG,
      chunk('IHDR', ihdrOf(w, h, 8, 2, 1)),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: forged }));
    expect(value).toContain('<secret:high_entropy');
  });

  // ---- the ways an exemption can be bought, and is not ----

  it.each([
    'data:image/png;base64,',
    'data:image/jpeg;base64,',
    'data:application/pdf;base64,',
    '',
  ])('sweeps a payload that is not an image, prefixed with "%s"', (prefix) => {
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: `${prefix}${NOISE}` }));
    expect(value, `"${prefix}" bought an exemption`).toContain('<secret:high_entropy');
    expect(value).not.toContain(NOISE);
  });

  it('sweeps a PNG signature followed by a credential', () => {
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: `iVBORw0KGgo${NOISE}` }));
    expect(value).toContain('<secret:high_entropy');
    expect(value).not.toContain(NOISE);
  });

  /**
   * An indexed image is its palette, so the palette is exempt on the same footing as the pixel
   * stream — but only where it is the pixels. On a truecolour image PLTE is a *suggested* palette,
   * which is up to 768 bytes a caller picks and nothing reads.
   */
  it('spares an indexed PNG, palette and all', () => {
    const palette = Buffer.alloc(768);
    randomBytes(768).copy(palette);
    const raw = Buffer.alloc(16 * (1 + 16));
    randomBytes(raw.length).copy(raw);
    const image = Buffer.concat([
      SIG,
      chunk('IHDR', ihdrOf(16, 16, 8, 3)),
      chunk('PLTE', palette),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: image }));
    expect(value).toContain(image);
  });

  it.each([
    [
      'a suggested palette on a truecolour image',
      () =>
        Buffer.concat([
          SIG,
          chunk('IHDR', ihdrOf(16, 16, 8, 2)),
          chunk('PLTE', Buffer.from(NOISE.slice(0, 768))),
          chunk('IDAT', deflateSync(randomBytes(16 * (1 + 48)))),
          chunk('IEND', Buffer.alloc(0)),
        ]).toString('base64'),
    ],
    [
      'an indexed image with no palette at all',
      () =>
        Buffer.concat([
          SIG,
          chunk('IHDR', ihdrOf(16, 16, 8, 3)),
          chunk('IDAT', deflateSync(randomBytes(16 * (1 + 16)))),
          chunk('IEND', Buffer.alloc(0)),
        ]).toString('base64'),
    ],
    [
      'truecolour at one bit per sample, which no decoder reads',
      () =>
        Buffer.concat([
          SIG,
          chunk('IHDR', ihdrOf(16, 16, 1, 2)),
          chunk('IDAT', deflateSync(randomBytes(16 * (1 + 6)))),
          chunk('IEND', Buffer.alloc(0)),
        ]).toString('base64'),
    ],
  ])('refuses the exemption to %s', (_what, build) => {
    const image = build();
    // The pixels are random, so the run is swept to pieces the moment it is not exempt.
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: image }));
    expect(value).not.toContain(image);
    expect(value).toContain('<secret:high_entropy');
  });

  /**
   * The prefilter only sees `iVBORw`, which is the first four and a half signature bytes, so the
   * rest of the signature is checked where it can still reject something.
   */
  it('sweeps a payload whose signature is right up to the prefilter and wrong after it', () => {
    const forged = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]), // last byte should be 0x0a
      chunk('IHDR', ihdrOf(16, 16)),
      chunk('IDAT', deflateSync(randomBytes(16 * (1 + 48)))),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
    expect(forged.startsWith('iVBORw'), 'this forgery never reached the signature check').toBe(
      true,
    );
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: forged }));
    expect(value).toContain('<secret:high_entropy');
  });

  /**
   * Exactly one IHDR, first. Two of them would mean the walk read the image parameters from one
   * chunk and the pixels from an image the other describes, and the second one is the caller’s to
   * choose after the fact.
   */
  it.each([
    [
      'a second IHDR, where the first one agrees with the pixels',
      () => {
        const raw = randomBytes(16 * (1 + 48));
        return Buffer.concat([
          SIG,
          chunk('IHDR', ihdrOf(16, 16)),
          chunk('IDAT', deflateSync(raw)),
          chunk('IHDR', ihdrOf(33, 8)),
          chunk('IEND', Buffer.alloc(0)),
        ]).toString('base64');
      },
    ],
    [
      'an IHDR that is not the first chunk',
      () =>
        Buffer.concat([
          SIG,
          chunk('pHYs', Buffer.alloc(9)),
          chunk('IHDR', ihdrOf(16, 16)),
          chunk('IDAT', deflateSync(randomBytes(16 * (1 + 48)))),
          chunk('IEND', Buffer.alloc(0)),
        ]).toString('base64'),
    ],
  ])('sweeps a PNG with %s', (_what, build) => {
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: build() }));
    expect(value).toContain('<secret:high_entropy');
  });

  /**
   * Framing is not content: a length field is written by the same caller who writes the payload.
   */
  it('sweeps a PNG whose IDAT holds a credential rather than pixels', () => {
    const forged = Buffer.concat([
      SIG,
      // A believable IHDR, so it is the IDAT stream that has to fail and not the dimensions.
      chunk('IHDR', ihdrOf(16, 16)),
      chunk('IDAT', Buffer.from(NOISE)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
    const { value } = new Redactor({}).redactString(
      JSON.stringify({ url: `data:image/png;base64,${forged}` }),
    );
    expect(value, 'framing bought an exemption').toContain('<secret:high_entropy');
  });

  /**
   * `inflateSync` stops at the end of the zlib stream and ignores whatever follows, so a real
   * screenshot could carry a credential inside IDAT, past the pixels, and still size-check clean.
   */
  it('sweeps a real image carrying a credential inside IDAT past the end of the zlib stream', () => {
    const raw = Buffer.alloc(rawLength(16, 16, 3, 8, false));
    randomBytes(raw.length).copy(raw);
    const forged = Buffer.concat([
      SIG,
      chunk('IHDR', ihdrOf(16, 16)),
      chunk('IDAT', Buffer.concat([deflateSync(raw), Buffer.from(NOISE)])),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
    const redactor = new Redactor({});
    const { value } = redactor.redactString(JSON.stringify({ url: forged }));
    expect(value, 'bytes past the zlib stream rode out inside a valid image').toContain(
      '<secret:high_entropy',
    );
    expect(Buffer.from(value, 'base64').toString('latin1')).not.toContain(NOISE);
  });

  /**
   * A container can be entirely valid and still carry chosen bytes. The exemption covers the whole
   * run, so a `tEXt` chunk beside one real pixel was exempt too.
   */
  it.each([
    ['tEXt', 'tEXt'],
    ['iTXt', 'iTXt'],
    ['zTXt', 'zTXt'],
    ['iCCP', 'iCCP'],
    ['cHRM, fixed-length but long enough to matter', 'cHRM'],
    ['an unknown chunk type', 'qqQq'],
  ])('sweeps a valid image carrying a credential in %s', (_what, type) => {
    const payload = type === 'cHRM' ? Buffer.from(NOISE.slice(0, 32)) : Buffer.from(NOISE);
    const image = png(16, 16, { extra: [chunk(type, payload)] });
    const { value } = new Redactor({}).redactString(
      JSON.stringify({ url: `data:image/png;base64,${image}` }),
    );
    expect(value, `${type} bought an exemption for its contents`).toContain('<secret:high_entropy');
  });

  /**
   * The other direction: a chunk whose length the spec fixes cannot hold a run the sweep would
   * have redacted, so requiring it to be absent would cost real screenshots their exemption for
   * nothing.
   */
  it.each([
    ['pHYs', 9],
    ['gAMA', 4],
    ['sRGB', 1],
    ['tIME', 7],
  ])('keeps the exemption for a real image carrying %s', (type, size) => {
    const image = png(16, 16, { extra: [chunk(type, Buffer.alloc(size))] });
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: image }));
    expect(value, `${type} at its spec length cost a real image its exemption`).toContain(image);
  });

  it('sweeps a fixed-length chunk that is not its fixed length', () => {
    const image = png(16, 16, { extra: [chunk('pHYs', Buffer.from(NOISE))] });
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: image }));
    expect(value).toContain('<secret:high_entropy');
  });

  /**
   * JPEG had an exemption and no longer does. Every one of its segments is bytes a caller picks —
   * `COM` and `APPn` outright, `DQT`/`DHT` within a shape — and its entropy-coded scan cannot be
   * told from a credential without a full Huffman decode. "A marker chain that closes" is framing.
   */
  it.each([
    [
      'SOI, a comment holding a credential, EOI — no frame, no scan',
      Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xfe]),
        (() => {
          const len = Buffer.alloc(2);
          len.writeUInt16BE(NOISE.length + 2);
          return len;
        })(),
        Buffer.from(NOISE),
        Buffer.from([0xff, 0xd9]),
      ]),
    ],
    [
      'a structurally complete JPEG',
      Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40, 0x03]),
        Buffer.from([0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
        Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
        Buffer.from(NOISE),
        Buffer.from([0xff, 0xd9]),
      ]),
    ],
  ])('sweeps %s', (_what, bytes) => {
    const b64 = bytes.toString('base64');
    const { value } = new Redactor({}).redactString(
      JSON.stringify({ url: `data:image/jpeg;base64,${b64}` }),
    );
    expect(value, 'a JPEG bought an exemption').toContain('<secret:high_entropy');
  });

  /**
   * `Buffer.from(x, 'base64')` stops at the first `=` and ignores the rest, so a run of
   * `<image>=<credential>` decoded to a valid image and the span covered the credential with it.
   */
  it('sweeps a credential hidden behind an image’s padding', () => {
    const image = pngWithPadding(1);
    const { value } = new Redactor({}).redactString(
      JSON.stringify({ url: `data:image/png;base64,${image}${NOISE}` }),
    );
    expect(value, 'padding carried a credential through').not.toContain(NOISE);
    expect(value).toContain('<secret:high_entropy');
  });

  /**
   * A TOKEN is `[A-Za-z0-9_-]+`, which runs on past a payload through a `_` or `-` that base64 has
   * no use for. Skipping a token because it *starts* inside an image skipped the credential at its
   * far end too.
   */
  it.each([
    ['an underscore', '_'],
    ['a hyphen', '-'],
  ])('sweeps a token that begins in the image and continues past it, after %s', (_what, gap) => {
    const image = pngWithPadding(0); // unpadded, so a token match can start inside the payload
    const redactor = new Redactor({});
    const { value } = redactor.redactString(
      JSON.stringify({ url: `data:image/png;base64,${image}${gap}${NOISE}` }),
    );
    expect(value, 'the credential rode out on a token that began in the image').not.toContain(
      NOISE,
    );
    // The count is not one: replacing the straddling token breaks the image, and what is left of
    // it is swept in pieces. That is the fail-closed direction — the alternative is a credential
    // riding out on a token that merely began inside a picture.
    expect(redactor.rulesFired().high_entropy).toBeGreaterThan(0);
  });

  it('covers a payload carrying escaped characters, as a JSON-encoded body does', () => {
    // A body reaches the trace inside JSON, so a `/` in the payload can arrive as `\/`.
    const image = png();
    const { value } = new Redactor({}).redactString(
      `data:image/png;base64,${image.replace('/', '\\/')}`,
    );
    expect(swept(value)).toBe(false);
  });
});
