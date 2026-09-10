import { afterEach, describe, expect, it } from 'vitest';
import { createProxy, recordableOrigin, withoutCredentials } from '../src/server.js';
import { forwardBasePath } from '../src/forward.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/**
 * Who answered.
 *
 * A trace recorded what was sent and what came back and never where it went. That is the first
 * question asked of a recording that looks wrong, and it was unanswerable from the trace: a
 * gateway left behind in `~/.orca/config.json` redirects every run on the machine, and nothing in
 * the run said so. `orca record` prints the proxy it listens on — which is orca's address, not the
 * model's.
 *
 * It is recorded per exchange rather than once in the manifest because there is no single value to
 * put there. Four things decide the origin and three of them are per request:
 *
 *   - an explicit `--upstream-openai` / `--upstream-anthropic`
 *   - the gateway `orca setup` configured
 *   - a `/forward/` base the client announced, which outranks both on a live call
 *   - the dialect's vendor default
 *
 * and a fork that changes provider changes the answer again mid-run. A run can legitimately reach
 * two origins, so the trace has to be able to say so.
 */

function stubUpstream() {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ id: 'c1', choices: [{ message: { role: 'assistant', content: 'hi' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

const TURN = { model: 'gpt-5.2', messages: [{ role: 'user', content: 'hello' }] };

describe('the origin that answered is recorded on the exchange', () => {
  it('names the configured upstream', async () => {
    const up = stubUpstream();
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://api.orcarouter.ai' },
    });
    closers.push(proxy.close);

    expect(await post(`${proxy.url}/v1/chat/completions`, TURN)).toBe(200);
    expect(proxy.exchanges()[0]!.upstream).toBe('https://api.orcarouter.ai');
  });

  it("names the vendor's own API when nothing was configured", async () => {
    // The case that matters most for reading a trace later: absence has to mean "an older orca did
    // not record this", never "it went to the vendor". So the default is written down like any
    // other answer.
    const up = stubUpstream();
    const proxy = await createProxy({ mode: 'record', fetchImpl: up.fetchImpl });
    closers.push(proxy.close);

    expect(await post(`${proxy.url}/v1/chat/completions`, TURN)).toBe(200);
    expect(proxy.exchanges()[0]!.upstream).toBe('https://api.openai.com');
  });

  it('names the base a forwarded request announced, not the gateway it outranked', async () => {
    // A `/forward/` base outranks a configured gateway on a live call — the request says where it
    // was headed. The recorded origin has to follow the request that was actually made, or the
    // trace documents a decision the proxy did not take.
    const up = stubUpstream();
    const zen = 'https://opencode.ai/zen/go/v1';
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://api.orcarouter.ai' },
    });
    closers.push(proxy.close);

    expect(await post(`${proxy.url}${forwardBasePath(zen)}/chat/completions`, TURN)).toBe(200);
    expect(up.calls[0]).toBe(`${zen}/chat/completions`);
    expect(proxy.exchanges()[0]!.upstream).toBe(zen);
  });

  it('records what was actually fetched, on every one of those routes', async () => {
    // The assertion that keeps the field honest rather than merely present: whatever it says, the
    // request went there. A value copied from the configuration instead of from the resolved origin
    // would pass the three tests above and fail this one on the forwarded route.
    const up = stubUpstream();
    const zen = 'https://opencode.ai/zen/go/v1';
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://api.orcarouter.ai' },
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/chat/completions`, TURN);
    await post(`${proxy.url}${forwardBasePath(zen)}/chat/completions`, TURN);

    const recorded = proxy.exchanges().map((e) => e.upstream);
    expect(recorded).toEqual(['https://api.orcarouter.ai', zen]);
    // Two origins in one run, which is why this cannot live in the manifest as a single value.
    expect(up.calls.map((c) => new URL(c).origin)).toEqual([
      'https://api.orcarouter.ai',
      'https://opencode.ai',
    ]);
  });
});

/**
 * And it must not carry the gateway's credential into the trace along the way.
 *
 * `orca setup --gateway` accepts whatever URL it is handed, with no check that it is credential-
 * free, and stores it in `~/.orca/config.json`. A gateway that authenticates by URL rather than by
 * header is configured as `https://user:pw@gw.example` or `https://gw.example?key=…` — and from
 * then on every recording on that machine goes through it. Recording the origin verbatim wrote the
 * key into all of them.
 *
 * That is not a general worry about secrets; it breaks a promise this repository states outright,
 * where the gateway key is read (`config.ts`):
 *
 *   > the proxy adds it to the outbound request only, while what gets recorded is derived from the
 *   > *incoming* request with auth stripped, so a gateway key orca injects is invisible to the
 *   > recording by construction rather than by a rule someone has to remember.
 *
 * The irony is that the configured gateway is exactly the case the `upstream` field was added for
 * — "a gateway left behind in the config redirects every run and nothing says so" — so the
 * motivating scenario and the leaking scenario were the same one.
 *
 * The `/forward/` route was already guarded: `decodeForwardPath` refuses a base carrying userinfo
 * or a query. This is the configured route catching up.
 */
describe('the recorded origin carries no credential', () => {
  const SECRET = 'SUPERSECRET';

  for (const [what, gateway] of [
    ['userinfo', `https://myuser:${SECRET}@gateway.example.com`],
    ['a query token', `https://gateway.example.com?key=${SECRET}`],
    ['both', `https://u:${SECRET}@gateway.example.com/v1?key=${SECRET}&x=1#${SECRET}`],
  ] as const) {
    it(`strips ${what}`, async () => {
      const up = stubUpstream();
      const proxy = await createProxy({
        mode: 'record',
        fetchImpl: up.fetchImpl,
        upstream: { openai: gateway },
      });
      closers.push(proxy.close);

      expect(await post(`${proxy.url}/v1/chat/completions`, TURN)).toBe(200);

      // The whole exchange, not just the field: a secret that moved somewhere else is not fixed.
      expect(JSON.stringify(proxy.exchanges())).not.toContain(SECRET);
      // Still answers the question it exists to answer.
      expect(proxy.exchanges()[0]!.upstream).toContain('gateway.example.com');
    });
  }

  it('still sends the credential upstream, because that is how the request authenticates', async () => {
    // The stripping is about what is *kept*, never about what is sent. A fix that quietly stopped
    // authenticating would turn a leak into an outage.
    const up = stubUpstream();
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { openai: `https://gateway.example.com?key=${SECRET}` },
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/chat/completions`, TURN);
    expect(up.calls[0]).toContain(SECRET);
  });
});

describe('recordableOrigin', () => {
  it('keeps the base path, which is not a credential and is load-bearing', () => {
    // A gateway serving tenants at /team-a/v1 and /team-b/v1 answers from two different places,
    // and the exchange's own `path` is the client's (`/chat/completions`), not the upstream's base.
    // `new URL(x).origin` would have dropped this.
    expect(recordableOrigin('https://gw.example/team-a/v1')).toBe('https://gw.example/team-a/v1');
  });

  it('leaves an ordinary origin exactly as written', () => {
    // Including no trailing slash: `new URL(x).toString()` adds one, and a value that changes shape
    // is one that stops matching what a reader configured.
    expect(recordableOrigin('https://api.openai.com')).toBe('https://api.openai.com');
    expect(recordableOrigin('http://127.0.0.1:60571')).toBe('http://127.0.0.1:60571');
  });

  it('drops an origin it cannot parse rather than passing it through', () => {
    // It cannot be sanitised, and `absent` already means "not recorded".
    expect(recordableOrigin('not a url')).toBeUndefined();
    expect(recordableOrigin(undefined)).toBeUndefined();
  });
});

/**
 * The same class, in the places nobody composes: error text.
 *
 * Found by running the end-to-end check rather than by reading the code. A failed `fetch` reports
 * the URL it was handed, so a gateway configured with its key in the URL arrives inside the
 * exception string and goes to a terminal verbatim:
 *
 *     warn gateway.unreachable why="Request cannot be constructed from a URL that includes
 *       credentials: http://someone:PASSWORD@127.0.0.1:50164/v1/models"
 *
 * and, from the proxy, into a 500 body that the agent itself prints. Both predate the `upstream`
 * field; both are the same mistake, in prose instead of in a field.
 */
describe('withoutCredentials', () => {
  it('takes userinfo out of a URL inside an error message', () => {
    expect(
      withoutCredentials(
        'Request cannot be constructed from a URL that includes credentials: http://someone:PW@127.0.0.1:50164/v1/models',
      ),
    ).toBe(
      'Request cannot be constructed from a URL that includes credentials: http://127.0.0.1:50164/v1/models',
    );
  });

  it('takes the query too, since that is the other place a key rides', () => {
    expect(withoutCredentials('fetch failed: https://gw.example/v1/models?key=PW')).toBe(
      'fetch failed: https://gw.example/v1/models',
    );
  });

  it('leaves text with no URL in it alone', () => {
    expect(withoutCredentials('ECONNREFUSED 127.0.0.1:9')).toBe('ECONNREFUSED 127.0.0.1:9');
  });

  it('stops at the end of the URL rather than eating the rest of the sentence', () => {
    // A greedy pattern here would swallow the explanation that follows, turning a useful error
    // into a bare URL.
    expect(withoutCredentials('could not reach https://u:PW@gw.example — check the key')).toBe(
      'could not reach https://gw.example — check the key',
    );
  });
});
