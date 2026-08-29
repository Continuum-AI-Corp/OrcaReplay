import { describe, expect, it } from 'vitest';
import {
  anthropicToCanonicalRequest,
  anthropicToCanonicalResponse,
  canonicalToAnthropicRequest,
  canonicalToAnthropicResponse,
  canonicalToAnthropicSse,
  parseAnthropicSse,
} from '../src/index.js';
import type { CanonicalRequest, CanonicalResponse } from '@orcareplay/plugin-api';

/** A request shaped like what Claude Code actually puts on the wire. */
function toolRequest(): Record<string, unknown> {
  return {
    model: 'claude-opus-5-20260101',
    max_tokens: 4096,
    temperature: 0.2,
    top_p: 0.95,
    stop_sequences: ['</done>'],
    stream: true,
    system: 'You are a terse debugging assistant.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Why is the build red?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me run the tests.' },
          { type: 'tool_use', id: 'toolu_01A', name: 'bash', input: { cmd: 'npm test' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01A',
            content: 'FAIL src/a.test.ts\n1 failed',
            is_error: true,
          },
        ],
      },
    ],
    tools: [
      {
        name: 'bash',
        description: 'Run a shell command',
        input_schema: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
        },
      },
    ],
  };
}

describe('anthropicToCanonicalRequest', () => {
  it('maps the scalar knobs and tools', () => {
    const req = anthropicToCanonicalRequest(toolRequest());
    expect(req.model).toBe('claude-opus-5-20260101');
    expect(req.max_tokens).toBe(4096);
    expect(req.temperature).toBe(0.2);
    expect(req.top_p).toBe(0.95);
    expect(req.stop).toEqual(['</done>']);
    expect(req.stream).toBe(true);
    expect(req.system).toBe('You are a terse debugging assistant.');
    expect(req.tools).toEqual([
      {
        name: 'bash',
        description: 'Run a shell command',
        input_schema: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
        },
      },
    ]);
  });

  it('normalizes a string content into a single text block', () => {
    const req = anthropicToCanonicalRequest({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(req.messages[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('joins an array-of-blocks system prompt into one string', () => {
    const req = anthropicToCanonicalRequest({
      model: 'claude-sonnet-5',
      system: [
        { type: 'text', text: 'You are Claude Code.' },
        { type: 'text', text: 'Repo rules follow.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [],
    });
    expect(req.system).toBe('You are Claude Code.\n\nRepo rules follow.');
  });

  it('carries tool_use and tool_result blocks across, keeping is_error', () => {
    const req = anthropicToCanonicalRequest(toolRequest());
    expect(req.messages[1]?.content[1]).toEqual({
      type: 'tool_use',
      id: 'toolu_01A',
      name: 'bash',
      input: { cmd: 'npm test' },
    });
    expect(req.messages[2]?.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_01A',
      content: 'FAIL src/a.test.ts\n1 failed',
      is_error: true,
    });
  });

  it('flattens a block-array tool_result content into text', () => {
    const req = anthropicToCanonicalRequest({
      model: 'claude-sonnet-5',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_9',
              content: [
                { type: 'text', text: 'line one' },
                { type: 'text', text: 'line two' },
              ],
            },
          ],
        },
      ],
    });
    expect(req.messages[0]?.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_9',
      content: 'line one\nline two',
    });
  });

  it('maps base64 image blocks', () => {
    const req = anthropicToCanonicalRequest({
      model: 'claude-sonnet-5',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
            },
          ],
        },
      ],
    });
    expect(req.messages[0]?.content[0]).toEqual({
      type: 'image',
      media_type: 'image/png',
      data: 'iVBORw0KGgo=',
    });
  });

  it('never throws on junk, unfamiliar, or missing fields', () => {
    expect(() => anthropicToCanonicalRequest(null)).not.toThrow();
    expect(() => anthropicToCanonicalRequest('nope')).not.toThrow();
    expect(() => anthropicToCanonicalRequest({ messages: 'not an array' })).not.toThrow();
    const req = anthropicToCanonicalRequest({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: [{ type: 'quantum_block', wat: 1 }] }],
      future_field: { deeply: ['nested'] },
    });
    expect(req.messages).toHaveLength(1);
    expect(req.model).toBe('claude-sonnet-5');
  });
});

describe('anthropic request round trip', () => {
  it('preserves model, system, messages, tools and max_tokens', () => {
    const original = toolRequest();
    const back = canonicalToAnthropicRequest(anthropicToCanonicalRequest(original));
    expect(back).toEqual(original);
  });

  it('preserves unfamiliar top-level fields through canonical', () => {
    const original = {
      ...toolRequest(),
      top_k: 40,
      tool_choice: { type: 'auto' },
      metadata: { user_id: 'u_42' },
      thinking: { type: 'enabled', budget_tokens: 2048 },
    };
    const back = canonicalToAnthropicRequest(anthropicToCanonicalRequest(original));
    expect(back).toEqual(original);
  });

  it('preserves a block-form system prompt including cache_control', () => {
    const original = {
      model: 'claude-opus-5',
      max_tokens: 1024,
      system: [
        { type: 'text', text: 'You are Claude Code.' },
        { type: 'text', text: 'Repo rules follow.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const back = canonicalToAnthropicRequest(anthropicToCanonicalRequest(original));
    expect(back).toEqual(original);
  });

  it('lets an edited canonical system beat the preserved block form', () => {
    const canonical = anthropicToCanonicalRequest({
      model: 'claude-opus-5',
      system: [{ type: 'text', text: 'original' }],
      messages: [],
    });
    const forked: CanonicalRequest = { ...canonical, system: 'edited by a fork' };
    expect(canonicalToAnthropicRequest(forked).system).toBe('edited by a fork');
  });

  it('emits no key at all for absent optionals', () => {
    const back = canonicalToAnthropicRequest({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(Object.keys(back).sort()).toEqual(['messages', 'model']);
  });
});

describe('anthropicToCanonicalResponse', () => {
  it('maps content, stop reason and the four usage counters', () => {
    const res = anthropicToCanonicalResponse({
      id: 'msg_01XYZ',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-20260101',
      content: [
        { type: 'text', text: 'Running it.' },
        { type: 'tool_use', id: 'toolu_02B', name: 'bash', input: { cmd: 'npm test' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 1200,
        output_tokens: 85,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 300,
      },
    });
    expect(res.id).toBe('msg_01XYZ');
    expect(res.model).toBe('claude-opus-5-20260101');
    expect(res.stop_reason).toBe('tool_use');
    expect(res.content).toEqual([
      { type: 'text', text: 'Running it.' },
      { type: 'tool_use', id: 'toolu_02B', name: 'bash', input: { cmd: 'npm test' } },
    ]);
    expect(res.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 85,
      cache_read_tokens: 8000,
      cache_write_tokens: 300,
    });
  });

  it('maps every stop_reason the API can send', () => {
    const at = (stop: unknown): string =>
      anthropicToCanonicalResponse({ id: 'm', model: 'x', content: [], stop_reason: stop })
        .stop_reason;
    expect(at('end_turn')).toBe('end_turn');
    expect(at('tool_use')).toBe('tool_use');
    expect(at('max_tokens')).toBe('max_tokens');
    expect(at('stop_sequence')).toBe('stop_sequence');
    expect(at(null)).toBe('end_turn');
    expect(at('refusal')).toBe('end_turn');
  });

  it('turns an API error envelope into an error response', () => {
    const res = anthropicToCanonicalResponse({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    });
    expect(res.stop_reason).toBe('error');
    expect(res.content).toEqual([{ type: 'text', text: 'Overloaded' }]);
    expect(res.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('never throws on junk', () => {
    expect(() => anthropicToCanonicalResponse(undefined)).not.toThrow();
    expect(anthropicToCanonicalResponse({}).usage.input_tokens).toBe(0);
  });
});

/** A realistic recorded stream: text, then a tool_use whose JSON arrives in fragments. */
const SSE_TOOL_STREAM = [
  'event: message_start\n',
  'data: {"type":"message_start","message":{"id":"msg_01STREAM","type":"message","role":"assistant","model":"claude-opus-5-20260101","content":[],"stop_reason":null,"usage":{"input_tokens":1200,"output_tokens":1,"cache_read_input_tokens":8000}}}\n',
  '\n',
  'event: content_block_start\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
  '\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me "}}\n',
  '\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"run it."}}\n',
  '\n',
  'event: content_block_stop\n',
  'data: {"type":"content_block_stop","index":0}\n',
  '\n',
  'event: ping\n',
  'data: {"type":"ping"}\n',
  '\n',
  'event: content_block_start\n',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01C","name":"bash","input":{}}}\n',
  '\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}\n',
  '\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \\"npm te"}}\n',
  '\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"st\\", \\"timeout\\": 60}"}}\n',
  '\n',
  'event: content_block_stop\n',
  'data: {"type":"content_block_stop","index":1}\n',
  '\n',
  'event: message_delta\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":85}}\n',
  '\n',
  'event: message_stop\n',
  'data: {"type":"message_stop"}\n',
  '\n',
].join('');

/** Re-slice a stream at arbitrary offsets, the way a socket would. */
function reslice(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe('parseAnthropicSse', () => {
  it('assembles text, tool input, usage and stop reason', () => {
    const res = parseAnthropicSse(SSE_TOOL_STREAM);
    expect(res.id).toBe('msg_01STREAM');
    expect(res.model).toBe('claude-opus-5-20260101');
    expect(res.stop_reason).toBe('tool_use');
    expect(res.content).toEqual([
      { type: 'text', text: 'Let me run it.' },
      {
        type: 'tool_use',
        id: 'toolu_01C',
        name: 'bash',
        input: { cmd: 'npm test', timeout: 60 },
      },
    ]);
    expect(res.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 85,
      cache_read_tokens: 8000,
    });
  });

  it('gives the same answer however the bytes are chunked', () => {
    const whole = parseAnthropicSse(SSE_TOOL_STREAM);
    for (const size of [1, 7, 64, 999]) {
      expect(parseAnthropicSse(reslice(SSE_TOOL_STREAM, size))).toEqual(whole);
    }
  });

  it('tolerates CRLF line endings', () => {
    expect(parseAnthropicSse(SSE_TOOL_STREAM.replace(/\n/g, '\r\n'))).toEqual(
      parseAnthropicSse(SSE_TOOL_STREAM),
    );
  });

  it('keeps a tool_use with no input deltas as an empty object', () => {
    const res = parseAnthropicSse(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-sonnet-5","content":[],"usage":{"input_tokens":3,"output_tokens":1}}}\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_z","name":"now","input":{}}}\n\n' +
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    expect(res.content).toEqual([{ type: 'tool_use', id: 'toolu_z', name: 'now', input: {} }]);
  });

  it('degrades malformed tool json to a raw string instead of throwing', () => {
    const res = parseAnthropicSse(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_bad","name":"bash","input":{}}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\": \\"npm te"}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    expect(res.content[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_bad',
      name: 'bash',
      input: { _raw: '{"cmd": "npm te' },
    });
  });

  it('assembles thinking blocks', () => {
    const res = parseAnthropicSse(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 1"}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n' +
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    );
    expect(res.content).toEqual([{ type: 'thinking', text: 'step 1' }]);
  });

  it('reports a mid-stream error event as an error stop reason', () => {
    const res = parseAnthropicSse(
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    );
    expect(res.stop_reason).toBe('error');
  });

  it('ignores empty input and unknown events rather than throwing', () => {
    expect(() => parseAnthropicSse('')).not.toThrow();
    expect(() => parseAnthropicSse(['event: unknown_future\ndata: {"a":1}\n\n'])).not.toThrow();
    expect(() => parseAnthropicSse('data: {not json}\n\n')).not.toThrow();
  });
});

/** An assistant turn carrying everything a response can hold: thinking, text and a tool call. */
function toolResponse(): CanonicalResponse {
  return {
    id: 'msg_01ROUND',
    model: 'claude-opus-5-20260101',
    stop_reason: 'tool_use',
    content: [
      { type: 'thinking', text: 'The build is red, so run the tests.' },
      { type: 'text', text: 'Running it.' },
      { type: 'tool_use', id: 'toolu_02B', name: 'bash', input: { cmd: 'npm test', timeout: 60 } },
    ],
    usage: {
      input_tokens: 1200,
      output_tokens: 85,
      cache_read_tokens: 8000,
      cache_write_tokens: 300,
    },
  };
}

/**
 * Serialize both ways, then read each form back with the parser that defines what the canonical
 * shape means. A serializer is correct exactly when this returns the response it was handed.
 */
function anthropicRoundTrip(res: CanonicalResponse): CanonicalResponse[] {
  return [
    anthropicToCanonicalResponse(canonicalToAnthropicResponse(res)),
    parseAnthropicSse(canonicalToAnthropicSse(res)),
  ];
}

/** The `event:` names of an SSE body, in order. */
function eventNames(sse: string): string[] {
  return [...sse.matchAll(/^event: (.+)$/gm)].map((m) => m[1] ?? '');
}

describe('canonicalToAnthropicResponse', () => {
  it('emits the Messages API body shape', () => {
    const body = canonicalToAnthropicResponse(toolResponse());
    expect(body['type']).toBe('message');
    expect(body['role']).toBe('assistant');
    expect(body['id']).toBe('msg_01ROUND');
    expect(body['model']).toBe('claude-opus-5-20260101');
    expect(body['stop_reason']).toBe('tool_use');
    // Canonical has no room for the matched stop sequence, so the field is always present-but-null.
    expect(body['stop_sequence']).toBeNull();
    expect(body['content']).toEqual([
      { type: 'thinking', thinking: 'The build is red, so run the tests.' },
      { type: 'text', text: 'Running it.' },
      {
        type: 'tool_use',
        id: 'toolu_02B',
        name: 'bash',
        input: { cmd: 'npm test', timeout: 60 },
      },
    ]);
    expect(body['usage']).toEqual({
      input_tokens: 1200,
      output_tokens: 85,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 300,
    });
  });

  it('omits cache counters the canonical response never had', () => {
    const body = canonicalToAnthropicResponse({
      id: 'msg_1',
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [],
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    expect(body['usage']).toEqual({ input_tokens: 3, output_tokens: 1 });
  });

  it('emits an error envelope for an error stop reason', () => {
    const body = canonicalToAnthropicResponse({
      id: 'msg_err',
      model: 'claude-opus-5',
      stop_reason: 'error',
      content: [{ type: 'text', text: 'Overloaded' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    // `error` is not a Messages API stop_reason; the API says so with a different envelope.
    expect(body['type']).toBe('error');
    expect(body['error']).toEqual({ type: 'error', message: 'Overloaded' });
  });
});

describe('canonicalToAnthropicSse', () => {
  it('frames the event sequence the Messages API streams', () => {
    expect(eventNames(canonicalToAnthropicSse(toolResponse()))).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('gives every frame a data payload whose type matches its event name', () => {
    const frames = canonicalToAnthropicSse(toolResponse())
      .split('\n\n')
      .filter((f) => f !== '');
    expect(frames).toHaveLength(12);
    for (const frame of frames) {
      const [eventLine, dataLine, ...rest] = frame.split('\n');
      expect(rest).toEqual([]);
      const data: unknown = JSON.parse((dataLine ?? '').replace(/^data: /, ''));
      expect((data as Record<string, unknown>)['type']).toBe(
        (eventLine ?? '').slice('event: '.length),
      );
    }
  });

  it('indexes content blocks in order', () => {
    const sse = canonicalToAnthropicSse(toolResponse());
    expect([...sse.matchAll(/"index":(\d+)/g)].map((m) => Number(m[1]))).toEqual([
      0, 0, 0, 1, 1, 1, 2, 2, 2,
    ]);
  });

  it('decodes the same however the bytes are re-chunked', () => {
    const sse = canonicalToAnthropicSse(toolResponse());
    for (const size of [1, 7, 64, 999]) {
      expect(parseAnthropicSse(reslice(sse, size))).toEqual(toolResponse());
    }
  });

  it('streams an error as an error event', () => {
    const sse = canonicalToAnthropicSse({
      id: 'msg_err',
      model: 'claude-opus-5',
      stop_reason: 'error',
      content: [{ type: 'text', text: 'Overloaded' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(eventNames(sse)).toEqual(['message_start', 'error']);
  });
});

describe('anthropic response round trip', () => {
  it('preserves thinking, text, a tool call, usage and stop reason', () => {
    const res = toolResponse();
    expect(anthropicRoundTrip(res)).toEqual([res, res]);
  });

  it('preserves plain text with no tools', () => {
    const res: CanonicalResponse = {
      id: 'msg_text',
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'The build is red because a test fails.' }],
      usage: { input_tokens: 42, output_tokens: 9 },
    };
    expect(anthropicRoundTrip(res)).toEqual([res, res]);
  });

  it('preserves several content blocks of the same kind', () => {
    const res: CanonicalResponse = {
      id: 'msg_many',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
        { type: 'tool_use', id: 'toolu_a', name: 'read', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'toolu_b', name: 'read', input: { path: 'b.ts' } },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    expect(anthropicRoundTrip(res)).toEqual([res, res]);
  });

  it('preserves an empty content list', () => {
    const res: CanonicalResponse = {
      id: 'msg_empty',
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      content: [],
      usage: { input_tokens: 7, output_tokens: 0 },
    };
    expect(anthropicRoundTrip(res)).toEqual([res, res]);
  });

  it('preserves every stop reason', () => {
    for (const stop of ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'] as const) {
      const res: CanonicalResponse = {
        id: 'msg_stop',
        model: 'claude-opus-5',
        stop_reason: stop,
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 1, output_tokens: 2 },
      };
      expect(anthropicRoundTrip(res)).toEqual([res, res]);
    }
  });

  it('preserves an error response', () => {
    const res: CanonicalResponse = {
      id: 'msg_err',
      model: 'claude-opus-5',
      stop_reason: 'error',
      content: [{ type: 'text', text: 'Overloaded' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    expect(anthropicRoundTrip(res)).toEqual([res, res]);
  });

  it('drops usage from a failed call in the JSON body but not in the stream', () => {
    const res: CanonicalResponse = {
      id: 'msg_err',
      model: 'claude-opus-5',
      stop_reason: 'error',
      content: [{ type: 'text', text: 'Overloaded' }],
      usage: { input_tokens: 1200, output_tokens: 2 },
    };
    const [json, sse] = anthropicRoundTrip(res);
    // Documented loss: the Messages API error envelope has no usage block at all, so a failed
    // call reads back as zero-cost. A failed *stream* already sent message_start, so its usage
    // survives — which is also why an error response parsed from the wire always has zeros here.
    expect(json?.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(json?.content).toEqual(res.content);
    expect(sse).toEqual(res);
  });

  it('preserves an empty tool input and a tool input that never parsed', () => {
    const res: CanonicalResponse = {
      id: 'msg_tools',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'toolu_now', name: 'now', input: {} },
        { type: 'tool_use', id: 'toolu_bad', name: 'bash', input: { _raw: '{"cmd": "np' } },
      ],
      usage: { input_tokens: 5, output_tokens: 6 },
    };
    expect(anthropicRoundTrip(res)).toEqual([res, res]);
  });

  it('keeps an image block in the JSON body but not in the stream', () => {
    const res: CanonicalResponse = {
      id: 'msg_img',
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      content: [{ type: 'image', media_type: 'image/png', data: 'iVBORw0KGgo=' }],
      usage: { input_tokens: 4, output_tokens: 0 },
    };
    const [json, sse] = anthropicRoundTrip(res);
    expect(json).toEqual(res);
    // Documented loss: a Messages *stream* only ever carries text, thinking and tool_use blocks,
    // so the stream assembler has nowhere to put an image. Assistant turns never contain one.
    expect(sse?.content).toEqual([]);
  });
});
