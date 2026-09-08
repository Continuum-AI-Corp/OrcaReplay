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

  // An exchange stepped over without mention is a replay claiming to reproduce what it passed by.
  it('says how many it stepped over, even when the match itself was exact', () => {
    const m = new RequestMatcher([req('quota'), req('ask')]);
    const result = m.match(req('ask'));
    expect(result.skipped).toBe(1);
    expect(result.divergence?.detail ?? '').toContain('holding 1 recorded request');
  });

  /**
   * The case that made stepping over reversible.
   *
   * goose asks a second model for a session title while the conversation is already under way, so
   * the title call and the first real turn race and do not land in the same order twice. Stepping
   * over used to *discard* what it passed, which meant a replay whose title arrived first threw
   * away the first turn on its way to matching the title — and then halted on the very next
   * request, against a recording that contained everything it needed.
   */
  it('still serves a request it stepped over, when that is what comes next', () => {
    const m = new RequestMatcher([req('the first turn'), req('name this session')]);

    const title = m.match(req('name this session'));
    expect(title.index).toBe(1);
    expect(title.skipped).toBe(1);

    const turn = m.match(req('the first turn'));
    expect(turn.matched).toBe(true);
    expect(turn.index).toBe(0);
    expect(turn.divergence?.detail ?? '').toContain('out of the order it was recorded in');
  });

  it('serves a held request even after the cursor has run off the end', () => {
    const m = new RequestMatcher([req('held back'), req('last')]);
    expect(m.match(req('last')).index).toBe(1);
    expect(m.match(req('held back')).index).toBe(0);
  });

  // Held, not forgotten: a request set aside is still owed to the replay, and `reused=x/y` counts
  // it as unplayed until it is served.
  it('counts a held request as still remaining', () => {
    const m = new RequestMatcher([req('held back'), req('asked first')]);
    m.match(req('asked first'));
    expect(m.remaining()).toBe(1);
    m.match(req('held back'));
    expect(m.remaining()).toBe(0);
  });

  // The same bar as a step-forward. Below rung 2 the agent would be handed some other turn's
  // answer, which is worse than halting and saying so.
  it('does not serve a held request on a weak match', () => {
    const m = new RequestMatcher([req('a question about billing'), req('asked first')]);
    m.match(req('asked first'));
    const result = m.match(req('an unrelated question about deployment'));
    expect(result.matched).toBe(false);
    expect(result.rung).toBe(4);
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
