import { afterEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/server.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/**
 * Headers that describe *this* connection and must not be relayed onto the next one.
 *
 * The list held four names and was missing `transfer-encoding`, which is the one that actually
 * bites. An SDK that hands `fetch` a `Request` rather than a URL string sends its body chunked —
 * the Vercel AI SDK and every wrapper like it do — and the proxy copied `transfer-encoding:
 * chunked` onto an outbound call that had already buffered the body. undici rejects that, so the
 * agent got `500 {"error":{"message":"TypeError: fetch failed"}}` on any turn with a streamed
 * body. Nothing in the message points at a header, or at orca, or at the agent.
 */
const BODY = {
  model: 'gpt-5.2',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
};

const REPLY = {
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  model: 'gpt-5.2',
  output: [
    { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
  ],
  usage: { input_tokens: 1, output_tokens: 1 },
};

function stubUpstream() {
  const calls: { headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ headers, body: String(init.body ?? '') });
    return new Response(JSON.stringify(REPLY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('a request whose body arrives chunked', () => {
  /**
   * A stream body, which is what makes Node send `transfer-encoding: chunked` and no
   * `content-length`. An SDK reaches this shape by handing `fetch` a `Request` built from another
   * `Request` — which is exactly what the instrument hook does when it rewrites one.
   */
  const chunked = (url: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-keep-me': 'yes' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(BODY)));
          controller.close();
        },
      }),
      // Required by Node whenever a body is a stream.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

  it('is answered, not turned into a 500', async () => {
    const up = stubUpstream();
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    const res = await chunked(`${proxy.url}/v1/responses`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPLY);
  });

  it('does not relay transfer-encoding onto a call that already has the whole body', async () => {
    const up = stubUpstream();
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    await chunked(`${proxy.url}/v1/responses`);

    expect(up.calls).toHaveLength(1);
    for (const name of ['transfer-encoding', 'connection', 'host', 'content-length']) {
      expect(up.calls[0]!.headers[name], name).toBeUndefined();
    }
    // The body really did arrive, so the header was the only thing dropped.
    expect(up.calls[0]!.body).toContain('hello');
  });

  it('keeps the headers that are not about this connection', async () => {
    const up = stubUpstream();
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    await chunked(`${proxy.url}/v1/responses`);

    expect(up.calls[0]!.headers['x-keep-me']).toBe('yes');
    expect(up.calls[0]!.headers['content-type']).toContain('application/json');
  });

  it('records the exchange, so a chunked turn is not silently missing from the trace', async () => {
    const up = stubUpstream();
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    await chunked(`${proxy.url}/v1/responses`);

    expect(proxy.exchanges()).toHaveLength(1);
    expect(proxy.exchanges()[0]!.canonicalRequest.model).toBe('gpt-5.2');
  });
});
