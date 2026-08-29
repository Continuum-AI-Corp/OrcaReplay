import { describe, expect, it } from 'vitest';
import type { CanonicalRequest } from '@orcareplay/plugin-api';
import { RequestMatcher, canonicalHash, normalizeRequest, structuralDistance } from '../src/matching.js';

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
  const recorded = [req(), req({ messages: [{ role: 'user', content: [{ type: 'text', text: 'second' }] }] })];

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
    expect(r.divergence, 'an inexact match without a divergence is the bug we must not ship')
      .toBeDefined();
  });

  it('reports exhaustion rather than matching past the end of the recording', () => {
    const m = new RequestMatcher([req()]);
    m.match(req());
    const past = m.match(req());
    expect(past.matched).toBe(false);
    expect(past.reason).toContain('exhausted');
  });
});
