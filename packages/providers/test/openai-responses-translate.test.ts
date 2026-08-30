import { describe, expect, it } from 'vitest';
import {
  canonicalToResponsesRequest,
  canonicalToResponsesResponse,
  canonicalToResponsesSse,
  parseResponsesSse,
  responsesToCanonicalRequest,
  responsesToCanonicalResponse,
} from '../src/translate/openai-responses.js';
import type { CanonicalRequest, CanonicalResponse } from '@orcareplay/plugin-api';

/**
 * The Responses API is what the OpenAI Agents SDK and the Codex CLI speak by default, so these
 * tests are the difference between "orca supports OpenAI" and "orca kills your agent on turn one".
 *
 * The shape differs from chat completions in every load-bearing way: the system prompt is
 * `instructions` rather than a message, tool calls and their results are top-level `input` items
 * rather than message fields, tool definitions are flat rather than nested under `function`, and
 * the stream is a sequence of typed events rather than choice deltas.
 */

const REQUEST = {
  model: 'gpt-5.2',
  instructions: 'You are a careful engineer.',
  input: [
    { role: 'user', content: [{ type: 'input_text', text: 'fix the auth test' }] },
    {
      type: 'function_call',
      call_id: 'call_a1',
      name: 'edit_file',
      arguments: '{"path":"auth.ts"}',
    },
    { type: 'function_call_output', call_id: 'call_a1', output: 'ok' },
  ],
  tools: [
    {
      type: 'function',
      name: 'edit_file',
      description: 'edit a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
  max_output_tokens: 1024,
  temperature: 0.2,
  stream: true,
};

const RESPONSE = {
  id: 'resp_01',
  object: 'response',
  status: 'completed',
  model: 'gpt-5.2',
  output: [
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'checking auth.ts' }],
    },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'editing auth.ts now', annotations: [] }],
    },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_b2',
      name: 'edit_file',
      arguments: '{"path":"auth.ts"}',
    },
  ],
  usage: {
    input_tokens: 120,
    output_tokens: 40,
    total_tokens: 160,
    input_tokens_details: { cached_tokens: 20 },
  },
};

describe('responses request -> canonical', () => {
  it('reads instructions as the system prompt', () => {
    expect(responsesToCanonicalRequest(REQUEST).system).toBe('You are a careful engineer.');
  });

  it('reads model, sampling fields and max_output_tokens', () => {
    const req = responsesToCanonicalRequest(REQUEST);
    expect(req.model).toBe('gpt-5.2');
    expect(req.max_tokens).toBe(1024);
    expect(req.temperature).toBe(0.2);
    expect(req.stream).toBe(true);
  });

  it('turns input_text parts into a user message', () => {
    const req = responsesToCanonicalRequest(REQUEST);
    expect(req.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'fix the auth test' }],
    });
  });

  it('lifts a top-level function_call item into an assistant tool_use block', () => {
    const req = responsesToCanonicalRequest(REQUEST);
    const assistant = req.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_a1',
      name: 'edit_file',
      input: { path: 'auth.ts' },
    });
  });

  it('lifts function_call_output into a tool_result keyed by call_id', () => {
    const req = responsesToCanonicalRequest(REQUEST);
    const last = req.messages[req.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_a1',
      content: 'ok',
    });
  });

  it('reads the flat tool shape, which is not nested under `function` here', () => {
    const req = responsesToCanonicalRequest(REQUEST);
    expect(req.tools?.[0]?.name).toBe('edit_file');
    expect(req.tools?.[0]?.input_schema).toMatchObject({ type: 'object' });
  });

  it('accepts `input` given as a bare string, which the SDK allows', () => {
    const req = responsesToCanonicalRequest({ model: 'gpt-5.2', input: 'hello' });
    expect(req.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  });

  it('never throws on a body it has never seen', () => {
    expect(() => responsesToCanonicalRequest({ nonsense: true })).not.toThrow();
    expect(() => responsesToCanonicalRequest(null)).not.toThrow();
    expect(() => responsesToCanonicalRequest('not an object')).not.toThrow();
  });
});

describe('canonical request -> responses', () => {
  it('round trips the request through canonical without losing a field', () => {
    const back = canonicalToResponsesRequest(responsesToCanonicalRequest(REQUEST));
    expect(back['model']).toBe('gpt-5.2');
    expect(back['instructions']).toBe('You are a careful engineer.');
    expect(back['max_output_tokens']).toBe(1024);
    expect(back['temperature']).toBe(0.2);
    expect(back['stream']).toBe(true);
  });

  it('restores function_call and function_call_output as top-level input items', () => {
    const back = canonicalToResponsesRequest(responsesToCanonicalRequest(REQUEST));
    const input = back['input'] as Array<Record<string, unknown>>;
    expect(input.some((i) => i['type'] === 'function_call' && i['call_id'] === 'call_a1')).toBe(
      true,
    );
    expect(input.some((i) => i['type'] === 'function_call_output' && i['output'] === 'ok')).toBe(
      true,
    );
  });

  it('emits tools in the flat shape the Responses API requires', () => {
    const back = canonicalToResponsesRequest(responsesToCanonicalRequest(REQUEST));
    const tools = back['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: 'function', name: 'edit_file' });
    // Nesting under `function` is the chat-completions shape and is rejected here.
    expect(tools[0]!['function']).toBeUndefined();
  });

  it('builds a request from a canonical form that never came from this dialect', () => {
    // The cross-provider fork path: a Claude-recorded turn handed to a Responses agent.
    const canonical: CanonicalRequest = {
      model: 'gpt-5.2',
      system: 'be brief',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const wire = canonicalToResponsesRequest(canonical);
    expect(wire['instructions']).toBe('be brief');
    expect(wire['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });
});

describe('responses response -> canonical', () => {
  it('reads text, thinking and tool calls out of the output array', () => {
    const res = responsesToCanonicalResponse(RESPONSE);
    expect(res.content).toEqual([
      { type: 'thinking', text: 'checking auth.ts' },
      { type: 'text', text: 'editing auth.ts now' },
      { type: 'tool_use', id: 'call_b2', name: 'edit_file', input: { path: 'auth.ts' } },
    ]);
  });

  it('keys tool_use by call_id, which is what a later function_call_output references', () => {
    // The item `id` (fc_1) and the `call_id` (call_b2) are different strings, and only the
    // latter round trips through the tool result. Getting this backwards breaks every fork.
    expect(responsesToCanonicalResponse(RESPONSE).content[2]).toMatchObject({ id: 'call_b2' });
  });

  it('reports tool_use as the stop reason when the output contains a function call', () => {
    expect(responsesToCanonicalResponse(RESPONSE).stop_reason).toBe('tool_use');
  });

  it('reports end_turn for a completed response with no tool call', () => {
    const plain = { ...RESPONSE, output: [RESPONSE.output[1]] };
    expect(responsesToCanonicalResponse(plain).stop_reason).toBe('end_turn');
  });

  it('reports max_tokens when the response stopped on the output cap', () => {
    const capped = {
      ...RESPONSE,
      output: [RESPONSE.output[1]],
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    };
    expect(responsesToCanonicalResponse(capped).stop_reason).toBe('max_tokens');
  });

  it('reports error, with the provider message kept, for a failed response', () => {
    const failed = {
      id: 'resp_02',
      status: 'failed',
      model: 'gpt-5.2',
      error: { code: 'server_error', message: 'upstream exploded' },
    };
    const res = responsesToCanonicalResponse(failed);
    expect(res.stop_reason).toBe('error');
    expect(res.content).toEqual([{ type: 'text', text: 'upstream exploded' }]);
  });

  it('subtracts cached tokens from the input count, as the other dialects do', () => {
    // Canonical follows Anthropic: cache tiers are counted separately so cost math cannot
    // double count them. The Responses API counts cached tokens inside input_tokens.
    expect(responsesToCanonicalResponse(RESPONSE).usage).toEqual({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 20,
    });
  });

  it('never throws on a body it has never seen', () => {
    expect(() => responsesToCanonicalResponse({ wat: 1 })).not.toThrow();
    expect(() => responsesToCanonicalResponse(null)).not.toThrow();
  });
});

describe('canonical response -> responses', () => {
  it('round trips a response through canonical', () => {
    const canonical = responsesToCanonicalResponse(RESPONSE);
    const again = responsesToCanonicalResponse(canonicalToResponsesResponse(canonical));
    expect(again.content).toEqual(canonical.content);
    expect(again.stop_reason).toBe(canonical.stop_reason);
    expect(again.usage).toEqual(canonical.usage);
  });

  it('adds cached tokens back into input_tokens, the way the wire counts them', () => {
    const wire = canonicalToResponsesResponse(responsesToCanonicalResponse(RESPONSE));
    expect(wire['usage']).toMatchObject({
      input_tokens: 120,
      output_tokens: 40,
      input_tokens_details: { cached_tokens: 20 },
    });
  });

  it('serialises an error response as an error envelope, not a finish reason', () => {
    const res: CanonicalResponse = {
      id: 'resp_03',
      model: 'gpt-5.2',
      stop_reason: 'error',
      content: [{ type: 'text', text: 'rate limited' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    const wire = canonicalToResponsesResponse(res);
    expect(wire['status']).toBe('failed');
    expect(wire['error']).toMatchObject({ message: 'rate limited' });
  });

  it('is deterministic — the same response serialises to the same bytes every time', () => {
    // A clock read here would make one recorded response replay as different bytes, which is
    // the one thing a replay tool cannot afford.
    const canonical = responsesToCanonicalResponse(RESPONSE);
    expect(JSON.stringify(canonicalToResponsesResponse(canonical))).toBe(
      JSON.stringify(canonicalToResponsesResponse(canonical)),
    );
  });
});

describe('responses SSE', () => {
  const STREAM = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_01","model":"gpt-5.2","status":"in_progress"}}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"editing "}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"auth.ts now"}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_b2","name":"edit_file","arguments":""}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"{\\"path\\":"}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"\\"auth.ts\\"}"}\n\n',
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: RESPONSE })}\n\n`,
  ];

  it('prefers the terminal response.completed event, which carries the whole response', () => {
    const res = parseResponsesSse(STREAM);
    expect(res.id).toBe('resp_01');
    expect(res.stop_reason).toBe('tool_use');
    expect(res.usage.input_tokens).toBe(100);
  });

  it('survives frame boundaries falling mid-line', () => {
    const whole = STREAM.join('');
    const cut = [whole.slice(0, 137), whole.slice(137)];
    expect(parseResponsesSse(cut)).toEqual(parseResponsesSse(whole));
  });

  it('falls back to the accumulated deltas when the stream was cut short', () => {
    // A debugger has to reconstruct the turn that died, which is the only turn that matters.
    const truncated = STREAM.slice(0, -1);
    const res = parseResponsesSse(truncated);
    expect(res.content).toEqual([
      { type: 'text', text: 'editing auth.ts now' },
      { type: 'tool_use', id: 'call_b2', name: 'edit_file', input: { path: 'auth.ts' } },
    ]);
    expect(res.stop_reason).toBe('tool_use');
  });

  it('keeps tool arguments that never became valid JSON rather than discarding them', () => {
    const partial = STREAM.slice(0, 6);
    const res = parseResponsesSse(partial);
    expect(res.content.at(-1)).toMatchObject({
      type: 'tool_use',
      input: { _raw: '{"path":' },
    });
  });

  it('reads reasoning summary deltas as thinking', () => {
    const stream = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"delta":"weighing options"}\n\n',
    ];
    expect(parseResponsesSse(stream).content).toEqual([
      { type: 'thinking', text: 'weighing options' },
    ]);
  });

  it('reads a terminal response.failed as an error', () => {
    const stream = [
      `event: response.failed\ndata: ${JSON.stringify({
        type: 'response.failed',
        response: { id: 'resp_09', status: 'failed', model: 'gpt-5.2', error: { message: 'boom' } },
      })}\n\n`,
    ];
    const res = parseResponsesSse(stream);
    expect(res.stop_reason).toBe('error');
    expect(res.content).toEqual([{ type: 'text', text: 'boom' }]);
  });

  it('never throws on garbage frames', () => {
    expect(() => parseResponsesSse(['event: x\ndata: not json\n\n', 'garbage'])).not.toThrow();
  });

  it('round trips: canonical -> SSE -> canonical', () => {
    const canonical = responsesToCanonicalResponse(RESPONSE);
    const again = parseResponsesSse(canonicalToResponsesSse(canonical));
    expect(again.content).toEqual(canonical.content);
    expect(again.stop_reason).toBe(canonical.stop_reason);
    expect(again.usage).toEqual(canonical.usage);
  });

  it('emits a stream an agent can read: typed events ending in response.completed', () => {
    const sse = canonicalToResponsesSse(responsesToCanonicalResponse(RESPONSE));
    expect(sse).toContain('event: response.created');
    expect(sse).toContain('event: response.output_text.delta');
    expect(sse).toContain('event: response.function_call_arguments.delta');
    expect(sse.trimEnd().endsWith('}')).toBe(true);
    expect(sse).toContain('event: response.completed');
  });
});
