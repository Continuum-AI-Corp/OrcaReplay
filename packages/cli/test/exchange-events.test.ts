import { describe, expect, it } from 'vitest';
import type { RecordedExchange } from '@orcareplay/proxy';
import { ExchangeEventDeriver } from '../src/exchange-events.js';

function exchange(over: Partial<RecordedExchange> = {}): RecordedExchange {
  return {
    seq: 0,
    dialect: 'anthropic',
    path: '/v1/messages',
    rawRequest: '{}',
    rawResponse: '{}',
    status: 200,
    streamed: false,
    canonicalRequest: {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'fix it' }] }],
    },
    canonicalResponse: {
      id: 'msg_0',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 3 },
    },
    ...over,
  };
}

describe('ExchangeEventDeriver', () => {
  it('derives a request and a response for a plain exchange', () => {
    const events = new ExchangeEventDeriver().derive(exchange(), 1);
    expect(events.map((e) => e.type)).toEqual(['model.request', 'model.response']);
    expect(events[1]!.attrs.input_tokens).toBe(10);
  });

  it('derives a tool.call from a tool_use in the response', () => {
    const events = new ExchangeEventDeriver().derive(
      exchange({
        canonicalResponse: {
          id: 'msg_0',
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'npm test' } }],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      }),
      1,
    );
    expect(events.map((e) => e.type)).toContain('tool.call');
    expect(events.at(-1)!.attrs.name).toBe('bash');
  });

  it('closes a tool call using the result carried by the NEXT request', () => {
    const d = new ExchangeEventDeriver();
    d.derive(
      exchange({
        canonicalResponse: {
          id: 'msg_0',
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      }),
      1,
    );
    expect(d.unresolved().map((p) => p.id)).toEqual(['tu_1']);

    const next = d.derive(
      exchange({
        canonicalRequest: {
          model: 'claude-opus-5',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'tu_1', content: 'FAIL', is_error: true },
              ],
            },
          ],
        },
      }),
      2,
    );

    expect(next[0]!.type).toBe('tool.result');
    expect(next[0]!.attrs.name).toBe('bash');
    expect(next[0]!.attrs.is_error).toBe(true);
    expect(next[0]!.payload).toBe('FAIL');
    expect(d.unresolved()).toHaveLength(0);
  });

  it('links a tool result back to the call that produced it', () => {
    // `causes` is the only thing that turns a flat event list into a chain you can walk, and it was
    // never set on a `tool.result`: `derive()` dropped the pending entry in the same loop that
    // built the event, so by the time the recorder asked for the call's seq there was nothing left
    // to answer with. The recorder does that lookup *after* derive returns, which is why deleting
    // early broke it silently — no error, just an empty field on every tool result ever recorded.
    const d = new ExchangeEventDeriver();
    d.derive(
      exchange({
        canonicalResponse: {
          id: 'msg_0',
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      }),
      1,
    );
    // The writer assigns the seq and hands it back, exactly as `record` does.
    d.markPending('tu_1', 7);

    const next = d.derive(
      exchange({
        canonicalRequest: {
          model: 'claude-opus-5',
          messages: [
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
            },
          ],
        },
      }),
      2,
    );

    const result = next.find((e) => e.type === 'tool.result');
    expect(result).toBeDefined();
    expect(d.seqOf('tu_1'), 'the call seq must still be resolvable after derive returns').toBe(7);
  });

  it('emits tool.result before the request that carried it, since the work came first', () => {
    const d = new ExchangeEventDeriver();
    d.derive(
      exchange({
        canonicalResponse: {
          id: 'm',
          model: 'm',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      1,
    );
    const next = d.derive(
      exchange({
        canonicalRequest: {
          model: 'm',
          messages: [
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
            },
          ],
        },
      }),
      2,
    );
    expect(next.map((e) => e.type)).toEqual(['tool.result', 'model.request', 'model.response']);
  });

  it('does not re-emit results for calls already closed on an earlier turn', () => {
    const d = new ExchangeEventDeriver();
    d.derive(
      exchange({
        canonicalResponse: {
          id: 'm',
          model: 'm',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      1,
    );
    const withResult = {
      model: 'm',
      messages: [
        {
          role: 'user' as const,
          content: [{ type: 'tool_result' as const, tool_use_id: 'tu_1', content: 'ok' }],
        },
      ],
    };
    d.derive(exchange({ canonicalRequest: withResult }), 2);
    const third = d.derive(exchange({ canonicalRequest: withResult }), 3);
    expect(third.filter((e) => e.type === 'tool.result')).toHaveLength(0);
  });

  it('reports a tool call whose result never arrived rather than dropping it', () => {
    const d = new ExchangeEventDeriver();
    d.derive(
      exchange({
        canonicalResponse: {
          id: 'm',
          model: 'm',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_orphan', name: 'bash', input: {} }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      1,
    );
    expect(d.unresolved().map((p) => p.id)).toEqual(['tu_orphan']);
  });

  it('survives an exchange whose response could not be canonicalized', () => {
    const events = new ExchangeEventDeriver().derive(
      exchange({ canonicalResponse: undefined, rawResponse: 'not json' }),
      1,
    );
    expect(events.map((e) => e.type)).toEqual(['model.request', 'model.response']);
    expect(events[1]!.attrs.stop_reason).toBe('unknown');
  });
});

/**
 * A `tool_use` block is physically inside the response that emitted it, and a `tool_result` block
 * is physically inside the request that carried it back. Neither is an inference, so both belong
 * in `causes` — but the deriver has no seqs, which only exist once the writer has appended. It
 * names positions in its own batch instead, and the recorder resolves them.
 */
describe('ExchangeEventDeriver causal references', () => {
  const withToolUse = exchange({
    canonicalResponse: {
      id: 'msg_0',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'npm test' } }],
      usage: { input_tokens: 10, output_tokens: 3 },
    },
  });

  it('points a tool.call at the model.response that emitted it', () => {
    const events = new ExchangeEventDeriver().derive(withToolUse, 1);
    const responseAt = events.findIndex((e) => e.type === 'model.response');
    const call = events.find((e) => e.type === 'tool.call');
    expect(call?.causesIndex).toEqual([responseAt]);
  });

  it('points a model.request at the tool.result it carried back', () => {
    const d = new ExchangeEventDeriver();
    d.derive(withToolUse, 1);
    const next = d.derive(
      exchange({
        canonicalRequest: {
          model: 'claude-opus-5',
          messages: [
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
            },
          ],
        },
      }),
      2,
    );
    const resultAt = next.findIndex((e) => e.type === 'tool.result');
    const request = next.find((e) => e.type === 'model.request');
    expect(resultAt).toBeGreaterThanOrEqual(0);
    expect(request?.causesIndex).toEqual([resultAt]);
  });

  it('leaves the reference off a request that carried no result, rather than naming nothing', () => {
    const events = new ExchangeEventDeriver().derive(exchange(), 1);
    expect(events.find((e) => e.type === 'model.request')?.causesIndex).toBeUndefined();
  });

  it('names every result when one request carries several', () => {
    const d = new ExchangeEventDeriver();
    d.derive(
      exchange({
        canonicalResponse: {
          id: 'msg_0',
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} },
            { type: 'tool_use', id: 'tu_2', name: 'edit', input: {} },
          ],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      }),
      1,
    );
    const next = d.derive(
      exchange({
        canonicalRequest: {
          model: 'claude-opus-5',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'tu_1', content: 'a' },
                { type: 'tool_result', tool_use_id: 'tu_2', content: 'b' },
              ],
            },
          ],
        },
      }),
      2,
    );
    expect(next.find((e) => e.type === 'model.request')?.causesIndex).toEqual([0, 1]);
  });

  it('points both tool.calls of one response at that same response', () => {
    const events = new ExchangeEventDeriver().derive(
      exchange({
        canonicalResponse: {
          id: 'msg_0',
          model: 'claude-opus-5',
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} },
            { type: 'tool_use', id: 'tu_2', name: 'edit', input: {} },
          ],
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      }),
      1,
    );
    const responseAt = events.findIndex((e) => e.type === 'model.response');
    const calls = events.filter((e) => e.type === 'tool.call');
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.causesIndex).toEqual([responseAt]);
  });
});
