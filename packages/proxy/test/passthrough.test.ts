import { afterEach, describe, expect, it } from 'vitest';
import type { NetExchange } from '../src/intercept.js';
import { createProxy } from '../src/server.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/**
 * What happens to a request no dialect claims.
 *
 * Orca redirected the harness's base URL at itself, so every call the harness makes now arrives
 * here — including the ones orca has no translator for. Answering `404` to those does not mean
 * "not captured", it means the agent gets an error for a call that would have worked, from a tool
 * whose entire job is not to change the run it is observing. Passthrough is orca putting back what
 * it redirected: forward it, record that it happened, and be honest that it cannot be replayed.
 */

function stubUpstream(reply: unknown, status = 200) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      body: String(init.body ?? ''),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
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
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const EMBEDDING = { object: 'list', data: [{ embedding: [0.1, 0.2] }] };

describe('record mode — a path no dialect claims', () => {
  it('forwards it rather than answering 404', async () => {
    const up = stubUpstream(EMBEDDING);
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, { input: 'hello' });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual(EMBEDDING);
    expect(up.calls[0]!.url).toBe('https://api.openai.com/v1/embeddings');
  });

  it('records it as opaque network traffic, the same shape unrecognised TLS traffic gets', async () => {
    const up = stubUpstream(EMBEDDING);
    const seen: NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
      onNetExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/embeddings`, { input: 'hello' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      host: 'api.openai.com',
      method: 'POST',
      path: '/v1/embeddings',
      status: 200,
    });
    expect(seen[0]!.requestBody).toContain('hello');
  });

  it('does not count an opaque exchange as a recorded model exchange', async () => {
    // It cannot be replayed, so counting it would inflate `reused=n/m` with turns replay will
    // never serve, and the operator would be reading a fidelity number that is not one.
    const up = stubUpstream(EMBEDDING);
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/embeddings`, { input: 'hello' });

    expect(proxy.exchanges()).toHaveLength(0);
    expect(proxy.stats().passedThrough).toBe(1);
  });

  it('forwards the caller auth header but never records it', async () => {
    const up = stubUpstream(EMBEDDING);
    const seen: NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
      onNetExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/embeddings`, { input: 'x' }, { authorization: 'Bearer sk-live-1' });

    expect(up.calls[0]!.headers['authorization']).toBe('Bearer sk-live-1');
    expect(JSON.stringify(seen[0])).not.toContain('sk-live-1');
    expect(seen[0]!.requestHeaders['authorization']).toBeUndefined();
  });

  it('sends it to the configured gateway when there is one', async () => {
    // Someone who pointed this run at a gateway pointed *all* of it there. Falling back to the
    // vendor default for the calls orca could not read would split one run across two origins.
    const up = stubUpstream(EMBEDDING);
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { anthropic: 'https://api.orcarouter.ai', openai: 'https://api.orcarouter.ai' },
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/embeddings`, { input: 'hello' });

    expect(up.calls[0]!.url).toBe('https://api.orcarouter.ai/v1/embeddings');
  });

  it('falls back to the origin the client itself was speaking to', async () => {
    // With nothing configured, orca owes the agent the destination it redirected away from. An
    // `anthropic-version` header is Anthropic's client announcing itself.
    const up = stubUpstream({ ok: true });
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/complete`, { prompt: 'x' }, { 'anthropic-version': '2023-06-01' });
    await post(`${proxy.url}/v1/embeddings`, { input: 'x' });

    expect(up.calls[0]!.url).toBe('https://api.anthropic.com/v1/complete');
    expect(up.calls[1]!.url).toBe('https://api.openai.com/v1/embeddings');
  });

  it('relays a non-200 rather than turning it into an orca error', async () => {
    const up = stubUpstream({ error: 'nope' }, 429);
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, { input: 'x' });
    expect(res.status).toBe(429);
  });

  it('still answers 404 to a GET, which no agent makes for a model call', async () => {
    // Passthrough exists so a POST orca cannot read still reaches its origin. Blind-forwarding
    // every method would make orca an open relay for whatever else is on the machine.
    const up = stubUpstream(EMBEDDING);
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
    });
    closers.push(proxy.close);

    const res = await fetch(`${proxy.url}/v1/models`);
    expect(res.status).toBe(404);
    expect(up.calls).toHaveLength(0);
  });
});

describe('replay mode — a path no dialect claims', () => {
  it('refuses honestly instead of reaching the network', async () => {
    const dead = (async () => {
      throw new Error('replay must not reach the network');
    }) as unknown as typeof fetch;
    const unmatched: { reason: string }[] = [];
    const proxy = await createProxy({
      mode: 'replay',
      exchanges: [],
      fetchImpl: dead,
      passthroughUpstream: 'https://api.openai.com',
      onUnmatched: (u) => void unmatched.push(u),
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, { input: 'hello' });

    expect(res.status).toBe(502);
    // The message has to say why, because "502" during a replay reads as orca being broken.
    expect(res.text).toContain('/v1/embeddings');
    expect(res.text.toLowerCase()).toContain('replay');
    expect(unmatched).toHaveLength(1);
    expect(proxy.stats().unmatched).toBe(1);
  });
});
