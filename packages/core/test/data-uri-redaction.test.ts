import { randomBytes } from 'node:crypto';
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
 *
 * What it does not claim: a secret hidden inside real pixel data is not detectable here, and no
 * content rule could be. The payload has to be a picture; a picture cannot be proved innocent.
 */
describe('a whole raster image is excluded from the entropy sweep', () => {
  /** Incompressible and not an image: what the sweep is for. */
  const NOISE = randomBytes(600).toString('base64').replace(/=+$/, '');

  /** A PNG whose IDAT really inflates to the size its IHDR declares. */
  function png(width = 16, height = 16, extra = 0): string {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      // The CRC is not checked — a caller who can set a length can set a CRC — so it is not faked
      // here either.
      return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
    };
    const raw = Buffer.alloc(height * (1 + width * 3));
    randomBytes(raw.length).copy(raw);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolour
    const parts = [
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
    ];
    // Shifts the base64 padding, which is its own case below.
    if (extra > 0) parts.push(chunk('tEXt', Buffer.alloc(extra, 0x41)));
    parts.push(chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts).toString('base64');
  }

  /** A JPEG whose marker chain closes on a frame header. */
  function jpeg(): string {
    const sof = Buffer.concat([
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
      Buffer.from([0x00, 0x40, 0x00, 0x40, 0x03]),
      Buffer.from([0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
    ]);
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
    const scan = randomBytes(400).map((b) => (b === 0xff ? 0xfe : b));
    return Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      sof,
      sos,
      scan,
      Buffer.from([0xff, 0xd9]),
    ]).toString('base64');
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

  it('leaves a JPEG alone too', () => {
    const image = jpeg();
    const { value } = new Redactor({}).redactString(
      JSON.stringify({ url: `data:image/jpeg;base64,${image}` }),
    );
    expect(value).toContain(image);
    expect(swept(value)).toBe(false);
  });

  it.each([0, 1, 2])('handles whichever base64 padding the image lands on (tEXt+%i)', (extra) => {
    const image = png(16, 16, extra);
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

  it.each([
    ['a PNG signature and nothing else', 'iVBORw0KGgo'],
    ['a JPEG signature and nothing else', '/9j/'],
  ])('sweeps %s followed by a credential', (_what, head) => {
    const { value } = new Redactor({}).redactString(JSON.stringify({ url: `${head}${NOISE}` }));
    expect(value).toContain('<secret:high_entropy');
    expect(value).not.toContain(NOISE);
  });

  /**
   * Framing is not content. Every arm of an earlier check verified only the bytes a caller writes
   * *around* the payload, so a credential in a wrapper came back exempt — five bytes of decoration
   * for JPEG, seven for GIF, and for PNG a length field the same caller sets.
   */
  it.each([
    [
      'a PNG whose IDAT holds a credential rather than pixels',
      (() => {
        const cred = Buffer.from(NOISE);
        const chunk = (type: string, data: Buffer) => {
          const len = Buffer.alloc(4);
          len.writeUInt32BE(data.length);
          return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
        };
        // A believable IHDR, so it is the IDAT stream that has to fail and not the dimensions.
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(16, 0);
        ihdr.writeUInt32BE(16, 4);
        ihdr[8] = 8;
        ihdr[9] = 2;
        return Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          chunk('IHDR', ihdr),
          chunk('IDAT', cred),
          chunk('IEND', Buffer.alloc(0)),
        ]).toString('base64');
      })(),
    ],
    [
      'a JPEG that is SOI, a credential and EOI',
      Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.from(NOISE),
        Buffer.from([0xff, 0xd9]),
      ]).toString('base64'),
    ],
    [
      'a GIF header wrapped round a credential',
      Buffer.concat([
        Buffer.from('GIF89a', 'latin1'),
        Buffer.from(NOISE),
        Buffer.from([0x3b]),
      ]).toString('base64'),
    ],
  ])('sweeps %s', (_what, forged) => {
    const { value } = new Redactor({}).redactString(
      JSON.stringify({ url: `data:image/png;base64,${forged}` }),
    );
    expect(value, 'framing bought an exemption').toContain('<secret:high_entropy');
  });

  /**
   * `Buffer.from(x, 'base64')` stops at the first `=` and ignores the rest, so a run of
   * `<image>=<credential>` decoded to a valid image and the span covered the credential with it.
   */
  it('sweeps a credential hidden behind an image’s padding', () => {
    const image = png(16, 16, 1); // padded
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
    // Unpadded, so the token match can start inside the payload.
    let image = png();
    for (let i = 0; image.includes('=') && i < 200; i += 1) image = png(16 + i, 16);
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
