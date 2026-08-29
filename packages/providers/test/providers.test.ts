import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalChunk, CanonicalRequest } from '@orcareplay/plugin-api';
import { AnthropicProvider, OpenAiCompatibleProvider } from '../src/index.js';

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch that records what it was asked for and replays a canned response. Never hits a socket. */
function recorder(handler: (call: Call) => Response): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** Deliver an SSE body in several socket-sized slices. */
function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function headersOf(init: RequestInit): Record<string, string> {
  const raw = (init.headers ?? {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
  return out;
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

async function collect(stream: AsyncIterable<CanonicalChunk>): Promise<CanonicalChunk[]> {
  const out: CanonicalChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const REQUEST: CanonicalRequest = {
  model: 'claude-opus-5',
  system: 'be terse',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'run the tests' }] }],
  tools: [{ name: 'bash', input_schema: { type: 'object' } }],
  max_tokens: 512,
};

const ANTHROPIC_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_live","model":"claude-opus-5-20260101","content":[],"usage":{"input_tokens":11,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Sure"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", running."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_live","name":"bash","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"npm "}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"test\\"}"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

// Re-slice at offsets that fall inside events, the way a socket would deliver them.
const ANTHROPIC_SLICES = ((): string[] => {
  const joined = ANTHROPIC_STREAM.join('');
  return [joined.slice(0, 300), joined.slice(300, 700), joined.slice(700)];
})();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AnthropicProvider', () => {
  it('posts a streaming request to the Messages API with the documented headers', async () => {
    const { calls, fetchImpl } = recorder(() => sseResponse(ANTHROPIC_SLICES));
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-test', fetchImpl });
    expect(provider.id).toBe('anthropic');
    await collect(provider.invoke(REQUEST));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.init.method).toBe('POST');
    const headers = headersOf(call.init);
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
  });

  it('sends the canonical request translated into Anthropic shape, forced to stream', async () => {
    const { calls, fetchImpl } = recorder(() => sseResponse(ANTHROPIC_SLICES));
    await collect(
      new AnthropicProvider({ apiKey: 'k', fetchImpl }).invoke({ ...REQUEST, stream: false }),
    );
    const body = bodyOf(calls[0]!.init);
    expect(body['stream']).toBe(true);
    expect(body['model']).toBe('claude-opus-5');
    expect(body['system']).toBe('be terse');
    expect(body['max_tokens']).toBe(512);
    expect(body['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
    ]);
    expect(body['tools']).toEqual([{ name: 'bash', input_schema: { type: 'object' } }]);
  });

  it('supplies a max_tokens default because the API requires one', async () => {
    const { calls, fetchImpl } = recorder(() => sseResponse(ANTHROPIC_SLICES));
    const { max_tokens: _drop, ...noMax } = REQUEST;
    await collect(new AnthropicProvider({ apiKey: 'k', fetchImpl }).invoke(noMax));
    expect(bodyOf(calls[0]!.init)['max_tokens']).toBeGreaterThan(0);
  });

  it('honours a custom baseUrl and extra headers', async () => {
    const { calls, fetchImpl } = recorder(() => sseResponse(ANTHROPIC_SLICES));
    await collect(
      new AnthropicProvider({
        apiKey: 'k',
        baseUrl: 'http://127.0.0.1:51733/anthropic/',
        headers: { 'x-orca-run': 'run_abc' },
        fetchImpl,
      }).invoke(REQUEST),
    );
    expect(calls[0]!.url).toBe('http://127.0.0.1:51733/anthropic/v1/messages');
    expect(headersOf(calls[0]!.init)['x-orca-run']).toBe('run_abc');
  });

  it('streams deltas and finishes with the assembled response', async () => {
    const { fetchImpl } = recorder(() => sseResponse(ANTHROPIC_SLICES));
    const chunks = await collect(new AnthropicProvider({ apiKey: 'k', fetchImpl }).invoke(REQUEST));

    expect(chunks.filter((c) => c.type === 'text_delta').map((c) => c.text)).toEqual([
      'Sure',
      ', running.',
    ]);
    const toolDeltas = chunks.filter((c) => c.type === 'tool_use_delta');
    expect(toolDeltas.length).toBeGreaterThan(0);
    expect(toolDeltas.every((c) => c.id === 'toolu_live' && c.name === 'bash')).toBe(true);

    const last = chunks.at(-1)!;
    expect(last.type).toBe('done');
    if (last.type !== 'done') throw new Error('unreachable');
    expect(last.response).toEqual({
      id: 'msg_live',
      model: 'claude-opus-5-20260101',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Sure, running.' },
        { type: 'tool_use', id: 'toolu_live', name: 'bash', input: { cmd: 'npm test' } },
      ],
      usage: { input_tokens: 11, output_tokens: 42 },
    });
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
  });

  it('passes the abort signal through to fetch', async () => {
    const { calls, fetchImpl } = recorder(() => sseResponse(ANTHROPIC_SLICES));
    const controller = new AbortController();
    await collect(
      new AnthropicProvider({ apiKey: 'k', fetchImpl }).invoke(REQUEST, controller.signal),
    );
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  it('turns an HTTP 429 into an error naming the status and the API message', async () => {
    const { fetchImpl } = recorder(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'Number of requests has exceeded' },
          }),
          { status: 429, statusText: 'Too Many Requests' },
        ),
    );
    const provider = new AnthropicProvider({ apiKey: 'k', fetchImpl });
    await expect(collect(provider.invoke(REQUEST))).rejects.toThrow(/429/);
    await expect(collect(provider.invoke(REQUEST))).rejects.toThrow(/rate_limit_error/);
    await expect(collect(provider.invoke(REQUEST))).rejects.toThrow(
      /Number of requests has exceeded/,
    );
  });

  it('still explains an error whose body is not JSON', async () => {
    const { fetchImpl } = recorder(
      () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );
    await expect(
      collect(new AnthropicProvider({ apiKey: 'k', fetchImpl }).invoke(REQUEST)),
    ).rejects.toThrow(/502/);
  });

  it('refuses to send without an api key and says which one to set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { calls, fetchImpl } = recorder(() => sseResponse(ANTHROPIC_SLICES));
    await expect(collect(new AnthropicProvider({ fetchImpl }).invoke(REQUEST))).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(calls).toHaveLength(0);
  });

  it('lists models from the API and enriches the known ones with pricing', async () => {
    const { calls, fetchImpl } = recorder(
      () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'claude-opus-5-20260101' }, { id: 'claude-mystery-9' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const models = await new AnthropicProvider({ apiKey: 'k', fetchImpl }).models();
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models');
    expect(models[0]).toEqual({
      id: 'claude-opus-5-20260101',
      context_window: 200_000,
      input_price_per_mtok: 15,
      output_price_per_mtok: 75,
    });
    expect(models[1]).toEqual({ id: 'claude-mystery-9' });
  });

  it('falls back to a whole JSON body when a gateway ignores stream:true', async () => {
    const { fetchImpl } = recorder(
      () =>
        new Response(
          JSON.stringify({
            id: 'msg_json',
            model: 'claude-opus-5',
            content: [
              { type: 'text', text: 'no streaming here' },
              { type: 'tool_use', id: 'toolu_j', name: 'bash', input: { cmd: 'ls' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 5, output_tokens: 6 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const chunks = await collect(new AnthropicProvider({ apiKey: 'k', fetchImpl }).invoke(REQUEST));
    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'no streaming here' });
    expect(chunks[1]).toEqual({
      type: 'tool_use_delta',
      id: 'toolu_j',
      name: 'bash',
      partial_json: '{"cmd":"ls"}',
    });
    const last = chunks.at(-1)!;
    if (last.type !== 'done') throw new Error('expected a done chunk last');
    expect(last.response.id).toBe('msg_json');
    expect(last.response.usage).toEqual({ input_tokens: 5, output_tokens: 6 });
  });

  it('prices a turn through the shared table', () => {
    const provider = new AnthropicProvider({ apiKey: 'k' });
    expect(provider.price({ input_tokens: 2_000, output_tokens: 500 }, 'claude-opus-5')).toEqual({
      amount: 0.0675,
      currency: 'USD',
    });
    expect(provider.price({ input_tokens: 1, output_tokens: 1 }, 'who-knows')).toBeNull();
  });
});

const OPENAI_STREAM = [
  'data: {"id":"chatcmpl-live","object":"chat.completion.chunk","model":"gpt-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":"Sure"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-live","choices":[{"index":0,"delta":{"content":", running."},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-live","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_live","type":"function","function":{"name":"bash","arguments":"{\\"cmd\\":"}}]}}]}\n\n',
  'data: {"id":"chatcmpl-live","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"npm test\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"id":"chatcmpl-live","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":42}}\n\n',
  'data: [DONE]\n\n',
];

describe('OpenAiCompatibleProvider', () => {
  it('posts to chat/completions with bearer auth', async () => {
    const { calls, fetchImpl } = recorder(() => sseResponse(OPENAI_STREAM));
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      fetchImpl,
    });
    expect(provider.id).toBe('openai-compatible');
    await collect(provider.invoke({ ...REQUEST, model: 'gpt-5.2' }));

    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = headersOf(calls[0]!.init);
    expect(headers['authorization']).toBe('Bearer sk-test');
    expect(headers['content-type']).toBe('application/json');
  });

  it('sends the canonical request in OpenAI shape and asks for streamed usage', async () => {
    const { calls, fetchImpl } = recorder(() => sseResponse(OPENAI_STREAM));
    await collect(
      new OpenAiCompatibleProvider({ apiKey: 'k', fetchImpl }).invoke({
        ...REQUEST,
        model: 'gpt-5.2',
      }),
    );
    const body = bodyOf(calls[0]!.init);
    expect(body['stream']).toBe(true);
    expect(body['stream_options']).toEqual({ include_usage: true });
    expect(body['messages']).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'run the tests' },
    ]);
    expect(body['tools']).toEqual([
      { type: 'function', function: { name: 'bash', parameters: { type: 'object' } } },
    ]);
  });

  it('omits Authorization entirely for a keyless local server', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const { calls, fetchImpl } = recorder(() => sseResponse(OPENAI_STREAM));
    await collect(
      new OpenAiCompatibleProvider({ baseUrl: 'http://127.0.0.1:11434/v1', fetchImpl }).invoke({
        ...REQUEST,
        model: 'qwen3-coder',
      }),
    );
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(headersOf(calls[0]!.init)['authorization']).toBeUndefined();
  });

  it('streams deltas and finishes with the assembled response', async () => {
    const { fetchImpl } = recorder(() => sseResponse(OPENAI_STREAM));
    const chunks = await collect(
      new OpenAiCompatibleProvider({ apiKey: 'k', fetchImpl }).invoke({
        ...REQUEST,
        model: 'gpt-5.2',
      }),
    );
    expect(chunks.filter((c) => c.type === 'text_delta').map((c) => c.text)).toEqual([
      'Sure',
      ', running.',
    ]);
    const last = chunks.at(-1)!;
    if (last.type !== 'done') throw new Error('expected a done chunk last');
    expect(last.response).toEqual({
      id: 'chatcmpl-live',
      model: 'gpt-5.2',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Sure, running.' },
        { type: 'tool_use', id: 'call_live', name: 'bash', input: { cmd: 'npm test' } },
      ],
      usage: { input_tokens: 11, output_tokens: 42 },
    });
  });

  it('takes a caller supplied id so gateways keep their own name in errors', async () => {
    const { fetchImpl } = recorder(
      () =>
        new Response(JSON.stringify({ error: { message: 'quota exceeded', type: 'rate_limit' } }), {
          status: 429,
        }),
    );
    const provider = new OpenAiCompatibleProvider({
      id: 'openrouter',
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
      fetchImpl,
    });
    expect(provider.id).toBe('openrouter');
    await expect(collect(provider.invoke({ ...REQUEST, model: 'gpt-5.2' }))).rejects.toThrow(
      /openrouter/,
    );
    await expect(collect(provider.invoke({ ...REQUEST, model: 'gpt-5.2' }))).rejects.toThrow(/429/);
    await expect(collect(provider.invoke({ ...REQUEST, model: 'gpt-5.2' }))).rejects.toThrow(
      /quota exceeded/,
    );
  });

  it('lists models from the API', async () => {
    const { calls, fetchImpl } = recorder(
      () =>
        new Response(JSON.stringify({ data: [{ id: 'gpt-5-mini' }, { id: 'local-thing' }] }), {
          status: 200,
        }),
    );
    const models = await new OpenAiCompatibleProvider({
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      fetchImpl,
    }).models();
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/models');
    expect(models).toEqual([
      {
        id: 'gpt-5-mini',
        context_window: 400_000,
        input_price_per_mtok: 0.25,
        output_price_per_mtok: 2,
      },
      { id: 'local-thing' },
    ]);
  });

  it('falls back to a whole JSON body when a server ignores stream:true', async () => {
    const { fetchImpl } = recorder(
      () =>
        new Response(
          JSON.stringify({
            id: 'chatcmpl-json',
            model: 'qwen3-coder',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 6 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const chunks = await collect(
      new OpenAiCompatibleProvider({ apiKey: 'k', fetchImpl }).invoke({
        ...REQUEST,
        model: 'qwen3-coder',
      }),
    );
    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'hi' });
    const last = chunks.at(-1)!;
    if (last.type !== 'done') throw new Error('expected a done chunk last');
    expect(last.response.id).toBe('chatcmpl-json');
    expect(last.response.stop_reason).toBe('end_turn');
  });

  it('prices a turn through the shared table', () => {
    const provider = new OpenAiCompatibleProvider({ apiKey: 'k' });
    expect(provider.price({ input_tokens: 1_000_000, output_tokens: 0 }, 'gpt-5.2')).toEqual({
      amount: 1.25,
      currency: 'USD',
    });
  });
});
