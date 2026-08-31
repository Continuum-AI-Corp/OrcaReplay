import { afterEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/server.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/**
 * A request body the proxy cannot parse.
 *
 * Record mode parsed the body unguarded, so anything malformed reached the server's catch-all and
 * came back as `500 {"error":{"message":"SyntaxError: Unexpected end of JSON input"}}`. To whoever
 * is running the agent that reads as orca falling over, and it sends them to orca's issue tracker
 * with a stack trace instead of to the one line of their own harness that sent an empty body.
 * Replay already answered 400 with a real message; record should too.
 */
const upstream = (async () =>
  new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

async function post(url: string, body: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { status: res.status, text: await res.text() };
}

describe('record mode — a body the dialect cannot read', () => {
  for (const [label, body] of [
    ['an empty body', ''],
    ['truncated JSON', '{"model":"gpt-5.2","inp'],
    ['not JSON at all', 'hello'],
  ] as const) {
    it(`answers 400 rather than 500 for ${label}`, async () => {
      const proxy = await createProxy({ mode: 'record', fetchImpl: upstream });
      closers.push(proxy.close);

      const res = await post(`${proxy.url}/v1/responses`, body);

      expect(res.status).toBe(400);
      // Name the path, so the operator can find the call in their own code.
      expect(res.text).toContain('/v1/responses');
    });
  }

  it('does not forward an unparseable body upstream', async () => {
    let called = 0;
    const counting = (async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const proxy = await createProxy({ mode: 'record', fetchImpl: counting });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/responses`, '');

    expect(called).toBe(0);
  });

  it('records nothing for a request it could not read', async () => {
    const proxy = await createProxy({ mode: 'record', fetchImpl: upstream });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/responses`, '');

    expect(proxy.exchanges()).toHaveLength(0);
  });
});
