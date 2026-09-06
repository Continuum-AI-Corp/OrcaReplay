import { afterEach, describe, expect, it } from 'vitest';
import type { NetExchange } from '../src/intercept.js';
import { createProxy } from '../src/server.js';
import { decodeForwardPath, forwardBasePath } from '../src/forward.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/**
 * A `/forward/` path is how an adapter hands the proxy a request whose real destination orca
 * rewrote away: the harness's base URL was pointed here with the true base encoded into the path,
 * so every request arrives naming where it was headed. The assertions are about restoring that
 * faithfully — same bytes, same path, same wire shape — and about the prefix never firing on a
 * path that merely looks like one.
 */

const ZEN_GO = 'https://opencode.ai/zen/go/v1';

describe('decodeForwardPath', () => {
  it('decodes an encoded base and keeps the appended path', () => {
    const decoded = decodeForwardPath(`${forwardBasePath(ZEN_GO)}/chat/completions`);
    expect(decoded).toEqual({ base: ZEN_GO, path: '/chat/completions' });
  });

  it('decodes a base with no appended path to the root', () => {
    expect(decodeForwardPath(forwardBasePath('https://api.example.com'))).toEqual({
      base: 'https://api.example.com',
      path: '/',
    });
  });

  it('strips a trailing slash from the base', () => {
    const decoded = decodeForwardPath(`${forwardBasePath(`${ZEN_GO}/`)}/chat/completions`);
    expect(decoded?.base).toBe(ZEN_GO);
  });

  it('refuses a path that only begins with the prefix', () => {
    expect(decodeForwardPath('/forward/plain')).toBeUndefined();
    expect(decodeForwardPath('/forward/https%3A%2F%2F')).toBeUndefined();
    expect(decodeForwardPath('/forward/%E0%A4%A')).toBeUndefined();
    expect(decodeForwardPath('/forward/a%2Fb/v1/embeddings')).toBeUndefined();
  });

  it('refuses anything that is not a bare http(s) base', () => {
    expect(decodeForwardPath(forwardBasePath('ftp://opencode.ai/x'))).toBeUndefined();
    expect(
      decodeForwardPath(forwardBasePath('https://user:pw@opencode.ai/zen/go/v1')),
    ).toBeUndefined();
    expect(decodeForwardPath(forwardBasePath('https://opencode.ai/x?key=1'))).toBeUndefined();
    expect(decodeForwardPath(forwardBasePath('https://opencode.ai/x#frag'))).toBeUndefined();
  });
});

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

const TURN = {
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('record mode — a forwarded origin', () => {
  it('forwards to the base the request named and records the real path', async () => {
    const up = stubUpstream({
      id: 'c1',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
    });
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`, TURN);

    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe(`${ZEN_GO}/chat/completions`);
    const exchange = proxy.exchanges()[0]!;
    expect(exchange.dialect).toBe('openai');
    expect(exchange.path).toBe('/chat/completions');
    expect(exchange.canonicalRequest.model).toBe('glm-5.3-flash');
  });

  it('keeps the caller auth header upstream and out of the trace', async () => {
    const up = stubUpstream({ id: 'c1', choices: [] });
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`, TURN, {
      authorization: 'Bearer sk-live-9',
    });

    expect(up.calls[0]!.headers['authorization']).toBe('Bearer sk-live-9');
    expect(JSON.stringify(proxy.exchanges()[0])).not.toContain('sk-live-9');
  });

  it('outranks a configured gateway on a live call, because the request names its own destination', async () => {
    // A gateway picked up from `orca setup` is a default for calls orca would otherwise have to
    // guess at. A forwarded request announces where it was headed — and the recorded run that
    // exposed this answered every turn with the gateway's website 404 page, because
    // `https://gateway/chat/completions` is not an API path anything serves.
    const up = stubUpstream({ id: 'c1', choices: [] });
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://api.orcarouter.ai' },
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`, TURN);

    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe(`${ZEN_GO}/chat/completions`);
  });

  it('does not carry a gateway key to the destination the request named', async () => {
    // `upstreamHeaders` are the gateway's credential. Attaching them to every outbound call used
    // to be harmless because every outbound call went to the gateway; with forwarded requests
    // going to their own origin, it would hand a third party a key they were never meant to see.
    const up = stubUpstream({ id: 'c1', choices: [] });
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://api.orcarouter.ai' },
      upstreamHeaders: { authorization: 'Bearer sk-gateway-key' },
      upstreamHeadersOrigin: 'https://api.orcarouter.ai',
    });
    closers.push(proxy.close);

    await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`, TURN);

    expect(up.calls[0]!.url).toBe(`${ZEN_GO}/chat/completions`);
    expect(up.calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('normalizes the path for an origin orca chose, so a gateway sees its version segment', async () => {
    // A bare base url (no `/v1`) reaches this proxy as `/chat/completions`; a gateway handed that
    // without the version segment answers 404. The dialect's own path is what an origin orca
    // picked expects — which is also what an env-redirected request already carries.
    const up = stubUpstream({ id: 'c1', choices: [] });
    const proxy = await createProxy({
      mode: 'hybrid',
      exchanges: [],
      forkAt: 0,
      forkModel: 'gpt-5.6-luna',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://api.orcarouter.ai' },
      upstreamHeaders: { authorization: 'Bearer sk-gateway-key' },
      upstreamHeadersOrigin: 'https://api.orcarouter.ai',
    });
    closers.push(proxy.close);

    await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`, {
      ...TURN,
      model: 'glm-5.3-flash',
    });

    expect(up.calls[0]!.url).toBe('https://api.orcarouter.ai/v1/chat/completions');
    expect(up.calls[0]!.headers['authorization']).toBe('Bearer sk-gateway-key');
  });

  it('sends an unclaimed tail through passthrough to the forwarded base, past a configured gateway', async () => {
    const up = stubUpstream({ object: 'list', data: [] });
    const seen: NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      onNetExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/v1/embeddings`, {
      input: 'hello',
    });

    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe(`${ZEN_GO}/v1/embeddings`);
    expect(seen[0]).toMatchObject({ host: 'opencode.ai', path: '/v1/embeddings', status: 200 });
    expect(proxy.stats().passedThrough).toBe(1);
  });

  it('lets a configured gateway have an unclaimed tail on a fork, where the fork decides', async () => {
    // Substituting the model is the operator choosing where answers come from, so the fork's
    // configured origin decides for an unclaimed tail too.
    const up = stubUpstream({ object: 'list', data: [] });
    const proxy = await createProxy({
      mode: 'hybrid',
      exchanges: [],
      forkAt: 0,
      forkModel: 'gpt-5.6-luna',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://api.orcarouter.ai' },
    });
    closers.push(proxy.close);

    await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/v1/embeddings`, { input: 'hello' });

    expect(up.calls[0]!.url).toBe('https://api.orcarouter.ai/v1/embeddings');
  });

  it('treats an undecodable /forward/ path as an ordinary unclaimed path', async () => {
    const up = stubUpstream({ ok: true });
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/forward/plain`, { input: 'x' });

    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe('https://api.openai.com/forward/plain');
  });

  it('answers 404 to a GET on a forwarded path, as to any other', async () => {
    const up = stubUpstream({ ok: true });
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    const res = await fetch(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('GET');
    expect(up.calls).toHaveLength(0);
  });
});

describe('a cross-provider fork drops the forwarded base', () => {
  it('serves the fork target from its own origin, not the recorded one', async () => {
    // Forking an OpenAI-compatible recording onto a Claude model means the answer comes from
    // api.anthropic.com; the forwarded base pointed at the recorded provider and is incoherent
    // for the translation. The explicit upstream or the target default decides instead.
    const up = stubUpstream({
      id: 'm1',
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const proxy = await createProxy({
      mode: 'hybrid',
      exchanges: [],
      forkAt: 0,
      forkModel: 'claude-opus-5',
      fetchImpl: up.fetchImpl,
    });
    closers.push(proxy.close);

    await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`, TURN);

    expect(up.calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('replay — a forwarded path is matched, not forwarded', () => {
  it('serves a matching exchange from the recording', async () => {
    // Recorded through the same forward path, so the fixture is an exchange the proxy itself
    // built — the matcher compares canonical forms, and a hand-written one is a test of the
    // author's memory of the translator.
    const reply = { id: 'c1', choices: [{ message: { role: 'assistant', content: 'recorded' } }] };
    const recorder = stubUpstream(reply);
    const record = await createProxy({ mode: 'record', fetchImpl: recorder.fetchImpl });
    closers.push(record.close);
    await post(`${record.url}${forwardBasePath(ZEN_GO)}/chat/completions`, TURN);

    const up = stubUpstream({ id: 'live', choices: [] });
    const proxy = await createProxy({
      mode: 'replay',
      exchanges: record.exchanges(),
      fetchImpl: up.fetchImpl,
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}${forwardBasePath(ZEN_GO)}/chat/completions`, TURN);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).choices[0].message.content).toBe('recorded');
    expect(up.calls).toHaveLength(0);
    expect(proxy.stats().matchedExact).toBe(1);
  });
});
