import { afterEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/server.js';
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
