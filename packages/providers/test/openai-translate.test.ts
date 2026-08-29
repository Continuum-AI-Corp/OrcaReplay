import { describe, expect, it } from 'vitest';
import {
  anthropicToCanonicalRequest,
  anthropicToCanonicalResponse,
  canonicalToAnthropicResponse,
  canonicalToAnthropicSse,
  canonicalToOpenaiRequest,
  canonicalToOpenaiResponse,
  canonicalToOpenaiSse,
  openaiToCanonicalRequest,
  openaiToCanonicalResponse,
  parseAnthropicSse,
  parseOpenaiSse,
} from '../src/index.js';
import type { CanonicalResponse } from '@orcareplay/plugin-api';

/** An OpenAI-shaped body mid tool loop, the way a gateway would forward it. */
function toolRequest(): Record<string, unknown> {
  return {
    model: 'gpt-5.2',
    max_completion_tokens: 4096,
    temperature: 0.2,
    top_p: 0.95,
    stop: ['</done>'],
    stream: true,
    messages: [
      { role: 'system', content: 'You are a terse debugging assistant.' },
      { role: 'user', content: 'Why is the build red?' },
      {
        role: 'assistant',
        content: 'Let me run the tests.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'bash', arguments: '{"cmd":"npm test"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'FAIL src/a.test.ts\n1 failed' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd'],
          },
        },
      },
    ],
  };
}

describe('openaiToCanonicalRequest', () => {
  it('lifts system messages out of the message list', () => {
    const req = openaiToCanonicalRequest(toolRequest());
    expect(req.system).toBe('You are a terse debugging assistant.');
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('joins several system and developer messages', () => {
    const req = openaiToCanonicalRequest({
      model: 'gpt-5.2',
      messages: [
        { role: 'system', content: 'rule one' },
        { role: 'developer', content: 'rule two' },
        { role: 'user', content: 'go' },
      ],
    });
    expect(req.system).toBe('rule one\n\nrule two');
  });

  it('parses tool_call arguments from a JSON string into an object', () => {
    const req = openaiToCanonicalRequest(toolRequest());
    expect(req.messages[1]?.content).toEqual([
      { type: 'text', text: 'Let me run the tests.' },
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { cmd: 'npm test' } },
    ]);
  });

  it('turns a tool message into a tool_result inside a user message', () => {
    const req = openaiToCanonicalRequest(toolRequest());
    expect(req.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'FAIL src/a.test.ts\n1 failed' },
      ],
    });
  });

  it('merges consecutive tool messages into one user turn', () => {
    const req = openaiToCanonicalRequest({
      model: 'gpt-5.2',
      messages: [
        { role: 'tool', tool_call_id: 'call_1', content: 'a' },
        { role: 'tool', tool_call_id: 'call_2', content: 'b' },
        { role: 'user', content: 'and?' },
      ],
    });
    expect(req.messages).toHaveLength(2);
    expect(req.messages[0]?.content).toHaveLength(2);
  });

  it('maps tools and max_completion_tokens', () => {
    const req = openaiToCanonicalRequest(toolRequest());
    expect(req.max_tokens).toBe(4096);
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

  it('reads the legacy max_tokens field too', () => {
    expect(openaiToCanonicalRequest({ model: 'x', messages: [], max_tokens: 32 }).max_tokens).toBe(
      32,
    );
  });

  it('keeps malformed tool arguments as a raw string instead of throwing', () => {
    const req = openaiToCanonicalRequest({
      model: 'gpt-5.2',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_x',
              type: 'function',
              function: { name: 'bash', arguments: '{"cmd": "np' },
            },
          ],
        },
      ],
    });
    expect(req.messages[0]?.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_x',
      name: 'bash',
      input: { _raw: '{"cmd": "np' },
    });
  });

  it('maps a data-url image part', () => {
    const req = openaiToCanonicalRequest({
      model: 'gpt-5.2',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
        },
      ],
    });
    expect(req.messages[0]?.content[1]).toEqual({
      type: 'image',
      media_type: 'image/png',
      data: 'iVBORw0KGgo=',
    });
  });

  it('never throws on junk, unfamiliar, or missing fields', () => {
    expect(() => openaiToCanonicalRequest(null)).not.toThrow();
    expect(() => openaiToCanonicalRequest([1, 2, 3])).not.toThrow();
    expect(() => openaiToCanonicalRequest({ messages: { nope: true } })).not.toThrow();
    expect(
      openaiToCanonicalRequest({
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }],
      }).messages,
    ).toHaveLength(1);
  });
});

describe('openai request round trip', () => {
  it('preserves model, system, messages, tools and max tokens', () => {
    const original = toolRequest();
    const back = canonicalToOpenaiRequest(openaiToCanonicalRequest(original));
    expect(back).toEqual(original);
  });

  it('preserves unfamiliar top-level fields', () => {
    const original = {
      ...toolRequest(),
      seed: 7,
      parallel_tool_calls: false,
      response_format: { type: 'json_object' },
      stream_options: { include_usage: true },
      user: 'u_42',
    };
    const back = canonicalToOpenaiRequest(openaiToCanonicalRequest(original));
    expect(back).toEqual(original);
  });

  it('remembers which max-tokens field the caller used', () => {
    const legacy = { model: 'gpt-5-mini', messages: [], max_tokens: 32 };
    expect(canonicalToOpenaiRequest(openaiToCanonicalRequest(legacy))).toEqual(legacy);
    const modern = { model: 'gpt-5.2', messages: [], max_completion_tokens: 32 };
    expect(canonicalToOpenaiRequest(openaiToCanonicalRequest(modern))).toEqual(modern);
  });

  it('round trips an assistant turn that is tool calls only', () => {
    const original = {
      model: 'gpt-5.2',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'now', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '2026-08-29' },
      ],
    };
    expect(canonicalToOpenaiRequest(openaiToCanonicalRequest(original))).toEqual(original);
  });

  it('round trips malformed tool arguments byte for byte', () => {
    const original = {
      model: 'gpt-5.2',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_x',
              type: 'function',
              function: { name: 'bash', arguments: '{"cmd": "np' },
            },
          ],
        },
      ],
    };
    expect(canonicalToOpenaiRequest(openaiToCanonicalRequest(original))).toEqual(original);
  });

  it('does not mistake a genuine _raw property for the malformed marker', () => {
    const original = {
      model: 'gpt-5.2',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_r',
              type: 'function',
              function: { name: 'echo', arguments: '{"_raw":"{\\"a\\":1}"}' },
            },
          ],
        },
      ],
    };
    const canonical = openaiToCanonicalRequest(original);
    expect(canonical.messages[0]?.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_r',
      name: 'echo',
      input: { _raw: '{"a":1}' },
    });
    expect(canonicalToOpenaiRequest(canonical)).toEqual(original);
  });

  it('preserves per-tool extras such as strict', () => {
    const original = {
      model: 'gpt-5.2',
      messages: [],
      tools: [
        {
          type: 'function',
          function: {
            name: 'bash',
            description: 'run',
            parameters: { type: 'object' },
            strict: true,
          },
        },
      ],
    };
    expect(canonicalToOpenaiRequest(openaiToCanonicalRequest(original))).toEqual(original);
  });

  it('emits no key at all for absent optionals', () => {
    const back = canonicalToOpenaiRequest({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(Object.keys(back).sort()).toEqual(['messages', 'model']);
  });
});

describe('cross dialect', () => {
  it('carries an Anthropic tool loop through canonical into OpenAI and back', () => {
    const anthropic = {
      model: 'claude-opus-5',
      max_tokens: 1024,
      system: 'be terse',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { cmd: 'npm test' } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'FAIL', is_error: true },
          ],
        },
      ],
      tools: [{ name: 'bash', input_schema: { type: 'object' } }],
    };
    const openai = canonicalToOpenaiRequest(anthropicToCanonicalRequest(anthropic));
    expect(openai['messages']).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'run the tests' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'bash', arguments: '{"cmd":"npm test"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'FAIL' },
    ]);
    expect(openai['tools']).toEqual([
      { type: 'function', function: { name: 'bash', parameters: { type: 'object' } } },
    ]);

    const back = openaiToCanonicalRequest(openai);
    expect(back.messages[1]?.content[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'bash',
      input: { cmd: 'npm test' },
    });
    // Documented loss: OpenAI has no per-tool-result error flag, so is_error cannot survive
    // a trip through the OpenAI dialect. It survives the Anthropic round trip.
    expect(back.messages[2]?.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'FAIL',
    });
  });
});

describe('openaiToCanonicalResponse', () => {
  it('maps content, tool calls, finish reason and usage', () => {
    const res = openaiToCanonicalResponse({
      id: 'chatcmpl-abc',
      object: 'chat.completion',
      created: 1770000000,
      model: 'gpt-5.2-2026-01-15',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Running it.',
            tool_calls: [
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'bash', arguments: '{"cmd": "npm test"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 85,
        total_tokens: 1285,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });
    expect(res.id).toBe('chatcmpl-abc');
    expect(res.model).toBe('gpt-5.2-2026-01-15');
    expect(res.stop_reason).toBe('tool_use');
    expect(res.content).toEqual([
      { type: 'text', text: 'Running it.' },
      { type: 'tool_use', id: 'call_2', name: 'bash', input: { cmd: 'npm test' } },
    ]);
    // prompt_tokens includes cached tokens on the wire; canonical input_tokens never does.
    expect(res.usage).toEqual({
      input_tokens: 400,
      output_tokens: 85,
      cache_read_tokens: 800,
    });
  });

  it('maps every finish_reason', () => {
    const at = (finish: unknown): string =>
      openaiToCanonicalResponse({ id: 'x', model: 'm', choices: [{ finish_reason: finish }] })
        .stop_reason;
    expect(at('stop')).toBe('end_turn');
    expect(at('tool_calls')).toBe('tool_use');
    expect(at('function_call')).toBe('tool_use');
    expect(at('length')).toBe('max_tokens');
    expect(at('content_filter')).toBe('end_turn');
    expect(at(null)).toBe('end_turn');
  });

  it('turns an error envelope into an error response', () => {
    const res = openaiToCanonicalResponse({
      error: { message: 'Rate limit reached', type: 'rate_limit_error' },
    });
    expect(res.stop_reason).toBe('error');
    expect(res.content).toEqual([{ type: 'text', text: 'Rate limit reached' }]);
  });

  it('never throws on junk', () => {
    expect(() => openaiToCanonicalResponse(undefined)).not.toThrow();
    expect(openaiToCanonicalResponse({}).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

const SSE_TOOL_STREAM = [
  'data: {"id":"chatcmpl-9","object":"chat.completion.chunk","created":1770000000,"model":"gpt-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-9","choices":[{"index":0,"delta":{"content":"Let me "},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-9","choices":[{"index":0,"delta":{"content":"run it."},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-9","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_7","type":"function","function":{"name":"bash","arguments":""}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-9","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-9","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \\"npm te"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-9","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"st\\", \\"timeout\\": 60}"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-9","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"id":"chatcmpl-9","choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":85,"total_tokens":1285,"prompt_tokens_details":{"cached_tokens":800}}}\n\n',
  'data: [DONE]\n\n',
].join('');

function reslice(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe('parseOpenaiSse', () => {
  it('assembles text, fragmented tool arguments, usage and finish reason', () => {
    const res = parseOpenaiSse(SSE_TOOL_STREAM);
    expect(res.id).toBe('chatcmpl-9');
    expect(res.model).toBe('gpt-5.2');
    expect(res.stop_reason).toBe('tool_use');
    expect(res.content).toEqual([
      { type: 'text', text: 'Let me run it.' },
      { type: 'tool_use', id: 'call_7', name: 'bash', input: { cmd: 'npm test', timeout: 60 } },
    ]);
    expect(res.usage).toEqual({ input_tokens: 400, output_tokens: 85, cache_read_tokens: 800 });
  });

  it('gives the same answer however the bytes are chunked', () => {
    const whole = parseOpenaiSse(SSE_TOOL_STREAM);
    for (const size of [1, 13, 128, 4096]) {
      expect(parseOpenaiSse(reslice(SSE_TOOL_STREAM, size))).toEqual(whole);
    }
  });

  it('degrades malformed streamed arguments to a raw string', () => {
    const res = parseOpenaiSse(
      'data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"bash","arguments":"{\\"cmd\\": \\"np"}}]}}]}\n\n' +
        'data: [DONE]\n\n',
    );
    expect(res.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_b',
      name: 'bash',
      input: { _raw: '{"cmd": "np' },
    });
  });

  it('assembles two parallel tool calls in index order', () => {
    const res = parseOpenaiSse(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_second","type":"function","function":{"name":"b","arguments":"{}"}}]}}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_first","type":"function","function":{"name":"a","arguments":"{}"}}]}}]}\n\n' +
        'data: [DONE]\n\n',
    );
    expect(res.content.map((c) => (c.type === 'tool_use' ? c.id : c.type))).toEqual([
      'call_first',
      'call_second',
    ]);
  });

  it('ignores empty input, keepalive comments and garbage frames', () => {
    expect(() => parseOpenaiSse('')).not.toThrow();
    expect(() => parseOpenaiSse([': keepalive\n\n', 'data: {oops}\n\n'])).not.toThrow();
    expect(parseOpenaiSse('data: [DONE]\n\n').content).toEqual([]);
  });
});

/** An assistant turn carrying reasoning, text and a tool call, in the order the parsers use. */
function toolResponse(): CanonicalResponse {
  return {
    id: 'chatcmpl-round',
    model: 'gpt-5.2-2026-01-15',
    stop_reason: 'tool_use',
    content: [
      { type: 'thinking', text: 'The build is red, so run the tests.' },
      { type: 'text', text: 'Running it.' },
      { type: 'tool_use', id: 'call_2', name: 'bash', input: { cmd: 'npm test', timeout: 60 } },
    ],
    usage: { input_tokens: 400, output_tokens: 85, cache_read_tokens: 800 },
  };
}

/**
 * Serialize both ways, then read each form back with the parser that defines what the canonical
 * shape means. A serializer is correct exactly when this returns the response it was handed.
 */
function openaiRoundTrip(res: CanonicalResponse): CanonicalResponse[] {
  return [
    openaiToCanonicalResponse(canonicalToOpenaiResponse(res)),
    parseOpenaiSse(canonicalToOpenaiSse(res)),
  ];
}

/** The `data:` payloads of an SSE body, in order, still unparsed. */
function dataPayloads(sse: string): string[] {
  return sse
    .split('\n\n')
    .filter((frame) => frame !== '')
    .map((frame) => frame.replace(/^data: /, ''));
}

describe('canonicalToOpenaiResponse', () => {
  it('emits the chat-completions body shape', () => {
    const body = canonicalToOpenaiResponse(toolResponse());
    expect(body['id']).toBe('chatcmpl-round');
    expect(body['object']).toBe('chat.completion');
    expect(body['model']).toBe('gpt-5.2-2026-01-15');
    expect(body['choices']).toEqual([
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Running it.',
          reasoning_content: 'The build is red, so run the tests.',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'bash', arguments: '{"cmd":"npm test","timeout":60}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ]);
    // prompt_tokens is the whole prompt including the cached part; canonical input_tokens is not.
    expect(body['usage']).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 85,
      total_tokens: 1285,
      prompt_tokens_details: { cached_tokens: 800 },
    });
  });

  it('maps every stop reason to a finish reason', () => {
    const finish = (stop: CanonicalResponse['stop_reason']): unknown => {
      const body = canonicalToOpenaiResponse({
        id: 'c',
        model: 'gpt-5.2',
        stop_reason: stop,
        content: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      });
      return (body['choices'] as Record<string, unknown>[])[0]?.['finish_reason'];
    };
    expect(finish('end_turn')).toBe('stop');
    expect(finish('tool_use')).toBe('tool_calls');
    expect(finish('max_tokens')).toBe('length');
    // OpenAI has no separate stop-sequence reason; `stop` is the closest thing it can say.
    expect(finish('stop_sequence')).toBe('stop');
  });

  it('sends a null content when the turn is tool calls only', () => {
    const body = canonicalToOpenaiResponse({
      id: 'c',
      model: 'gpt-5.2',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'call_9', name: 'now', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const message = (body['choices'] as Record<string, unknown>[])[0]?.['message'];
    expect((message as Record<string, unknown>)['content']).toBeNull();
  });

  it('omits the cached-token detail a canonical response never had', () => {
    const body = canonicalToOpenaiResponse({
      id: 'c',
      model: 'gpt-5.2',
      stop_reason: 'end_turn',
      content: [],
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    expect(body['usage']).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
  });

  it('emits an error envelope for an error stop reason', () => {
    const body = canonicalToOpenaiResponse({
      id: 'c',
      model: 'gpt-5.2',
      stop_reason: 'error',
      content: [{ type: 'text', text: 'Rate limit reached' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(body['error']).toEqual({ type: 'error', message: 'Rate limit reached' });
  });
});

describe('canonicalToOpenaiSse', () => {
  it('frames chat.completion.chunk objects and ends with [DONE]', () => {
    const payloads = dataPayloads(canonicalToOpenaiSse(toolResponse()));
    expect(payloads.at(-1)).toBe('[DONE]');
    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p) as Record<string, unknown>);
    // role, reasoning, text, tool name, tool arguments, finish reason, usage.
    expect(chunks).toHaveLength(7);
    expect(chunks.every((c) => c['object'] === 'chat.completion.chunk')).toBe(true);
    expect(chunks.every((c) => c['id'] === 'chatcmpl-round')).toBe(true);
    expect(chunks.every((c) => c['model'] === 'gpt-5.2-2026-01-15')).toBe(true);
    expect(chunks.at(-2)?.['choices']).toEqual([
      { index: 0, delta: {}, finish_reason: 'tool_calls' },
    ]);
    expect(chunks.at(-1)?.['usage']).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 85,
      total_tokens: 1285,
      prompt_tokens_details: { cached_tokens: 800 },
    });
  });

  it('names a tool call before streaming its arguments', () => {
    const chunks = dataPayloads(canonicalToOpenaiSse(toolResponse()))
      .slice(0, -1)
      .map((p) => JSON.parse(p) as Record<string, unknown>);
    const deltas = chunks.map(
      (c) =>
        ((c['choices'] as Record<string, unknown>[])[0]?.['delta'] ?? {}) as Record<
          string,
          unknown
        >,
    );
    expect(deltas[3]?.['tool_calls']).toEqual([
      { index: 0, id: 'call_2', type: 'function', function: { name: 'bash', arguments: '' } },
    ]);
    expect(deltas[4]?.['tool_calls']).toEqual([
      { index: 0, function: { arguments: '{"cmd":"npm test","timeout":60}' } },
    ]);
  });

  it('decodes the same however the bytes are re-chunked', () => {
    const sse = canonicalToOpenaiSse(toolResponse());
    for (const size of [1, 13, 128, 4096]) {
      expect(parseOpenaiSse(reslice(sse, size))).toEqual(toolResponse());
    }
  });
});

describe('openai response round trip', () => {
  it('preserves reasoning, text, a tool call, usage and stop reason', () => {
    const res = toolResponse();
    expect(openaiRoundTrip(res)).toEqual([res, res]);
  });

  it('preserves plain text with no tools', () => {
    const res: CanonicalResponse = {
      id: 'chatcmpl-text',
      model: 'gpt-5.2',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'The build is red because a test fails.' }],
      usage: { input_tokens: 42, output_tokens: 9 },
    };
    expect(openaiRoundTrip(res)).toEqual([res, res]);
  });

  it('preserves several parallel tool calls in order', () => {
    const res: CanonicalResponse = {
      id: 'chatcmpl-parallel',
      model: 'gpt-5.2',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'reading both' },
        { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'call_b', name: 'read', input: { path: 'b.ts' } },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    expect(openaiRoundTrip(res)).toEqual([res, res]);
  });

  it('preserves an empty content list', () => {
    const res: CanonicalResponse = {
      id: 'chatcmpl-empty',
      model: 'gpt-5-mini',
      stop_reason: 'end_turn',
      content: [],
      usage: { input_tokens: 7, output_tokens: 0 },
    };
    expect(openaiRoundTrip(res)).toEqual([res, res]);
  });

  it('preserves an empty tool input and a tool input that never parsed', () => {
    const res: CanonicalResponse = {
      id: 'chatcmpl-tools',
      model: 'gpt-5.2',
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'call_now', name: 'now', input: {} },
        { type: 'tool_use', id: 'call_bad', name: 'bash', input: { _raw: '{"cmd": "np' } },
      ],
      usage: { input_tokens: 5, output_tokens: 6 },
    };
    expect(openaiRoundTrip(res)).toEqual([res, res]);
  });

  it('preserves an error response', () => {
    const res: CanonicalResponse = {
      id: 'chatcmpl-err',
      model: 'gpt-5.2',
      stop_reason: 'error',
      content: [{ type: 'text', text: 'Rate limit reached' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    expect(openaiRoundTrip(res)).toEqual([res, res]);
  });

  it('collapses several text blocks into one', () => {
    const res: CanonicalResponse = {
      id: 'chatcmpl-many',
      model: 'gpt-5.2',
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    // Documented loss: a chat-completions message has exactly one content body, so a block list
    // cannot survive the OpenAI dialect. Joining beats dropping, and the Anthropic form keeps it.
    const joined = [{ type: 'text', text: 'first\nsecond' }];
    expect(openaiRoundTrip(res)).toEqual([
      { ...res, content: joined },
      { ...res, content: joined },
    ]);
  });

  it('reports a stop_sequence turn as a plain end_turn', () => {
    const res: CanonicalResponse = {
      id: 'chatcmpl-stop',
      model: 'gpt-5.2',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    // Documented loss: OpenAI's finish_reason vocabulary has no stop-sequence member, so a turn
    // that ended on a stop sequence is indistinguishable from any other completed turn.
    expect(openaiRoundTrip(res)).toEqual([
      { ...res, stop_reason: 'end_turn' },
      { ...res, stop_reason: 'end_turn' },
    ]);
  });

  it('drops cache-write tokens, which OpenAI has no field for', () => {
    const res: CanonicalResponse = {
      id: 'chatcmpl-cache',
      model: 'gpt-5.2',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 400,
        output_tokens: 5,
        cache_read_tokens: 800,
        cache_write_tokens: 300,
      },
    };
    // Documented loss: OpenAI reports cache reads but never charges or reports a cache write, so
    // cache_write_tokens has nowhere to go. The read counter and both token totals survive.
    const usage = { input_tokens: 400, output_tokens: 5, cache_read_tokens: 800 };
    expect(openaiRoundTrip(res)).toEqual([
      { ...res, usage },
      { ...res, usage },
    ]);
  });
});

describe('cross dialect responses', () => {
  /** What an Anthropic-recorded assistant turn looks like on the wire. */
  const anthropicBody = {
    id: 'msg_01FORK',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-20260101',
    content: [
      { type: 'text', text: 'Running it.' },
      { type: 'tool_use', id: 'toolu_02B', name: 'bash', input: { cmd: 'npm test' } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 85, cache_read_input_tokens: 800 },
  };

  it('carries an Anthropic reply through canonical into OpenAI and back', () => {
    // The exact path `orca replay --model gpt-5.2` takes on an Anthropic-recorded run.
    const canonical = anthropicToCanonicalResponse(anthropicBody);
    const viaJson = openaiToCanonicalResponse(canonicalToOpenaiResponse(canonical));
    const viaSse = parseOpenaiSse(canonicalToOpenaiSse(canonical));
    expect(viaJson).toEqual(canonical);
    expect(viaSse).toEqual(canonical);
    expect(viaJson.content).toEqual([
      { type: 'text', text: 'Running it.' },
      { type: 'tool_use', id: 'toolu_02B', name: 'bash', input: { cmd: 'npm test' } },
    ]);
    expect(viaJson.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 85,
      cache_read_tokens: 800,
    });
  });

  it('carries a streamed Anthropic reply into an OpenAI stream and back', () => {
    const canonical = parseAnthropicSse(
      canonicalToAnthropicSse(anthropicToCanonicalResponse(anthropicBody)),
    );
    expect(parseOpenaiSse(canonicalToOpenaiSse(canonical))).toEqual(canonical);
  });

  it('carries an OpenAI reply back into the Anthropic dialect', () => {
    const openaiBody = {
      id: 'chatcmpl-fork',
      object: 'chat.completion',
      model: 'gpt-5.2',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Running it.',
            tool_calls: [
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'bash', arguments: '{"cmd":"npm test"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 85,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    };
    const canonical = openaiToCanonicalResponse(openaiBody);
    expect(anthropicToCanonicalResponse(canonicalToAnthropicResponse(canonical))).toEqual(
      canonical,
    );
    expect(parseAnthropicSse(canonicalToAnthropicSse(canonical))).toEqual(canonical);
  });
});
