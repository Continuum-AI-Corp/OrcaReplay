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

  it('records a failed exchange rather than dropping it', async () => {
    // Recording used to be guarded by `if (upstreamRes.ok)`. A run that died on rate limits then
    // produced a trace with no evidence of why — and replay came up short exactly the exchanges
    // that explain the failure you opened the trace to understand.
    const up = stubUpstream({ error: { message: 'rate limited' } }, 429);
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, ANTHROPIC_BODY);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe(429);
    expect(seen[0]!.rawResponse).toContain('rate limited');
  });

  it('binds loopback only — a trace is sensitive', async () => {
    const up = stubUpstream(ANTHROPIC_REPLY);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('proxy — streaming', () => {
  /**
   * A model response arrives as SSE over seconds. The proxy used to `await upstreamRes.text()`
   * before writing a single byte, so the agent got the whole response at once, after the model had
   * finished — every turn of an interactive session appeared to hang for its full duration, and
   * `docs/architecture.md` claimed the opposite ("tees a canonical copy while streaming through").
   *
   * The test is built so buffering cannot pass it by luck: the upstream withholds its second chunk
   * until the *client* has actually received the first. A proxy that buffers deadlocks, which the
   * race below turns into a legible failure instead of a timeout.
   */
  function gatedUpstream() {
    let releaseSecond: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseSecond = r;
    });
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(
              enc.encode('event: message_start\ndata: {"type":"message_start"}\n\n'),
            );
            await gate;
            controller.enqueue(
              enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof fetch;
    return { fetchImpl, releaseSecond };
  }

  it('forwards the first chunk before the upstream has finished', async () => {
    const up = gatedUpstream();
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ANTHROPIC_BODY),
    });
    const reader = res.body!.getReader();

    const first = await Promise.race([
      reader.read().then((r) => new TextDecoder().decode(r.value)),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('proxy buffered: no chunk reached the client')), 2000),
      ),
    ]);
    expect(first).toContain('message_start');

    // Only now does the upstream produce the rest, proving the first chunk was genuinely early.
    up.releaseSecond();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('message_stop');
  });

  it('records the whole streamed body, not just the part it forwarded first', async () => {
    const up = gatedUpstream();
    const seen: RecordedExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ANTHROPIC_BODY),
    });
    const reader = res.body!.getReader();
    // Same guard as above: without it a buffering proxy hangs the suite instead of failing it.
    await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('proxy buffered: no chunk reached the client')), 2000),
      ),
    ]);
    up.releaseSecond();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    // The exchange is finished only once the stream ends, so give the tee a turn to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.streamed).toBe(true);
    expect(seen[0]!.rawResponse).toContain('message_start');
    expect(seen[0]!.rawResponse).toContain('message_stop');
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

    // Drift is what changes *around* the question between two runs of the same task: the harness
    // stamps a different cwd or date into its system prompt. The question itself is deliberately
    // byte-identical — a request that asks something else is not drift, and the matcher refuses it
    // rather than answering it from the recording.
    await post(`${proxy.url}/v1/messages`, {
      ...ANTHROPIC_BODY,
      system: 'You are a coding agent. cwd=/tmp/other',
    });

    expect(divergences).toHaveLength(1);
    expect(divergences[0]!.level).toBe('minor');
  });

  /** The request no recording can answer, used by the halt tests below. */
  const unmatchable = {
    model: 'other-model',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'something else entirely' }],
  };

  it('fails loudly when nothing matches, rather than inventing a reply', async () => {
    const proxy = await createProxy({ mode: 'replay', exchanges: [exchange] });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/messages`, unmatchable);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('does not match the recording');
  });

  it('halts with a status the harness will not retry', async () => {
    // This was a real, silent failure. The halt used to be a 409, which sits in the Anthropic and
    // OpenAI SDKs' default retry set alongside 408, 429 and 5xx — so the harness quietly re-sent
    // the same unmatched request until its retry budget ran out and then stalled, and the operator
    // saw a hung terminal instead of the reason. A halt that is retried is not a halt.
    const retriable = new Set([408, 409, 429, 500, 502, 503, 504]);
    const proxy = await createProxy({ mode: 'replay', exchanges: [exchange] });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/messages`, unmatchable);

    expect(retriable.has(res.status)).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('shapes the halt as an error the harness will surface to the operator', async () => {
    // The message only helps if it reaches a human. Both dialects' clients read `error.message`
    // off the body and print it, so the halt speaks their error shape rather than inventing one.
    const proxy = await createProxy({ mode: 'replay', exchanges: [exchange] });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/messages`, unmatchable);
    const body = res.json as { type?: string; error?: { type?: string; message?: string } };

    expect(body.type).toBe('error');
    expect(body.error?.message).toContain('orca');
    expect(body.error?.message).toContain('--loose');
  });

  it('reports the unmatched request to the caller instead of only counting it', async () => {
    // `unmatched: 12` with no reason is what the operator used to be left with.
    const unmatched: { seq: number; reason: string }[] = [];
    const proxy = await createProxy({
      mode: 'replay',
      exchanges: [exchange],
      onUnmatched: (u) => void unmatched.push(u),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/messages`, unmatchable);

    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]!.reason).toContain('does not match the recording');
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
