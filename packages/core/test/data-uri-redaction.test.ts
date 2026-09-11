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

  it('covers a payload carrying escaped characters, as a JSON-encoded body does', () => {
    // A body reaches the trace inside JSON, so the span has to include `\` or it ends one byte
    // early and the sweep resumes mid-image.
    const redactor = new Redactor({});
    const escaped = `data:image/png;base64,AAAA\\/BBBB${PNG}`;
    const { value } = redactor.redactString(escaped);
    expect(value).not.toContain('<secret:high_entropy');
  });
});
