import { describe, expect, it } from 'vitest';
import {
  anthropicToCanonicalRequest,
  canonicalToOpenaiRequest,
  openaiToCanonicalRequest,
  openaiToCanonicalResponse,
  parseOpenaiSse,
} from '../src/index.js';

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
