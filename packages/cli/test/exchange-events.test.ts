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
