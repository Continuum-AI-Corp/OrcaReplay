import { describe, expect, it } from 'vitest';
import type { CanonicalRequest } from '@orcareplay/plugin-api';
import { RequestMatcher, canonicalHash, structuralDistance } from '../src/matching.js';

/**
 * A replay cannot re-render a screenshot, so the matcher must not compare one.
 *
 * This is the same argument the salted-placeholder fold already makes, arriving through a
 * different door. Orca does not intercept the world: replaying a browser agent drives the *real*
 * browser, which paints the page a second time, and two paintings of one page are not the same
 * bytes — a caret blinked, a font landed a frame later, the article was edited between runs.
 *
 * Measured on a browser-use run against Wikipedia, recorded and then replayed:
 *
 *     turn 1   distance 545,134   —   with the pixels set aside: 171
 *
 * The screenshot is 94% of the request body, so no rung-2 budget can absorb it: one generous
 * enough to admit a repainted page would admit a different conversation. Replay of any agent with
 * eyes was therefore impossible by construction, not by bad luck.
 *
 * What makes the fold safe is that the pixels are not what identify the request. browser-use sends
 * the element tree, the page URL and the agent's own memory in the same message, as text, and that
 * text stays fully compared — in the same measurement, the turns where the two runs genuinely took
 * different paths still scored 14,191, 19,409 and 57,519 with the pixels already set aside.
 */

const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ';
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFhgJ/lRGGKQ';

/** A turn shaped like browser-use's: what the page looks like, and what the page *is*. */
function shot(
  png: string,
  page = 'url=https://en.wikipedia.org\n[18]<input search>',
): CanonicalRequest {
  return {
    model: 'gpt-5.6-luna',
    system: 'You are a browser agent.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: page },
          { type: 'image', media_type: 'image/png', data: png },
        ],
      },
    ],
    max_tokens: 4096,
  };
}

describe('image payloads below rung 1', () => {
  it('does not count a repainted screenshot as distance', () => {
    expect(structuralDistance(shot(PNG_A), shot(PNG_B))).toBe(0);
  });

  it('still counts the text that came with it', () => {
    const moved = shot(PNG_B, 'url=https://en.wikipedia.org/wiki/Orca\n[18]<input search>');
    expect(structuralDistance(shot(PNG_A), moved)).toBeGreaterThan(0);
  });

  it('matches a replayed turn whose only difference is the repaint', () => {
    const matcher = new RequestMatcher([shot(PNG_A)]);
    const result = matcher.match(shot(PNG_B));
    expect(result.matched).toBe(true);
    expect(result.rung).toBe(2);
  });

  it('names the images in the divergence, rather than matching quietly', () => {
    // The spec's rule for the whole ladder: replay never silently approximates. A fold nobody is
    // told about is exactly that.
    const matcher = new RequestMatcher([shot(PNG_A)]);
    const { divergence } = matcher.match(shot(PNG_B));
    expect(divergence?.level).toBe('minor');
    expect(divergence?.detail).toContain('1 image');
    expect(divergence?.detail).toContain('pixels are not compared');
  });

  it('says "images" for more than one, and does not mention redaction when nothing was redacted', () => {
    // The bug this pins: the rung-2a sentence used to name only the placeholder fold, so a request
    // that reached it on the image fold alone read "identical apart from 0 redacted values".
    const two = (png: string): CanonicalRequest => ({
      ...shot(png),
      messages: [
        { role: 'user', content: [{ type: 'image', media_type: 'image/png', data: png }] },
        { role: 'assistant', content: [{ type: 'text', text: 'looking' }] },
        { role: 'user', content: [{ type: 'image', media_type: 'image/png', data: png }] },
      ],
    });
    const { divergence } = new RequestMatcher([two(PNG_A)]).match(two(PNG_B));
    expect(divergence?.detail).toContain('2 images');
    expect(divergence?.detail).not.toContain('redacted');
  });

  it('keeps rung 1 meaning exact — the payload is still in the canonical hash', () => {
    // The fold is below rung 1 only. A run whose screenshots genuinely came back identical must
    // still be reported as an exact match, and two different images must not hash alike.
    expect(canonicalHash(shot(PNG_A))).toBe(canonicalHash(shot(PNG_A)));
    expect(canonicalHash(shot(PNG_A))).not.toBe(canonicalHash(shot(PNG_B)));
    expect(new RequestMatcher([shot(PNG_A)]).match(shot(PNG_A)).rung).toBe(1);
  });

  it('does not let a different page through on the strength of a folded image', () => {
    // The whole risk of the fold. A screenshot of some other site arrives with the text that
    // describes that other site, and it is the text that must halt the replay.
    const elsewhere = shot(PNG_B, 'url=https://example.com/login\n[3]<input password>');
    const result = new RequestMatcher([shot(PNG_A)]).match(elsewhere);
    expect(result.matched).toBe(false);
    expect(result.rung).toBe(4);
  });

  it('keeps the media type, so a PNG does not match a JPEG', () => {
    const jpeg: CanonicalRequest = {
      ...shot(PNG_B),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'url=https://en.wikipedia.org\n[18]<input search>' },
            { type: 'image', media_type: 'image/jpeg', data: PNG_B },
          ],
        },
      ],
    };
    expect(structuralDistance(shot(PNG_A), jpeg)).toBeGreaterThan(0);
  });
});
