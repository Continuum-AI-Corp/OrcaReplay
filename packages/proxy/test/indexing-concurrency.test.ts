import { describe, expect, it } from 'vitest';
import type { CanonicalRequest } from '@orcareplay/plugin-api';
import { RequestMatcher } from '../src/matching.js';

/**
 * The indexing workload: many requests that share an instruction and differ only in the document.
 *
 * This is the shape every index-building RAG pipeline has — IndexRAG, Microsoft GraphRAG,
 * LightRAG, LlamaIndex ingestion — and it was the one shape the ladder got wrong. The prompt
 * template is the *message*; the paragraph being processed rides in the system prompt. So every
 * request's trailing message is identical to every other's, `sameAsk` is true against all of
 * them, and rung 3 — whose stated reason for existing is context compaction, which rewrites
 * `messages` — waved each one through against whichever recorded request the cursor was on.
 *
 * Measured on 30 real HotpotQA paragraphs at concurrency 10 before the guard: 24 requests served
 * another paragraph's answer, `divergences=24`, `unmatched=0`, `exit=0`. The knowledge base built
 * from a replay of that recording is a knowledge base of mismatched answers, and nothing in the
 * run says so.
 */
function extraction(i: number): CanonicalRequest {
  return {
    model: 'gpt-4o-mini',
    // The paragraph. Different every time, and not in `messages`.
    system: `Extract atomic knowledge units.\n\nDocument ${i}: ${'lorem ipsum '.repeat(20)}${i}`,
    // The instruction. Byte-identical across all 30 requests.
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Return the AKUs as JSON.' }] }],
    temperature: 0,
  };
}

/** The order a worker pool of `width` hands work back: reversed inside each window. */
function shuffled(total: number, width: number): number[] {
  const out: number[] = [];
  for (let start = 0; start < total; start += width) {
    const window = [];
    for (let i = start; i < Math.min(start + width, total); i += 1) window.push(i);
    out.push(...window.reverse());
  }
  return out;
}

describe('a concurrent indexing pipeline', () => {
  it('serves each request its own recorded answer, out of order, at width 10', () => {
    const recorded = Array.from({ length: 30 }, (_, i) => extraction(i));
    const matcher = new RequestMatcher(recorded, { concurrency: () => 10 });

    for (const i of shuffled(30, 10)) {
      const result = matcher.match(extraction(i));
      expect(result.matched, `request ${i} did not match`).toBe(true);
      expect(result.index, `request ${i} was served request ${result.index}'s answer`).toBe(i);
    }
  });

  /**
   * The window is a floor, not a ceiling, and a byte-identical match is not bounded by it at all.
   * A pipeline whose requests came back in a wholly different order still gets each one its own
   * answer — the reach is safe precisely because "identical after redaction" cannot be a
   * coincidence.
   */
  it('serves them in fully reversed order, past any fixed window', () => {
    const recorded = Array.from({ length: 30 }, (_, i) => extraction(i));
    const matcher = new RequestMatcher(recorded);

    for (let i = 29; i >= 0; i -= 1) {
      const result = matcher.match(extraction(i));
      expect(result.matched, `request ${i} did not match`).toBe(true);
      expect(result.index).toBe(i);
    }
    expect(matcher.remaining()).toBe(0);
  });

  /**
   * The one that survived the rung-3 guard and was found by a real replay.
   *
   * Rung 2 measures drift as a share of the request's own size, and an extraction prompt is
   * mostly a fixed template — so two paragraphs differing by a few hundred characters inside a
   * request of several thousand fall *inside* tolerance, `sameAsk` is true because the only
   * message is a constant instruction, and the cursor's near-match was taken while the real
   * answer sat unplayed further along. Measured on three real documents: `exact=1`, five `minor`
   * divergences, and a cache whose chunks carried each other's extractions.
   *
   * The fix is an ordering rather than another guard: an exact match anywhere outranks an
   * approximate one at the cursor.
   */
  it('prefers its own answer further along over a near-match at the cursor', () => {
    // Close enough to be inside rung 2's tolerance against each other, and not identical.
    const template = 'Extract the facts.\n'.repeat(60);
    const near = (i: number): CanonicalRequest => ({
      model: 'gpt-4o-mini',
      system: `${template}Document: ${'x'.repeat(200)}${i}`,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Return JSON.' }] }],
    });

    // Proof the trap is real: against request 0, request 1 is a rung-2 match.
    const trap = new RequestMatcher([near(0)]).match(near(1));
    expect(trap.matched).toBe(true);
    expect(trap.rung).toBe(2);

    // And with its own answer in the recording, that is what it gets.
    const matcher = new RequestMatcher([near(0), near(1), near(2)]);
    expect(matcher.match(near(1)).index).toBe(1);
    expect(matcher.match(near(2)).index).toBe(2);
    expect(matcher.match(near(0)).index).toBe(0);
  });

  /**
   * The residue, once nothing in the recording is byte-identical any more.
   *
   * A real recording carries per-run values — a session id, a timestamp — so a replay's request
   * is rarely byte-equal even when it is unmistakably the same question, and the exact path above
   * does not fire. The ladder then has to approximate, and *which* recorded request it
   * approximates against is the whole answer: on eight real documents at concurrency 10 the
   * approximations still landed on the wrong document, because the cursor's near-match was taken
   * for being the cursor's rather than for being near.
   *
   * `leafDistance` already knows which candidate is closer. Using it is the fix.
   */
  it('approximates against the nearest recorded request, not the nearest to hand', () => {
    const template = 'Extract the facts.\n'.repeat(60);
    // The drifting part: present in every request, different on every run, so nothing matches
    // exactly and every comparison lands on rung 2.
    const drifted = (i: number, run: string): CanonicalRequest => ({
      model: 'gpt-4o-mini',
      system: `${template}Session ${run}\nDocument: ${'x'.repeat(200)}${i}`,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Return JSON.' }] }],
    });

    // Proof the trap is real: on its own, document 0 *does* accept document 2's request at
    // rung 2 — which is what the cursor would have served.
    const trap = new RequestMatcher([drifted(0, 'recorded')]).match(drifted(2, 'replayed'));
    expect(trap.matched).toBe(true);
    expect(trap.rung).toBe(2);

    const matcher = new RequestMatcher([0, 1, 2, 3].map((i) => drifted(i, 'recorded')));
    // Nothing is exact, and document 2's request is a rung-2 match against document 0 sitting at
    // the cursor. Its own answer is two positions along and closer.
    expect(matcher.match(drifted(2, 'replayed')).index).toBe(2);
    expect(matcher.match(drifted(0, 'replayed')).index).toBe(0);
    expect(matcher.match(drifted(3, 'replayed')).index).toBe(3);
    expect(matcher.match(drifted(1, 'replayed')).index).toBe(1);
  });

  /**
   * The guard itself, isolated. Same ask, same message count, a system prompt that differs by more
   * than rung 2's tolerance: that is a different request, and the honest answer is rung 4.
   */
  it('refuses a different document at the cursor rather than calling it a compaction', () => {
    const matcher = new RequestMatcher([extraction(0)]);
    const result = matcher.match(extraction(1));
    expect(result.matched).toBe(false);
    expect(result.rung).toBe(4);
  });

  /**
   * What rung 3 is actually for, unchanged. Compaction rewrites the history and leaves the
   * question standing, so the message counts differ — which is the condition the guard added.
   */
  it('still matches a compacted conversation at rung 3', () => {
    const ask = { role: 'user' as const, content: [{ type: 'text' as const, text: 'and now?' }] };
    const long: CanonicalRequest = {
      model: 'claude-opus-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'the first turn' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'a second turn' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'another answer' }] },
        ask,
      ],
    };
    const compacted: CanonicalRequest = {
      model: 'claude-opus-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'summary of the conversation so far' }] },
        ask,
      ],
    };

    const result = new RequestMatcher([long]).match(compacted);
    expect(result.matched).toBe(true);
    expect(result.rung).toBe(3);
    expect(result.divergence?.level).toBe('major');
  });
});
