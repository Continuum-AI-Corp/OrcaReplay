import { describe, expect, it } from 'vitest';
import type { CanonicalRequest } from '@orcareplay/plugin-api';
import type { RecordedExchange } from '@orcareplay/proxy';
import { ExchangeEventDeriver, retrievalContext } from '../src/exchange-events.js';

/**
 * Retrieval evidence, read out of the prompt that carried it.
 *
 * A RAG system retrieves in-process — FAISS is a library call — so no proxy can watch it happen.
 * What a proxy can see is the prompt it produced, and the passages are in there verbatim, because
 * putting them there is the point. Same standing as `tool.call`: reconstructed from traffic, with
 * no new capture mechanism anywhere.
 *
 * The prompt below is IndexRAG's, spelled the way `benchmarks/evaluate.py` spells it.
 */
const INDEXRAG_PROMPT = `Context:
Marie Curie was a physicist and chemist who conducted pioneering research on radioactivity.

---

She was born in Warsaw in 1867 and later moved to Paris to study at the Sorbonne.

Question: Where was Marie Curie born?

Answer (be extremely concise):`;

function ask(text: string, over: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    ...over,
  };
}

function exchange(req: CanonicalRequest): RecordedExchange {
  return {
    seq: 0,
    dialect: 'openai',
    path: '/v1/chat/completions',
    rawRequest: JSON.stringify(req),
    rawResponse: '{}',
    status: 200,
    streamed: false,
    canonicalRequest: req,
    canonicalResponse: {
      id: 'chatcmpl-1',
      model: 'gpt-4o-mini',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Warsaw' }],
      usage: { input_tokens: 120, output_tokens: 2 },
    },
  };
}

describe('retrievalContext', () => {
  it('pulls the question and each passage out of a RAG prompt', () => {
    const found = retrievalContext(ask(INDEXRAG_PROMPT));
    expect(found?.query).toBe('Where was Marie Curie born?');
    expect(found?.passages).toHaveLength(2);
    expect(found?.passages[0]).toContain('pioneering research on radioactivity');
    expect(found?.passages[1]).toContain('born in Warsaw in 1867');
  });

  // The closing instruction is a property of the template, not of the question. Folding it in
  // would make two runs that asked the same thing look like they asked different things.
  it('stops the query at the blank line before the template closes', () => {
    const found = retrievalContext(ask(INDEXRAG_PROMPT));
    expect(found?.query).not.toContain('Answer');
  });

  it('falls back to blank lines when the template has no rule between passages', () => {
    const found = retrievalContext(
      ask('Context:\nfirst passage\n\nsecond passage\n\nQuestion: which?\n'),
    );
    expect(found?.passages).toEqual(['first passage', 'second passage']);
    expect(found?.query).toBe('which?');
  });

  it('reads a single undivided passage as one', () => {
    const found = retrievalContext(ask('Context:\njust the one\nQuestion: what?\n'));
    expect(found?.passages).toEqual(['just the one']);
  });

  it('accepts the other labels templates use', () => {
    expect(retrievalContext(ask('Documents:\na doc\n\nQuery: why?\n'))?.query).toBe('why?');
    expect(retrievalContext(ask('Retrieved context:\na doc\n\nQuestion: how?\n'))?.query).toBe(
      'how?',
    );
  });

  /**
   * Deliberately narrow. A rule that fired on "long message with paragraphs" would file half the
   * coding-agent traffic in the world as retrieval evidence, and a timeline that cries retrieval
   * on every long prompt is worth less than no timeline at all.
   */
  it.each([
    ['an ordinary question', 'What is the capital of France?'],
    ['a long prompt with paragraphs', `${'some prose\n\n'.repeat(20)}and a final thought`],
    ['context with no question', 'Context:\na passage\n\nmore prose'],
    ['a question with no context', 'Question: where?\n'],
    ['an empty context block', 'Context:\n\nQuestion: where?\n'],
  ])('finds nothing in %s', (_label, text) => {
    expect(retrievalContext(ask(text))).toBeUndefined();
  });

  it('reads only the trailing user message, not an assistant turn', () => {
    const req = ask('and now?', {
      messages: [
        { role: 'user', content: [{ type: 'text', text: INDEXRAG_PROMPT }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Warsaw' }] },
        { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
      ],
    });
    expect(retrievalContext(req)).toBeUndefined();
  });
});

describe('the derived event', () => {
  it('comes before the request that carried it, and the request names it', () => {
    const events = new ExchangeEventDeriver().derive(exchange(ask(INDEXRAG_PROMPT)), 1);
    expect(events.map((e) => e.type)).toEqual([
      'retrieval.context',
      'model.request',
      'model.response',
    ]);
    // The same edge a tool result gets, for the same reason: it describes work that happened
    // before this call was made.
    expect(events[1]!.causesIndex).toEqual([0]);
    expect(events[0]!.actor).toBe('harness');
  });

  it('carries the query and the passages, and counts rather than invents', () => {
    const [context] = new ExchangeEventDeriver().derive(exchange(ask(INDEXRAG_PROMPT)), 1);
    expect(context!.attrs['query']).toBe('Where was Marie Curie born?');
    expect(context!.attrs['passages']).toBe(2);
    // `passages`, never `top_k`: the prompt holds what survived `--context-docs`, and reporting
    // that count as top-k would be a measurement nobody made.
    expect(Object.keys(context!.attrs)).not.toContain('top_k');
    expect(Object.keys(context!.attrs)).not.toContain('scores');
    expect((context!.payload as { passages: string[] }).passages).toHaveLength(2);
  });

  it('does not re-emit the same context when the conversation is resent', () => {
    const deriver = new ExchangeEventDeriver();
    expect(deriver.derive(exchange(ask(INDEXRAG_PROMPT)), 1).map((e) => e.type)).toContain(
      'retrieval.context',
    );
    expect(deriver.derive(exchange(ask(INDEXRAG_PROMPT)), 2).map((e) => e.type)).not.toContain(
      'retrieval.context',
    );
  });

  it('emits a second one for a different question', () => {
    const deriver = new ExchangeEventDeriver();
    deriver.derive(exchange(ask(INDEXRAG_PROMPT)), 1);
    const next = deriver.derive(
      exchange(ask('Context:\nanother passage\n\nQuestion: and this one?\n')),
      2,
    );
    expect(next.map((e) => e.type)).toContain('retrieval.context');
  });

  it('leaves an ordinary exchange exactly as it was', () => {
    const events = new ExchangeEventDeriver().derive(exchange(ask('fix the auth test')), 1);
    expect(events.map((e) => e.type)).toEqual(['model.request', 'model.response']);
    expect(events[0]!.causesIndex).toBeUndefined();
  });
});
