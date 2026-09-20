import { afterEach, describe, expect, it } from 'vitest';
import type { NetExchange } from '../src/intercept.js';
import { createProxy, defaultDialects } from '../src/server.js';
import { selectDialect } from '../src/dialects.js';

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

describe('an upstream that never answers', () => {
  /**
   * The failure this locks out.
   *
   * `fetchPinned` refuses every redirect on purpose — undici strips `authorization` across origins
   * but not `x-api-key`, so following one could hand a gateway's key to whoever the `Location`
   * names. The refusal is a throw, and the throw used to leave `passThrough` before it recorded
   * anything: the agent got its 500, the operator saw nothing, and the trace said the run made
   * fewer calls than it did.
   *
   * Found on a real gateway. `api.orcarouter.ai` sits behind a CDN that answers an unknown API path
   * with `301` to its own marketing site, and MiniMax Code posts to `/v1/responses/input_tokens`
   * before every call — so every recording of that harness through that gateway lost two requests
   * and said nothing. The same run against a gateway answering `404` recorded them: eighteen events
   * against four, which is how it was isolated.
   */
  it('records the call it could not forward, rather than dropping it', async () => {
    const seen: NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      upstream: { openai: 'https://gateway.example' },
      fetchImpl: (async () => {
        throw new Error(
          'https://gateway.example/v1/responses/input_tokens answered 301 redirecting to ' +
            'https://www.example. orca does not follow it: your key is in this request.',
        );
      }) as unknown as typeof fetch,
      onNetExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/responses/input_tokens`, { input: 'count me' });

    // The agent still learns it failed — that part was already right.
    expect(res.status).toBe(500);

    expect(seen).toHaveLength(1);
    // `status: 0` means the same thing it means for an intercepted exchange: no response header was
    // ever seen. A `404` here would claim the origin answered.
    expect(seen[0]!.status).toBe(0);
    expect(seen[0]!.path).toBe('/v1/responses/input_tokens');
    expect(seen[0]!.requestBody).toContain('count me');
    // The reason, so the trace answers "why is there no response" without a rerun.
    expect(seen[0]!.responseBody).toContain('orca did not forward this call');
    expect(seen[0]!.responseBody).toContain('301');
  });

  it('keeps the credential out of the recorded host, whatever shape the origin is', async () => {
    // Caught in review twice. The reason was scrubbed and the `host` beside it was not, so an
    // origin `new URL` rejects went into the trace whole — `persistNetExchange` files `host` as a
    // `net.request` attr. The first fix reached for `withoutCredentials`, which is written for
    // prose: its scheme-less rule needs a dotted host and its userinfo rule cannot cross a space,
    // so four of these six still leaked. The first version of this test used only the dotted
    // shape, which is exactly why that survived a commit meant to close it.
    //
    // The trace's own redactor is no backstop: `hunter2` and `SECRET123` are under its
    // 20-character entropy floor and match no shape rule.
    //
    // This is the one path where the fallback runs at all — everywhere else it is reached only
    // after a response came back, which means undici parsed the URL. `createProxy` does not
    // validate origins; only the CLI does, through `unusableOrigin`.
    for (const [origin, secret] of [
      ['https://myuser:hunter2@gw bad', 'hunter2'],
      ['https://myuser:hunter2@', 'hunter2'],
      ['https://myuser:hun ter2@gw', 'hun ter2'],
      ['gateway.example?key=SECRET123', 'SECRET123'],
      ['gw?key=SECRET123', 'SECRET123'],
      ['localhost?key=SECRET123', 'SECRET123'],
      ['192.168.0.1?key=SECRET123', 'SECRET123'],
    ] as const) {
      const seen: NetExchange[] = [];
      const proxy = await createProxy({
        mode: 'record',
        upstream: { openai: origin },
        onNetExchange: (e) => void seen.push(e),
      });
      closers.push(proxy.close);

      await post(`${proxy.url}/v1/responses/input_tokens`, { input: 'x' });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.host, `host for ${origin}`).not.toContain(secret);
      // The reason travels in the same event and quotes the request, so it carries the origin too.
      expect(seen[0]!.responseBody, `reason for ${origin}`).not.toContain(secret);
      // Still says which upstream failed, or the event is no use to whoever reads the trace.
      expect(seen[0]!.host.length).toBeGreaterThan(0);
    }
  });

  it('keeps the credential out of the recorded reason', async () => {
    // The message names the request that failed, and that message reaches both the agent and the
    // trace. A gateway error quoting the call can quote the key with it.
    const seen: NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      upstream: { openai: 'https://gateway.example' },
      fetchImpl: (async () => {
        throw new Error('refused: authorization: Bearer sk-live-must-not-be-written-down');
      }) as unknown as typeof fetch,
      onNetExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/responses/input_tokens`, { input: 'x' });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.responseBody).not.toContain('sk-live-must-not-be-written-down');
  });
});

describe('Anthropic path boundary', () => {
  it.each(['/v1/messages', '/anthropic/v1/messages', '/coding/v1/messages'])(
    'recognizes the versioned Anthropic endpoint %s',
    (path) => {
      expect(selectDialect(defaultDialects(), path)?.id).toBe('anthropic');
    },
  );
});

describe('record mode — a path no dialect claims', () => {
  it.each([
    {
      path: '/api/v2/chat/messages',
      body: { model: 'gpt-5.2', messages: [{ role: 'user', content: 'hello' }] },
    },
    { path: '/v3/conversations/messages', body: { text: 'hello', channel: 'fixture' } },
  ])('does not reroute or promote unrelated $path traffic to Anthropic', async ({ path, body }) => {
    const up = stubUpstream({ ok: true });
    const seen: NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://openai.test', anthropic: 'https://anthropic.test' },
      passthroughUpstream: 'https://original.test',
      onNetExchange: (exchange) => void seen.push(exchange),
    });
    closers.push(proxy.close);

    const response = await post(`${proxy.url}${path}`, body);

    expect(response.status).toBe(200);
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.url).toBe(`https://original.test${path}`);
    expect(up.calls[0]!.body).toBe(JSON.stringify(body));
    expect(proxy.exchanges()).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      host: 'original.test',
      path,
      requestBody: JSON.stringify(body),
    });
    expect(proxy.stats().passedThrough).toBe(1);
  });

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

  /**
   * A run whose two origins disagree still sends each call to one of them.
   *
   * The shape that found this: a machine with a gateway in `~/.orca/config.json` and a single
   * `--upstream-openai <stub>` on the command line. `resolveUpstream` fills the openai keys from
   * the flag and `anthropic` from the gateway, so the configured set has two values, the
   * one-value shortcut does not fire, and the old code went straight to the vendor default —
   * `https://api.openai.com`, which is neither of the two the operator named, reached with the
   * agent's own credential on it. Every embedding call in a recorded retrieval run bypassed the
   * gateway that was the whole point of configuring one.
   */
  it('sends it to the origin configured for its own family, not a vendor default', async () => {
    const up = stubUpstream(EMBEDDING);
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: {
        anthropic: 'https://gw.example',
        openai: 'https://stub.example',
        'openai-responses': 'https://stub.example',
      },
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/embeddings`, { input: 'hello' });
    await post(`${proxy.url}/v1/complete`, { prompt: 'x' }, { 'anthropic-version': '2023-06-01' });

    expect(up.calls[0]!.url).toBe('https://stub.example/v1/embeddings');
    expect(up.calls[1]!.url).toBe('https://gw.example/v1/complete');
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

describe('a fork — hybrid mode — meets a path no dialect claims', () => {
  it('forwards it, because a fork runs a live agent', async () => {
    // Refusing here reintroduced the exact failure passthrough exists to prevent, one mode over:
    // the fork dies on the first call orca cannot read. `record` and `hybrid` both run an agent
    // against the network; only strict replay has nothing to forward to.
    const up = stubUpstream(EMBEDDING);
    const proxy = await createProxy({
      mode: 'hybrid',
      exchanges: [],
      forkAt: 0,
      forkModel: 'gpt-5.2-mini',
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, { input: 'hello' });

    expect(res.status).toBe(200);
    expect(up.calls[0]!.url).toBe('https://api.openai.com/v1/embeddings');
    expect(proxy.stats().passedThrough).toBe(1);
  });
});

describe('the method guard', () => {
  it('refuses a non-POST on a dialect path instead of forwarding it upstream', async () => {
    // Only a POST is ever a model call. A guard of `!dialect && method !== 'POST'` let a PUT on
    // /v1/chat/completions reach the live path, where it was forwarded to the provider and
    // recorded as a model exchange.
    const up = stubUpstream(EMBEDDING);
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.2', messages: [] }),
    });

    expect(res.status).toBe(404);
    expect(up.calls).toHaveLength(0);
    expect(proxy.exchanges()).toHaveLength(0);
  });

  it('answers a GET on a dialect path honestly, naming the method', async () => {
    // It came back as a 400 about unreadable JSON, which sends someone looking at their request
    // body for a problem that is in their verb.
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: stubUpstream(EMBEDDING).fetchImpl,
    });
    closers.push(proxy.close);

    const res = await fetch(`${proxy.url}/v1/messages`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('GET');
  });
});

describe('passthrough carries the credentials a gateway needs', () => {
  it('attaches upstreamHeaders, as the live model path does', async () => {
    // Without them a configured gateway saw only the agent's own key — often the obviously-fake
    // `orca-recorded` placeholder — and answered 401 for a reason nothing in the trace explained.
    const up = stubUpstream(EMBEDDING);
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { anthropic: 'https://gw.example', openai: 'https://gw.example' },
      upstreamHeaders: { authorization: 'Bearer sk-gateway-key' },
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/embeddings`, { input: 'hello' });

    expect(up.calls[0]!.headers['authorization']).toBe('Bearer sk-gateway-key');
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
