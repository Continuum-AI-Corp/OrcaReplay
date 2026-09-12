import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/redaction.js';

/**
 * A raster image is not a secret, and shredding one protects nothing.
 *
 * The entropy sweep looks for long random-looking runs, and a base64 image is exactly that by
 * construction. `#scan` already skips a body the proxy base64-encoded itself, for a reason its own
 * comment states — the sweep "shredded a 14 KB Connect/protobuf response into 226 placeholders,
 * destroying it outright while protecting nothing". An image the *agent* encoded is the same
 * problem arriving through a different door, and it was not covered.
 *
 * Measured on one browser-use run against Wikipedia — four model calls, six screenshots:
 *
 *     47,314 `<secret:high_entropy:…>` placeholders
 *     47,314 records in redactions.json, every one of them part of a PNG
 *     1.96 MB of a 3.39 MB trace, rewritten into holes
 *
 * The exemption is granted on the **payload**, never on the syntax around it or the label in front
 * of it — that is what the second half of this file is about, and each of those cases was a hole
 * in an earlier draft of the rule:
 *
 *   - a label is text the agent wrote, so `data:image/png;base64,<credential>` bought an exemption
 *   - a signature is also text, so `iVBORw0KGgo<credential>` bought one from a head-only check
 *   - keying on `data:` URI syntax missed Anthropic's spelling entirely, and let the span run past
 *     the payload across a JSON-escaped newline
 *
 * What it does not claim: a secret hidden *inside* otherwise valid pixel data is not detectable
 * here, and no content rule could be. The line is that a payload which is not a picture does not
 * get a picture's exemption.
 */
describe('a whole raster image is excluded from the entropy sweep', () => {
  // A real 1×1 PNG, so the test is about the shape of the data rather than a made-up string.
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const dataUri = `data:image/png;base64,${PNG}`;

  /** Incompressible and not an image: what the sweep is for. */
  const NOISE = Buffer.from(
    'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP'.repeat(6),
  ).toString('base64');

  /** A complete image of each format, built so the structure actually closes. */
  const whole = {
    png: PNG,
    jpeg: Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(64, 0x7f),
      Buffer.from([0xff, 0xd9]),
    ]).toString('base64'),
    gif: Buffer.concat([
      Buffer.from('GIF89a', 'latin1'),
      Buffer.alloc(64, 0x11),
      Buffer.from([0x3b]),
    ]).toString('base64'),
    bmp: (() => {
      const b = Buffer.alloc(70, 0x22);
      b.write('BM', 0, 'latin1');
      b.writeUInt32LE(b.length, 2);
      return b.toString('base64');
    })(),
    webp: (() => {
      const b = Buffer.alloc(72, 0x33);
      b.write('RIFF', 0, 'latin1');
      b.writeUInt32LE(b.length - 8, 4);
      b.write('WEBP', 8, 'latin1');
      return b.toString('base64');
    })(),
  };

  it('leaves the image byte for byte', () => {
    const redactor = new Redactor({});
    const { value } = redactor.redactString(JSON.stringify({ image_url: { url: dataUri } }));
    expect(value).toContain(PNG);
    expect(value).not.toContain('<secret:high_entropy');
  });

  it('records nothing for the image', () => {
    const redactor = new Redactor({});
    redactor.redactString(JSON.stringify({ image_url: { url: dataUri } }));
    expect(redactor.rulesFired()).toEqual({});
  });

  it('handles several images in one body, which is what a multi-step run sends', () => {
    const redactor = new Redactor({});
    const body = JSON.stringify({
      messages: [
        { content: [{ text: 'step 1' }, { image_url: { url: dataUri } }] },
        { content: [{ text: 'step 2' }, { image_url: { url: dataUri } }] },
      ],
    });
    const { value } = redactor.redactString(body);
    expect(value.split(PNG).length - 1).toBe(2);
    expect(redactor.rulesFired()).toEqual({});
  });

  it.each(Object.entries(whole))('spares a whole %s', (_format, payload) => {
    const redactor = new Redactor({});
    const { value } = redactor.redactString(
      JSON.stringify({ image_url: { url: `data:image/x;base64,${payload}` } }),
    );
    expect(value).not.toContain('<secret:high_entropy');
    expect(value).toContain(payload);
  });

  /**
   * The spelling is not the thing.
   *
   * OpenAI puts an image on the wire as a `data:` URI; Anthropic sends
   * `{"type":"base64","media_type":"image/png","data":"…"}` with no prefix at all. A rule keyed on
   * `data:image/…;base64,` shredded every screenshot in a `/v1/messages` recording.
   */
  it('spares the same image in Anthropic’s spelling, which carries no data: prefix', () => {
    const redactor = new Redactor({});
    const { value } = redactor.redactString(
      JSON.stringify({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: PNG },
      }),
    );
    expect(value).toContain(PNG);
    expect(value).not.toContain('<secret:high_entropy');
  });

  it('still redacts a real key sitting next to one', () => {
    // The whole risk of an exclusion is that it becomes a hiding place. Named rules run over the
    // entire value, before and after this change.
    const redactor = new Redactor({});
    const { value } = redactor.redactString(
      JSON.stringify({ url: dataUri, key: 'sk-abcdefghijklmnop1234567890' }),
    );
    expect(value).toContain(PNG);
    expect(value).not.toContain('sk-abcdefghijklmnop1234567890');
    expect(value).toContain('<secret:sk_api_key');
  });

  it('still redacts a high-entropy token outside the image', () => {
    const secret = 'Zx9Qw3Lm7Rt2Yv8Bn4Kd6Hs1Jf5Gp0Ac';
    const redactor = new Redactor({});
    const { value } = redactor.redactString(JSON.stringify({ url: dataUri, token: secret }));
    expect(value).toContain(PNG);
    expect(value).not.toContain(secret);
  });

  /**
   * A base64 payload that is not an image is swept, however it is dressed.
   *
   * A label is text the agent wrote in front of the bytes, so an exemption granted on it is one
   * any caller can claim: the same encoded credential was spared behind `image/png` and swept
   * behind `application/pdf`, decided by four bytes of type string.
   */
  it.each([
    'data:image/png;base64,',
    'data:image/jpeg;base64,',
    'data:image/webp;base64,',
    'data:image/avif;base64,',
    'data:application/pdf;base64,',
    '',
  ])('sweeps a payload that is not an image, prefixed with "%s"', (prefix) => {
    const redactor = new Redactor({});
    const { value } = redactor.redactString(JSON.stringify({ url: `${prefix}${NOISE}` }));
    expect(value, `"${prefix}" bought an exemption`).toContain('<secret:high_entropy');
    expect(value).not.toContain(NOISE);
  });

  /**
   * A signature is text too, so it cannot be the whole check.
   *
   * `iVBORw0KGgo` is eleven characters that decode to PNG's magic bytes; a head-only check spared
   * everything that followed them. The structure has to *close* — PNG's chunk walk ending at
   * `IEND`, JPEG's `FF D9`, a declared size for BMP and WebP — so an appended secret breaks it.
   */
  it.each([
    ['a PNG signature and nothing else', 'iVBORw0KGgo'],
    ['an AVIF ftyp box header', 'AAAAIGZ0eXA'],
    ['a BMP two-byte signature', 'Qk'],
  ])('sweeps %s followed by a credential', (_what, head) => {
    const redactor = new Redactor({});
    const { value } = redactor.redactString(
      JSON.stringify({ url: `data:image/png;base64,${head}${NOISE}` }),
    );
    expect(value).toContain('<secret:high_entropy');
    expect(value).not.toContain(NOISE);
  });

  it('sweeps a real image with a credential appended to it', () => {
    const redactor = new Redactor({});
    const { value } = redactor.redactString(
      JSON.stringify({ url: `data:image/png;base64,${PNG.replace(/=+$/, '')}${NOISE}` }),
    );
    expect(value, 'appending to a real image bought an exemption').toContain(
      '<secret:high_entropy',
    );
    expect(value).not.toContain(NOISE);
  });

  /**
   * The exempt span must stop at the payload.
   *
   * An earlier draft admitted `\` into the payload class so that a JSON-escaped `\/` would not cut
   * an image in half — but `\n` is `\` then `n`, both in that class, so the run continued across
   * the line break and swallowed whatever followed. A token on the next line of the same field was
   * then never swept, with `rulesFired()` empty and nothing in `redactions.json`.
   */
  it.each([
    ['an escaped newline', '\\n'],
    ['two of them with padding between', '\\nAAAA\\n'],
    ['a space', ' '],
    ['a colon', ':'],
  ])('sweeps a token that follows the image after %s', (_what, gap) => {
    const secret = 'Zx9Qw3Lm7Rt2Yv8Bn4Kd6Hs1Jf5Gp0Ac';
    const redactor = new Redactor({});
    const { value } = redactor.redactString(`{"text":"${dataUri}${gap}${secret}"}`);
    expect(value, `the span ran past the payload across ${_what}`).not.toContain(secret);
    expect(redactor.rulesFired()).toEqual({ high_entropy: 1 });
  });

  it('covers a payload carrying escaped characters, as a JSON-encoded body does', () => {
    // A body reaches the trace inside JSON, so a `/` in the payload can arrive as `\/`. The span
    // has to cover the escape, or the sweep resumes mid-image.
    const redactor = new Redactor({});
    const escaped = PNG.replace('/', '\\/');
    const { value } = redactor.redactString(`data:image/png;base64,${escaped}`);
    expect(value).not.toContain('<secret:high_entropy');
  });
});
