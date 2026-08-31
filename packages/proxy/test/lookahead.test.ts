import { describe, expect, it } from 'vitest';
import type { CanonicalRequest } from '@orcareplay/plugin-api';
import { RequestMatcher } from '../src/matching.js';

/**
 * Stepping over what the replay did not repeat.
 *
 * A recording made through a terminal holds calls the harness made for itself: a quota probe
 * before the first turn, a request to name the session. A replay driven from a transcript never
 * makes them, and the cursor used to stop dead on the first one — so a recording of an ordinary
 * interactive session could not be replayed at all, however faithful the rest of it was.
 */
function req(text: string, over: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    ...over,
  };
}

describe('RequestMatcher lookahead', () => {
  it('steps over a recorded request the replay did not make', () => {
    const m = new RequestMatcher([req('quota'), req('the real question')]);
    const result = m.match(req('the real question'));
    expect(result.matched).toBe(true);
    expect(result.index).toBe(1);
    expect(result.skipped).toBe(1);
  });

  // A skipped exchange that goes unmentioned is a replay claiming to reproduce what it stepped over.
  it('says how many it stepped over, even when the match itself was exact', () => {
    const m = new RequestMatcher([req('quota'), req('ask')]);
    const result = m.match(req('ask'));
    expect(result.skipped).toBe(1);
    expect(result.divergence?.detail ?? '').toContain('skipping 1 recorded request');
  });

  it('does not step over anything when the cursor already matches', () => {
    const m = new RequestMatcher([req('a'), req('b')]);
    const result = m.match(req('a'));
    expect(result.index).toBe(0);
    expect(result.skipped).toBeUndefined();
  });

  /**
   * Only an exact or near-exact match is worth stepping over an unplayed exchange for. A loose one
   * would hand the agent some other turn's answer, which is worse than halting and saying so.
   */
  it('halts rather than stepping onto a weak match', () => {
    const m = new RequestMatcher([req('first question'), req('a completely different question')]);
    const result = m.match(req('something else again'));
    expect(result.matched).toBe(false);
    expect(result.rung).toBe(4);
  });

  it('leaves the cursor past the request it matched, not past the one it skipped', () => {
    const m = new RequestMatcher([req('quota'), req('one'), req('two')]);
    m.match(req('one'));
    expect(m.match(req('two')).index).toBe(2);
  });

  /**
   * A session recorded through a terminal is offered tools that need one — asking a question,
   * entering plan mode. Their schemas are large, so the distance runs into six figures and reads
   * as a corrupted trace rather than as the same agent started two different ways.
   */
  it('names the tools the recording had that the replay cannot', () => {
    const withTools = req('ask', {
      tools: [
        { name: 'Read', description: '', input_schema: {} },
        { name: 'AskUserQuestion', description: '', input_schema: {} },
      ],
    });
    const withoutTools = req('a different ask entirely', {
      tools: [{ name: 'Read', description: '', input_schema: {} }],
    });
    const result = new RequestMatcher([withTools]).match(withoutTools);
    expect(result.matched).toBe(false);
    expect(result.reason).toContain('AskUserQuestion');
    expect(result.reason).toContain('a session recorded through a terminal');
  });

  it('says nothing about tools when both sides offer the same ones', () => {
    const tools = [{ name: 'Read', description: '', input_schema: {} }];
    const result = new RequestMatcher([req('one thing', { tools })]).match(
      req('a totally unrelated other thing', { tools }),
    );
    expect(result.matched).toBe(false);
    expect(result.reason).not.toContain('tools');
  });
});
