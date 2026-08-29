import { describe, expect, it } from 'vitest';
import { Redactor } from '@orcareplay/core';
import type { CanonicalRequest } from '@orcareplay/plugin-api';
import {
  RequestMatcher,
  canonicalHash,
  normalizeRequest,
  structuralDistance,
} from '../src/matching.js';

function req(over: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'claude-opus-5',
    system: 'be terse',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the auth test' }] }],
    tools: [{ name: 'bash', input_schema: { type: 'object' } }],
    max_tokens: 4096,
    ...over,
  };
}

describe('normalizeRequest', () => {
  it('sorts tools by name so declaration order cannot change the hash', () => {
    const a = normalizeRequest(
      req({
        tools: [
          { name: 'zed', input_schema: {} },
          { name: 'alpha', input_schema: {} },
        ],
      }),
    );
    const b = normalizeRequest(
      req({
        tools: [
          { name: 'alpha', input_schema: {} },
          { name: 'zed', input_schema: {} },
        ],
      }),
    );
    expect(a).toEqual(b);
  });

  it('drops volatile fields that change every run', () => {
    const n = normalizeRequest(
      req({ metadata: { request_id: 'req_abc', user_id: 'u1', session: 's9' } }),
    );
    expect(JSON.stringify(n)).not.toContain('req_abc');
  });

  it('keeps sampling parameters, which genuinely change the result', () => {
    expect(canonicalHash(req({ temperature: 0 }))).not.toBe(canonicalHash(req({ temperature: 1 })));
  });

  it('is stable across key insertion order', () => {
    const a: CanonicalRequest = { model: 'm', messages: [], max_tokens: 10 };
    const b: CanonicalRequest = { max_tokens: 10, messages: [], model: 'm' } as CanonicalRequest;
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });
});

describe('canonicalHash', () => {
  it('is deterministic for identical requests', () => {
    expect(canonicalHash(req())).toBe(canonicalHash(req()));
  });

  it('changes when a message changes', () => {
    const other = req({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'different' }] }],
    });
    expect(canonicalHash(req())).not.toBe(canonicalHash(other));
  });

  it('returns a 64-character hex digest', () => {
    expect(canonicalHash(req())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('structuralDistance', () => {
  it('is zero for identical requests', () => {
    expect(structuralDistance(req(), req())).toBe(0);
  });

  it('grows with the number of differing messages', () => {
    const one = req({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
    });
    const two = req({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      ],
    });
    expect(structuralDistance(one, two)).toBeGreaterThan(0);
  });
});

describe('RequestMatcher — the ladder from spec §4', () => {
  const recorded = [
    req(),
    req({ messages: [{ role: 'user', content: [{ type: 'text', text: 'second' }] }] }),
  ];

  it('rung 1: an identical request matches exactly and reports no divergence', () => {
    const m = new RequestMatcher(recorded);
    const r = m.match(req());
    expect(r.matched).toBe(true);
    expect(r.rung).toBe(1);
    expect(r.divergence).toBeUndefined();
    expect(r.index).toBe(0);
  });

  it('rung 1 ignores volatile metadata differences', () => {
    const m = new RequestMatcher(recorded);
    expect(m.match(req({ metadata: { request_id: 'fresh' } })).rung).toBe(1);
  });

  it('never treats a changed question as a minor difference, however small the edit', () => {
    // The failure this locks out: rung 2 used to accept *any* difference within tolerance, and the
    // tolerance has a 64-character floor. On a short request that floor is a large share of the
    // whole body, so replacing "fix the auth test" with "do something completely different" landed
    // inside it — and OrcaReplay answered a different question with the recorded reply and filed it
    // as `minor`. The ask is the one thing that can never be incidental: rung 2 is for drift around
    // the question (a regenerated id, a changed cwd), not the question itself.
    const m = new RequestMatcher(recorded);
    const r = m.match(
      req({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'do something completely different' }] },
        ],
      }),
    );
    expect(r.matched).toBe(false);
    expect(r.rung).toBe(4);
  });

  it('does not advance the cursor when it refuses a request', () => {
    // A refusal is not consumption. If the cursor moved, a retrying harness would be matched
    // against the *next* recorded exchange and could be handed an answer from further down the run.
    const m = new RequestMatcher(recorded);
    const other = req({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'unrelated question' }] }],
    });
    expect(m.match(other).matched).toBe(false);
    expect(m.cursor).toBe(0);
    expect(m.match(req()).rung).toBe(1);
  });

  it('rung 2: same position and message count with a small difference is a minor divergence', () => {
    const m = new RequestMatcher(recorded);
    const r = m.match(req({ system: 'be terse.' }));
    expect(r.matched).toBe(true);
    expect(r.rung).toBe(2);
    expect(r.divergence?.level).toBe('minor');
    expect(r.divergence?.detail).toBeTruthy();
  });

  it('rung 3: same trailing message but a different prefix is a major divergence', () => {
    const compacted = req({
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: '[history compacted]' }] },
        { role: 'user', content: [{ type: 'text', text: 'fix the auth test' }] },
      ],
    });
    const m = new RequestMatcher(recorded);
    const r = m.match(compacted);
    expect(r.matched).toBe(true);
    expect(r.rung).toBe(3);
    expect(r.divergence?.level).toBe('major');
  });

  it('rung 4: an unrelated request does not match', () => {
    const m = new RequestMatcher(recorded);
    const r = m.match(
      req({
        model: 'other',
        system: undefined,
        tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'entirely unrelated ask' }] }],
      }),
    );
    expect(r.matched).toBe(false);
    expect(r.rung).toBe(4);
  });

  it('consumes each recorded request once, in order', () => {
    const m = new RequestMatcher(recorded);
    expect(m.match(req()).index).toBe(0);
    const second = m.match(
      req({ messages: [{ role: 'user', content: [{ type: 'text', text: 'second' }] }] }),
    );
    expect(second.index).toBe(1);
    expect(m.remaining()).toBe(0);
  });

  it('never silently approximates: every inexact match carries a divergence', () => {
    const m = new RequestMatcher(recorded);
    const r = m.match(req({ system: 'be terse.' }));
    expect(r.rung).toBeGreaterThan(1);
    expect(
      r.divergence,
      'an inexact match without a divergence is the bug we must not ship',
    ).toBeDefined();
  });

  it('reports exhaustion rather than matching past the end of the recording', () => {
    const m = new RequestMatcher([req()]);
    m.match(req());
    const past = m.match(req());
    expect(past.matched).toBe(false);
    expect(past.reason).toContain('exhausted');
  });
});

describe('structuralDistance — bounded to the leaves that differ', () => {
  /**
   * The regression that a real recording found. Claude Code carries a session-scoped id in both its
   * system prompt and its tool descriptions, and the old prefix/suffix metric counted everything
   * between the two as changed: a sixteen-character drift scored 217,568, so rung 2 could not fire
   * on any real harness and every replay halted at rung 4.
   */
  it('does not count the identical body between two far-apart edits', () => {
    const filler = 'x'.repeat(50_000);
    const tool = (tail: string) => [
      { name: 'bash', description: `${filler}${tail}`, input_schema: {} },
    ];
    const a = req({ system: `A${filler}`, tools: tool('A') });
    const b = req({ system: `B${filler}`, tools: tool('B') });

    expect(structuralDistance(a, b)).toBeLessThan(64);
  });

  it('still counts a whole message that only one side has', () => {
    const long = 'y'.repeat(5_000);
    const a = req();
    const b = req({
      messages: [...req().messages, { role: 'assistant', content: [{ type: 'text', text: long }] }],
    });
    expect(structuralDistance(a, b)).toBeGreaterThan(5_000);
  });
});

describe('RequestMatcher — a live request meeting a redacted recording', () => {
  const secret = 'sk-live-9f2c14a03b71d4e8a7c5';

  function redactedWith(salt: string, text: string): string {
    return new Redactor({ salt }).redactString(text).value;
  }

  /** A secret in the *ask* is the case that decides the run: rung 2 will not stretch to cover it. */
  function asked(text: string): CanonicalRequest {
    return req({ messages: [{ role: 'user', content: [{ type: 'tool_result', content: text }] }] });
  }

  it('matches a placeholder against the secret it stands for, and says it approximated', () => {
    const recorded = asked(redactedWith('recording', `key ${secret}`));
    expect(JSON.stringify(recorded)).toContain('<secret:sk_api_key:');

    const m = new RequestMatcher([recorded], { redactor: new Redactor({ salt: 'replay' }) });
    const r = m.match(asked(`key ${secret}`));

    expect(r.matched).toBe(true);
    expect(r.rung).toBe(2);
    expect(r.divergence?.level).toBe('minor');
    expect(r.divergence?.detail).toContain('1 redacted value');
  });

  it('cannot match it without a redactor, because the two are not in the same representation', () => {
    const recorded = asked(redactedWith('recording', `key ${secret}`));
    const r = new RequestMatcher([recorded]).match(asked(`key ${secret}`));
    expect(r.matched).toBe(false);
    expect(r.rung).toBe(4);
  });

  it('rung 1 stays exact: a request with nothing redacted in it reports no divergence', () => {
    const m = new RequestMatcher([req()], { redactor: new Redactor({ salt: 'replay' }) });
    const r = m.match(req());
    expect(r.rung).toBe(1);
    expect(r.divergence).toBeUndefined();
  });
});

describe('RequestMatcher — how far the ask itself may drift', () => {
  function result(text: string) {
    return req({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'fix the auth test' }] },
        { role: 'user', content: [{ type: 'tool_result', content: text }] },
      ],
    });
  }

  it('tolerates a regenerated path inside a large tool result', () => {
    const body = 'skill body\n'.repeat(400);
    const m = new RequestMatcher([result(`/cache/50248ab48d3dd46003f12c11173be1b5/run\n${body}`)]);
    const r = m.match(result(`/cache/75c3aa9fd9090d6443ba7077a82fea4a/run\n${body}`));

    expect(r.matched).toBe(true);
    expect(r.rung).toBe(2);
    expect(r.divergence?.detail).toContain('in the trailing message');
  });

  it('refuses a short question that was swapped for another of the same shape', () => {
    const m = new RequestMatcher([
      req({ messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the auth test' }] }] }),
    ]);
    const r = m.match(
      req({ messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the auth code' }] }] }),
    );
    expect(r.matched).toBe(false);
    expect(r.rung).toBe(4);
  });

  it('caps the tolerance absolutely, so a huge result cannot buy a huge licence to differ', () => {
    const body = 'z'.repeat(200_000);
    const m = new RequestMatcher([result(`${body}${'a'.repeat(1_000)}`)]);
    const r = m.match(result(`${body}${'b'.repeat(1_000)}`));

    expect(r.matched).toBe(false);
    expect(r.rung).toBe(4);
  });
});
