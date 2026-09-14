import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
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

  /** A well-formed chunk. `crc` writes a wrong one instead, which is its own case below. */
  function chunk(type: string, data: Buffer, crc?: number): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc ?? crc32(body) >>> 0);
    return Buffer.concat([len, body, check]);
  }

  /**
   * High-entropy bytes that are the same on every run.
   *
   * `randomBytes` is right where a test only needs an image to be incompressible, which is what
   * most of this file needs, and it stays there. It is wrong wherever the assertion is that the
   * sweep *fires*: that answer comes from a heuristic reading one particular string, so a fixture
   * redrawn every run is a test that sometimes passes. This one went red on CI roughly one run in
   * fourteen, on a branch that had not touched the redactor.
   */
  function fixedNoise(n: number): Buffer {
    const parts: Buffer[] = [];
    for (let i = 0; i * 32 < n; i += 1) {
      parts.push(createHash('sha256').update(`orca palette fixture ${i}`).digest());
    }
    return Buffer.concat(parts).subarray(0, n);
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
   * An indexed PNG has no exemption, because `PLTE` has no bound worth having.
   *
   * It had one, on the argument that an indexed image's palette *is* its pixels. The argument does
   * not survive: a palette is up to 768 uncompressed bytes of the caller's choosing, sitting
   * verbatim in the trace, and its entries need not be referenced by any pixel — so an entirely
   * valid one-pixel image can carry a credential in entries no decoder will ever draw. `IDAT` is
   * not analogous; it has to inflate to exactly the size the header declares. Admitting 768 free
   * bytes while refusing `cHRM` at 32 was this file contradicting its own admission criterion.
   *
   * Since a valid indexed PNG cannot exist without a palette, colour type 3 is simply not accepted.
   */
  it('sweeps a valid indexed PNG carrying a credential in palette entries nothing references', () => {
    // The whole palette: 256 entries of the caller's own bytes, which is the size of what the
    // exemption would have been handing out, against a one-pixel image that references one of them.
    //
    // It used to be 24 bytes of credential in an otherwise empty palette. That is a real payload
    // and the sweep caught it about thirteen times in fourteen — `TOKEN` is `[A-Za-z0-9_-]+`, so
    // base64 cuts a credential apart at every `+` and `/`, and the zero entries around it dilute
    // what survives below four bits a character. Measured at a 7% miss over 2000 draws, which is
    // what the red CI run on a branch that never touched the redactor turned out to be.
    //
    // So the fixture is the threat the paragraph above describes, at its size, rather than a
    // minimal one sitting on the heuristic's threshold. What is claimed here is that colour type 3
    // buys no exemption and its palette is swept like any other payload — not that every credential
    // small enough to hide in a mostly-empty palette is found, which no entropy heuristic promises.
    const palette = fixedNoise(768);
    const image = Buffer.concat([
      SIG,
      chunk('IHDR', ihdrOf(1, 1, 8, 3)),
      chunk('PLTE', palette),
      chunk('IDAT', deflateSync(Buffer.alloc(2))), // one pixel, referencing entry 0
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
    const { value } = new Redactor({}).redactString(
      JSON.stringify({
        messages: [{ content: [{ image_url: { url: `data:image/png;base64,${image}` } }] }],
      }),
    );
    expect(value, 'a palette bought an exemption for its contents').not.toContain(image);
    expect(value).toContain('<secret:high_entropy');
  });

  /**
   * The CRCs are checked, which is a counting argument rather than an integrity one: a caller who
   * can set a length can set a CRC, so this proves nothing about intent. What it does is stop the
   * four CRC bytes of every admitted chunk being four more of the caller's own — the difference
   * between `pHYs` contributing nine chosen bytes and thirteen.
   */
  it('refuses a chunk whose CRC is not the one its bytes imply', () => {
    const raw = Buffer.alloc(16 * (1 + 48));
    randomBytes(raw.length).copy(raw);
    const image = Buffer.concat([
      SIG,
      chunk('IHDR', ihdrOf(16, 16)),
      chunk('IDAT', deflateSync(raw), 0xdeadbeef),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: image }));
    expect(value).not.toContain(image);
    expect(value).toContain('<secret:high_entropy');
  });

  it('refuses IHDR with a wrong CRC, which the walk never reaches', () => {
    const raw = Buffer.alloc(16 * (1 + 48));
    randomBytes(raw.length).copy(raw);
    const image = Buffer.concat([
      SIG,
      chunk('IHDR', ihdrOf(16, 16), 0),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: image }));
    expect(value).not.toContain(image);
  });

  it.each([
    [
      'a palette on a truecolour image',
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
      'an indexed image, palette or no palette',
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

  // ---- what it costs to look, which is the other way this can go wrong ----

  /**
   * The size is known from IHDR before the inflate, so the inflate is bounded by it.
   *
   * Deciding afterwards meant a 400 KB `IDAT` declaring 1×1 could expand to whatever it liked —
   * measured on the code before this guard, a 531 KB base64 payload took RSS up by 821 MB, and a
   * heap cap does not help because zlib allocates outside the JS heap. The redactor is the one
   * place in the write path that runs over bytes an agent's tools, an MCP server, or somebody
   * else's trace file chose.
   */
  it('refuses a pixel stream that inflates past what IHDR declares, without inflating it', () => {
    const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 });
    expect(bomb.length).toBeLessThan(128 * 1024); // a small payload claiming a large one
    const forged = Buffer.concat([
      SIG,
      chunk('IHDR', ihdrOf(1, 1)), // four bytes of pixels, by its own account
      chunk('IDAT', bomb),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');

    const before = process.memoryUsage().rss;
    const started = Date.now();
    new Redactor({}).redactString(JSON.stringify({ url: forged }));
    const grewMb = (process.memoryUsage().rss - before) / 1024 / 1024;

    // The assertion is the cost, not the verdict. A deflate stream of zeros base64-encodes to a
    // long run of 'A', which the sweep would leave alone on its own account — so "it came back
    // redacted" would pass here whether the exemption was refused or not. What the guard changes
    // is whether 64 MB gets allocated to find that out. Generous bounds: the claim is orders of
    // magnitude, not a stopwatch.
    expect(grewMb, `inflating the bomb cost ${grewMb.toFixed(0)} MB`).toBeLessThan(32);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  /**
   * The other half of the bound, and the only shape that distinguishes it.
   *
   * `maxOutputLength: expected` alone caps the inflate at whatever IHDR declares — and IHDR's
   * dimensions are the caller's, up to 2^32 each. A bomb whose declared size is *also* enormous
   * therefore gets exactly as much room as it asked for. Every cheaper forgery is already refused
   * on the size mismatch instead, which is why this one has to carry a stream that really does
   * inflate to the size in its header.
   */
  it('refuses a bomb whose header declares the size it inflates to', () => {
    const w = 1000;
    const h = 100_000; // 100000 * (1 + 3000) = 286 MiB of "pixels", over the cap
    let bomb: Buffer | undefined = deflateSync(Buffer.alloc(h * (1 + 3 * w)), { level: 9 });
    const forged = Buffer.concat([
      SIG,
      chunk('IHDR', ihdrOf(w, h)),
      chunk('IDAT', bomb),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
    bomb = undefined;

    const before = process.memoryUsage().rss;
    const started = Date.now();
    new Redactor({}).redactString(JSON.stringify({ url: forged }));
    const grewMb = (process.memoryUsage().rss - before) / 1024 / 1024;

    // Cost, not verdict, for the same reason as the test above: a deflate stream of zeros
    // base64-encodes to a long run of 'A' that the sweep would leave alone anyway.
    expect(grewMb, `the declared size bought ${grewMb.toFixed(0)} MB`).toBeLessThan(64);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it('refuses an IHDR that declares more pixels than the redactor will ever hold', () => {
    // Incompressible, so the run is swept to pieces the moment the exemption is refused — which
    // is what makes the verdict observable here and not in the test above.
    const raw = Buffer.alloc(4096);
    randomBytes(raw.length).copy(raw);
    const forged = Buffer.concat([
      SIG,
      chunk('IHDR', ihdrOf(40_000, 40_000)), // 40000 * (1 + 120000) = 4.8 GB
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');
    const redactor = new Redactor({});
    const { value } = redactor.redactString(JSON.stringify({ url: forged }));
    expect(value).not.toContain(forged);
    expect(redactor.rulesFired().high_entropy).toBeGreaterThan(0);
  });

  /**
   * The prefilter used to be `/(?:[A-Za-z0-9+\/]|\\[\/\\])+={0,2}/g`, and a backtracking `+` over a
   * multi-megabyte run overflows V8's regexp stack — `RangeError` out of `RegExpStringIterator`,
   * through `redactString`, with nothing to catch it: the recording aborts and the trace is left
   * unsealed, which `verifyIntegrity` then reports as tampered rather than unfinished.
   *
   * The sweep's own `TOKEN` never had the problem, because `+` and `/` are not in its class and so
   * real base64 arrives as thousands of short matches. The payload here is real base64 for exactly
   * that reason: a run of `[A-Za-z0-9]` only would be one enormous `TOKEN` and would overflow on
   * both sides of the change, which is a test that passes for the wrong reason.
   */
  it('walks a base64 run far larger than any screenshot without overflowing', () => {
    const run =
      'iVBORw' +
      randomBytes(12 * 1024 * 1024)
        .toString('base64')
        .replace(/=+$/, '');
    expect(run.length).toBeGreaterThan(16 * 1024 * 1024);
    expect(run).toMatch(/[+/]/); // representative: the sweep's TOKEN cannot span these
    expect(() =>
      new Redactor({}).redactString(JSON.stringify({ url: `data:image/png;base64,${run}` })),
    ).not.toThrow();
  }, 60_000);

  /**
   * The other shape a large payload comes in: not one enormous image, but very many small ones.
   *
   * `spansOf` used to finish with `spans.push(...rasterSpans(value))`, and a spread passes one
   * argument per element — V8 stops at about 125k of them. There is one span per image, and the
   * smallest PNG this file accepts is a 1×1 greyscale at 92 base64 characters, so roughly 12 MB of
   * payload raised `RangeError: Maximum call stack size exceeded` out of `redactString`, which
   * nothing on the write path catches. A tool result, a page, or an MCP frame can carry that.
   *
   * The cost mattered as much as the throw: the sweep tested containment with `spans.some(...)`
   * per token, which is quadratic once a value holds many images — 120k of them took 27 s before
   * this, against 0.14 s for the same body under the redactor that had no exemption at all.
   */
  it('handles a value holding more images than a spread can carry', () => {
    // 1×1 greyscale: the smallest thing the exemption accepts, so the most spans per byte.
    const ihdr = ihdrOf(1, 1, 8, 0);
    const tiny = Buffer.concat([
      SIG,
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.alloc(2))), // 1 * (1 + 1)
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64');

    const many = 150_000; // past V8's argument limit, which is around 125k
    const body = JSON.stringify({ images: Array.from({ length: many }, () => tiny) });
    const started = Date.now();
    const { value } = new Redactor({}).redactString(body);
    const elapsed = Date.now() - started;

    expect(value).toBe(body); // every one of them intact, none of them recorded
    // Linear, not quadratic. Generous by two orders of magnitude against the 27 s this used to
    // take at a smaller size — the claim is the shape of the curve, not a stopwatch.
    expect(elapsed, `${many} images took ${(elapsed / 1000).toFixed(1)} s`).toBeLessThan(20_000);
  }, 120_000);

  it('covers a payload carrying escaped characters, as a JSON-encoded body does', () => {
    // A body reaches the trace inside JSON, so a `/` in the payload can arrive as `\/`.
    const image = png();
    const { value } = new Redactor({}).redactString(
      `data:image/png;base64,${image.replace('/', '\\/')}`,
    );
    expect(swept(value)).toBe(false);
  });
});
