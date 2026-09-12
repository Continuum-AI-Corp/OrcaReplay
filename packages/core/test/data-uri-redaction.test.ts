import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/redaction.js';

/**
 * A base64 image is not a secret, and shredding one protects nothing.
 *
 * The entropy sweep looks for long random-looking runs, and a base64 payload is exactly that by
 * construction. `#scan` already skips a body the proxy base64-encoded itself, for a reason its own
 * comment states — the sweep "shredded a 14 KB Connect/protobuf response into 226 placeholders,
 * destroying it outright while protecting nothing". A `data:` URI is the same problem arriving
 * through a different door, and it was not covered.
 *
 * Measured on one browser-use run against Wikipedia — four model calls, six screenshots:
 *
 *     47,314 `<secret:high_entropy:…>` placeholders
 *     47,314 records in redactions.json, every one of them part of a PNG
 *     1.96 MB of a 3.39 MB trace, rewritten into holes
 *
 * Three costs, none of them offset by a benefit:
 *
 *   - the recorded bytes stop being the bytes that were sent, so a request carrying an image can
 *     never match on replay — by construction, not by bad luck
 *   - `redactions.json` is the one file that answers "what was removed from this trace", and it
 *     becomes tens of thousands of entries that were never secrets
 *   - a credential visible in a screenshot is pixels. Entropy could not see it before and cannot
 *     see it now; nothing was being protected
 *
 * The exclusion is from the entropy sweep only. Named rules still run over the whole value.
 */
describe('a data: URI is excluded from the entropy sweep', () => {
  // A real 1×1 PNG, so the test is about the shape of the data rather than a made-up string.
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const dataUri = `data:image/png;base64,${PNG}`;

  // Incompressible, so the entropy sweep would take it if it were allowed to look.
  const NOISE = Buffer.from(
    'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP'.repeat(6),
  ).toString('base64');

  it('leaves the image byte for byte', () => {
    const redactor = new Redactor({});
    const { value } = redactor.redactString(JSON.stringify({ image_url: { url: dataUri } }));
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

  it('still redacts a key inside the data URI itself', () => {
    // Not a realistic payload, but it pins that the exclusion is from the *entropy* sweep and not
    // from redaction as a whole.
    const redactor = new Redactor({});
    const { value } = redactor.redactString(
      `data:image/png;base64,AAAAsk-abcdefghijklmnop1234567890AAAA`,
    );
    expect(value).not.toContain('sk-abcdefghijklmnop1234567890');
  });

  it('still redacts a high-entropy token outside the image', () => {
    const secret = 'Zx9Qw3Lm7Rt2Yv8Bn4Kd6Hs1Jf5Gp0Ac';
    const redactor = new Redactor({});
    const { value } = redactor.redactString(JSON.stringify({ url: dataUri, token: secret }));
    expect(value).toContain(PNG);
    expect(value).not.toContain(secret);
  });

  it('records nothing for the image', () => {
    // The count is the point: `redactions.json` is an audit file, and 47,314 non-secrets in it is
    // worse than none, because a real removal is then impossible to find.
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

  /**
   * The exemption is about pixels, so it has to stop at pixels.
   *
   * Every argument for sparing a data URI is an argument about raster bytes: they cannot hide a
   * credential a reader could recover, and the sweep was never protecting them. None of it carries
   * over to base64 in general — and base64 is exactly the form in which the named rules go blind,
   * so for an encoded payload the sweep is the only thing left. `data:application/pdf;base64,…` is
   * how OpenAI's `input_file` takes a file, and an agent attaching one it just read sends the same
   * shape; sparing that would put its bytes on disk verbatim with nothing in `redactions.json`.
   */
  it.each([
    'application/pdf',
    'text/plain',
    'application/octet-stream',
    'application/json',
    // Text, not pixels: a key inside it is one the named rules would have caught unencoded.
    'image/svg+xml',
  ])('still sweeps a data: URI of type %s', (mediaType) => {
    const redactor = new Redactor({});
    const { value } = redactor.redactString(
      JSON.stringify({ file_data: `data:${mediaType};base64,${PNG}` }),
    );
    expect(value, `${mediaType} was spared the entropy sweep`).toContain('<secret:high_entropy');
    expect(value, `${mediaType} payload was written verbatim`).not.toContain(PNG);
  });

  /**
   * Real bytes for each format, because the exemption is granted on the payload and not on the
   * label — an earlier version of this test dressed the same PNG in four different labels, which
   * is exactly the thing that must not work.
   */
  const raster = (head: number[]) =>
    Buffer.concat([Buffer.from(head), Buffer.from(NOISE, 'base64')]).toString('base64');

  it.each([
    ['image/png', raster([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['image/jpeg', raster([0xff, 0xd8, 0xff, 0xe0])],
    ['image/gif', raster([...Buffer.from('GIF89a', 'latin1')])],
    ['image/bmp', raster([0x42, 0x4d])],
    [
      'image/webp',
      raster([...Buffer.from('RIFF', 'latin1'), 0, 0, 0, 0, ...Buffer.from('WEBP', 'latin1')]),
    ],
  ])('still spares a real %s, which is what the exemption is for', (mediaType, payload) => {
    const redactor = new Redactor({});
    const { value } = redactor.redactString(
      JSON.stringify({ image_url: { url: `data:${mediaType};base64,${payload}` } }),
    );
    expect(value, `${mediaType} was swept`).not.toContain('<secret:high_entropy');
    expect(value).toContain(payload);
  });

  /**
   * The label is not evidence.
   *
   * It is text the agent wrote in front of the bytes, so an exemption granted on it is one any
   * caller can claim. The same encoded credential must not be spared behind `image/png` and swept
   * behind `application/pdf`.
   */
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif'])(
    'sweeps a payload that is not an image however it is labelled %s',
    (mediaType) => {
      const redactor = new Redactor({});
      const { value } = redactor.redactString(
        JSON.stringify({ url: `data:${mediaType};base64,${NOISE}` }),
      );
      expect(value, `${mediaType} label bought an exemption`).toContain('<secret:high_entropy');
      expect(value).not.toContain(NOISE);
    },
  );

  /**
   * The reason the line above matters, stated as a test rather than as a claim in a comment.
   *
   * A named rule finds `sk-…` by its shape. Base64 destroys that shape, so once a credential is
   * encoded the entropy sweep is the only thing that can still see it — which is why the exemption
   * may not cover an encoded payload that is not pixels.
   */
  it('a base64-encoded key is invisible to the named rules, so the sweep has to see it', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const encoded = Buffer.from(key).toString('base64');
    expect(encoded, 'the shape really is gone').not.toContain('sk-');
    expect(Buffer.from(encoded, 'base64').toString(), 'and it decodes back').toBe(key);

    const redactor = new Redactor({});
    const { value } = redactor.redactString(
      JSON.stringify({ file_data: `data:application/pdf;base64,${encoded}${PNG}` }),
    );
    expect(value, 'the encoded key reached the trace').not.toContain(encoded);
  });

  it('covers a payload carrying escaped characters, as a JSON-encoded body does', () => {
    // A body reaches the trace inside JSON, so the span has to include `\` or it ends one byte
    // early and the sweep resumes mid-image.
    const redactor = new Redactor({});
    // The escape sits after the signature, because the signature is what earns the exemption;
    // the span still has to cover the rest or the sweep resumes mid-image.
    const escaped = `data:image/png;base64,${PNG.slice(0, 16)}\\/${PNG.slice(16)}`;
    const { value } = redactor.redactString(escaped);
    expect(value).not.toContain('<secret:high_entropy');
  });
});
