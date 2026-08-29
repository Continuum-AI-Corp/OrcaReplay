import { describe, expect, it } from 'vitest';
import {
  anthropicToCanonicalRequest,
  anthropicToCanonicalResponse,
  canonicalToAnthropicRequest,
  parseAnthropicSse,
} from '../src/index.js';
import type { CanonicalRequest } from '@orcareplay/plugin-api';

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
