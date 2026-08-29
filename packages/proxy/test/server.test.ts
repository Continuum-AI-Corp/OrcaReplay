import { afterEach, describe, expect, it } from 'vitest';
import type { RecordedExchange } from '../src/server.js';
import { createProxy } from '../src/server.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const ANTHROPIC_BODY = {
  model: 'claude-opus-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'fix the auth test' }],
};

const ANTHROPIC_REPLY = {
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'looking at auth.ts now' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 7 },
};

function stubUpstream(reply: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-secret-key', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe('proxy — record mode', () => {
  it('forwards to upstream and returns the upstream response unchanged', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);

    expect(res.status).toBe(200);
    expect(res.json).toEqual(ANTHROPIC_REPLY);
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.url).toContain('/v1/messages');
  });

  it('emits one exchange carrying both raw bytes and the canonical form', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);

    expect(seen).toHaveLength(1);
    const ex = seen[0]!;
    expect(ex.dialect).toBe('anthropic');
    // Raw bytes are what make exact replay exact; canonical is what makes forking possible.
    expect(ex.rawRequest).toContain('fix the auth test');
    expect(ex.rawResponse).toContain('looking at auth.ts now');
    expect(ex.canonicalRequest.model).toBe('claude-opus-5');
    expect(ex.canonicalResponse?.content[0]).toMatchObject({ type: 'text' });
    expect(ex.usage?.input_tokens).toBe(12);
  });

  it('forwards the caller auth header upstream but never records it', async () => {
    // Both halves matter. Claude Code under a subscription login authenticates with its own
    // `authorization: Bearer` header and ignores any injected key, so a proxy that drops it
    // breaks the agent outright. §7 says never *write* auth material — not never forward it.
    const up = stubUpstream(ANTHROPIC_REPLY);
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY, {
      authorization: 'Bearer oauth-subscription-token',
    });

    const forwarded = up.calls[0]!.init.headers as Record<string, string>;
    expect(forwarded.authorization).toBe('Bearer oauth-subscription-token');
    expect(JSON.stringify(seen[0]!.requestHeaders ?? {})).not.toContain('oauth-subscription-token');
  });

  it('answers the agent-proxy probes Claude Code makes, without touching the recording', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);
    const res = await fetch(`${proxy.url}/v1/code/agent-proxy/ca-cert`);
    expect([200, 404]).toContain(res.status);
    expect(up.calls).toHaveLength(0);
  });

  it('never records the caller auth header', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);

    const dumped = JSON.stringify(seen[0]!.requestHeaders ?? {});
    expect(dumped).not.toContain('sk-secret-key');
  });

  it('routes OpenAI chat completions and labels the dialect', async () => {
    const up = stubUpstream({
      id: 'chatcmpl-1',
      model: 'gpt-5.2',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/chat/completions`, {
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    expect(seen[0]!.dialect).toBe('openai');
  });

  it('propagates an upstream error status instead of masking it', async () => {
    const up = stubUpstream({ error: { message: 'rate limited' } }, 429);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);
    expect((await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY)).status).toBe(429);
  });

  it('binds loopback only — a trace is sensitive', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('proxy — replay mode', () => {
  const exchange: RecordedExchange = {
    seq: 0,
    dialect: 'anthropic',
    path: '/v1/messages',
    rawRequest: JSON.stringify(ANTHROPIC_BODY),
    rawResponse: JSON.stringify(ANTHROPIC_REPLY),
    status: 200,
    streamed: false,
    canonicalRequest: {
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the auth test' }] }],
    },
  };

  it('serves the recorded response and makes no network call at all', async () => {
    let called = false;
    const proxy = await createProxy({
      mode: 'replay',
      exchanges: [exchange],
      fetchImpl: (async () => {
        called = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);

    expect(res.json).toEqual(ANTHROPIC_REPLY);
    expect(called, 'replay must block egress at the socket, not merely discourage it').toBe(false);
  });

  it('reports an exact match with no divergence', async () => {
    const divergences: unknown[] = [];
    const proxy = await createProxy({
      mode: 'replay',
      exchanges: [exchange],
      onDivergence: (d) => void divergences.push(d),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);
    expect(divergences).toHaveLength(0);
    expect(proxy.stats().matchedExact).toBe(1);
  });

  it('records a divergence when the replayed request drifts', async () => {
    const divergences: { level: string }[] = [];
    const proxy = await createProxy({
      mode: 'replay',
      exchanges: [exchange],
      onDivergence: (d) => void divergences.push(d as { level: string }),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, {
      ...ANTHROPIC_BODY,
      messages: [{ role: 'user', content: 'fix the auth test.' }],
    });

    expect(divergences).toHaveLength(1);
    expect(divergences[0]!.level).toBe('minor');
  });

  it('fails loudly with a 409 when nothing matches, rather than inventing a reply', async () => {
    const proxy = await createProxy({ mode: 'replay', exchanges: [exchange] });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/messages`, {
      model: 'other-model',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'something else entirely' }],
    });

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.json)).toContain('does not match the recording');
  });

  it('continues live past an unmatched request when loose is set', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const proxy = await createProxy({
      mode: 'replay',
      exchanges: [exchange],
      loose: true,
      fetchImpl: up.fetchImpl,
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/messages`, {
      model: 'other-model',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'something else entirely' }],
    });

    expect(res.status).toBe(200);
    expect(up.calls).toHaveLength(1);
  });
});

describe('proxy — hybrid (fork) mode', () => {
  const recorded = (seq: number, text: string): RecordedExchange => ({
    seq,
    dialect: 'anthropic',
    path: '/v1/messages',
    rawRequest: JSON.stringify({ ...ANTHROPIC_BODY, messages: [{ role: 'user', content: text }] }),
    rawResponse: JSON.stringify({
      ...ANTHROPIC_REPLY,
      content: [{ type: 'text', text: `recorded ${seq}` }],
    }),
    status: 200,
    streamed: false,
    canonicalRequest: {
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    },
  });

  it('serves from the trace below the cursor and goes live at it', async () => {
    const up = stubUpstream({
      ...ANTHROPIC_REPLY,
      content: [{ type: 'text', text: 'live answer' }],
    });
    const proxy = await createProxy({
      mode: 'hybrid',
      forkAt: 1,
      exchanges: [recorded(0, 'first'), recorded(1, 'second')],
      fetchImpl: up.fetchImpl,
    });
    closers.push(proxy.close);

    const first = await post(`${proxy.url}/v1/messages`, {
      ...ANTHROPIC_BODY,
      messages: [{ role: 'user', content: 'first' }],
    });
    expect(JSON.stringify(first.json)).toContain('recorded 0');
    expect(up.calls).toHaveLength(0);

    const second = await post(`${proxy.url}/v1/messages`, {
      ...ANTHROPIC_BODY,
      messages: [{ role: 'user', content: 'second' }],
    });
    expect(JSON.stringify(second.json)).toContain('live answer');
    expect(up.calls).toHaveLength(1);
  });

  it('rewrites the model on live requests when a fork model is given', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const proxy = await createProxy({
      mode: 'hybrid',
      forkAt: 0,
      forkModel: 'glm-5.3-flash',
      exchanges: [recorded(0, 'first')],
      fetchImpl: up.fetchImpl,
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, {
      ...ANTHROPIC_BODY,
      messages: [{ role: 'user', content: 'first' }],
    });

    expect(String(up.calls[0]!.init.body)).toContain('glm-5.3-flash');
  });
});

describe('proxy — health', () => {
  it('answers /__orca/health without touching the recording', async () => {
    const proxy = await createProxy({ mode: 'replay', exchanges: [] });
    closers.push(proxy.close);
    const res = await fetch(`${proxy.url}/__orca/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('replay');
  });
});
