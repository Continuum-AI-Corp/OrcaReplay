import { afterEach, describe, expect, it } from 'vitest';
import type { NetExchange } from '../src/intercept.js';
import { createProxy } from '../src/server.js';
import {
  defaultRetrievalRules,
  retrievalKey,
  selectRetrievalRule,
  type RecordedRetrieval,
} from '../src/retrieval.js';
import { forwardBasePath } from '../src/forward.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/**
 * Retrieval calls: the half of a RAG run that is neither a model exchange nor opaque.
 *
 * Before this, a recording of an index build could be replayed exactly as far as its first
 * embedding call, where strict replay answered 502 — `reused=0/2 exit=1` on a recording that held
 * everything it needed. The reason the third answer works is determinism: the same text through
 * the same model gives the same vector, so a recorded call can be found by its own request
 * instead of by a position in a conversation it is not part of.
 */

const VECTORS = {
  object: 'list',
  data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
  model: 'text-embedding-3-small',
  usage: { prompt_tokens: 4, total_tokens: 4 },
};

function stubUpstream(reply: unknown, status = 200) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: String(init.body ?? '') });
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** What a recording of one embedding call looks like once it comes back off a trace. */
function recorded(body: unknown, over: Partial<RecordedRetrieval> = {}): RecordedRetrieval {
  const rule = defaultRetrievalRules()[0]!;
  const batchKey = rule.batch?.key(body);
  return {
    seq: 2,
    rule: 'openai-embeddings',
    key: retrievalKey(body),
    path: '/v1/embeddings',
    status: 200,
    contentType: 'application/json',
    rawRequest: JSON.stringify(body),
    rawResponse: JSON.stringify(VECTORS),
    ...(batchKey === undefined ? {} : { batchKey }),
    ...over,
  };
}

/** A recorded batch: `n` texts, each with a vector that names it, in the order they were sent. */
function batch(texts: string[]): { body: unknown; call: RecordedRetrieval } {
  const body = { model: 'text-embedding-3-small', input: texts };
  const response = {
    object: 'list',
    data: texts.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: [text.length, index],
      // Not part of the API — a marker so a test can see which text a vector came back for.
      probe: text,
    })),
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 40, total_tokens: 40 },
  };
  return { body, call: recorded(body, { rawResponse: JSON.stringify(response) }) };
}

describe('which endpoints are retrieval', () => {
  const rules = defaultRetrievalRules();

  it.each([
    ['/v1/embeddings', 'openai-embeddings'],
    // A base URL rewritten through /forward/ keeps its version segment inside the encoded base,
    // so what the proxy sees is what the client appended.
    ['/embeddings', 'openai-embeddings'],
    ['/v2/embed', 'cohere-embed'],
    ['/v1/rerank', 'rerank'],
    ['/rerank', 'rerank'],
  ])('claims %s as %s', (path, id) => {
    expect(selectRetrievalRule(rules, path)?.id).toBe(id);
  });

  it.each(['/v1/chat/completions', '/v1/messages', '/v1/responses', '/api/v2/index'])(
    'leaves %s alone',
    (path) => {
      expect(selectRetrievalRule(rules, path)).toBeUndefined();
    },
  );

  // `/v1/embeddings` does not end in `/embed`, so the two rules cannot both claim a path.
  it('does not let the embed rule swallow the embeddings endpoint', () => {
    expect(selectRetrievalRule(rules, '/v1/embeddings')?.id).toBe('openai-embeddings');
  });

  it('never offers to fork one', () => {
    // Changing the embedding model would change the vector space the index was built in. That is
    // a rebuild, not a fork, and the type says so rather than a comment somewhere.
    for (const rule of rules) expect(rule.forkable).toBe(false);
  });
});

describe('the lookup key', () => {
  it('ignores the order two SDKs happen to serialise the same call in', () => {
    expect(retrievalKey({ model: 'm', input: ['a'] })).toBe(
      retrievalKey({ input: ['a'], model: 'm' }),
    );
  });

  it('separates calls that differ in anything a provider honours', () => {
    const base = { model: 'm', input: ['a'] };
    expect(retrievalKey({ ...base, dimensions: 256 })).not.toBe(retrievalKey(base));
    expect(retrievalKey({ ...base, input: ['b'] })).not.toBe(retrievalKey(base));
    expect(retrievalKey({ ...base, model: 'other' })).not.toBe(retrievalKey(base));
  });
});

describe('recording a retrieval call', () => {
  it('forwards it and files it as a replayable net pair', async () => {
    const up = stubUpstream(VECTORS);
    const seen: NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
      onNetExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    const body = { model: 'text-embedding-3-small', input: ['hello'] };
    const res = await post(`${proxy.url}/v1/embeddings`, body);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual(VECTORS);
    expect(up.calls[0]!.url).toBe('https://api.openai.com/v1/embeddings');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.rule).toBe('openai-embeddings');
    // The presence of a key is the whole test for "this pair can be served again".
    expect(seen[0]!.replayKey).toBe(retrievalKey(body));
    expect(seen[0]!.responseBody).toBe(JSON.stringify(VECTORS));
    expect(seen[0]!.intercepted).toBe(false);
  });

  it('keeps only the digest under --retrieval-store=digest', async () => {
    const up = stubUpstream(VECTORS);
    const seen: NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
      retrievalStore: 'digest',
      onNetExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, { model: 'm', input: ['hello'] });

    // The agent still gets the real answer; it is the trace that keeps less.
    expect(JSON.parse(res.text)).toEqual(VECTORS);
    expect(seen[0]!.responseBody).toBe('');
    expect(seen[0]!.responseDigest).toMatch(/^[0-9a-f]{64}$/);
    // Dropped rather than trimmed: half a vector is not a smaller answer, it is a wrong one.
    expect(seen[0]!.responseBytes).toBe(Buffer.byteLength(JSON.stringify(VECTORS)));
  });

  it('still passes through a body it cannot key', async () => {
    const up = stubUpstream({ ok: true });
    const seen: NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
      onNetExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    const res = await fetch(`${proxy.url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });

    expect(res.status).toBe(200);
    expect(seen[0]!.replayKey).toBeUndefined();
  });

  it('sends it to the origin a forward path names', async () => {
    // The shape a RAG run has: chat at one origin, embeddings at another, and no `--upstream-*`
    // that can say so because both are the same wire dialect.
    const up = stubUpstream(VECTORS);
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://chat.example', anthropic: 'https://chat.example' },
    });
    closers.push(proxy.close);

    const base = forwardBasePath('https://maas.example/v1');
    await post(`${proxy.url}${base}/embeddings`, { model: 'm', input: ['x'] });

    expect(up.calls[0]!.url).toBe('https://maas.example/v1/embeddings');
  });
});

describe('replaying a retrieval call', () => {
  it('serves the recorded vectors back, byte for byte, with the network down', async () => {
    const body = { model: 'text-embedding-3-small', input: ['hello'] };
    const failingFetch = (async () => {
      throw new Error('the network is not available in a strict replay');
    }) as unknown as typeof fetch;
    const proxy = await createProxy({
      mode: 'replay',
      fetchImpl: failingFetch,
      retrievals: [recorded(body)],
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, body);

    expect(res.status).toBe(200);
    expect(res.text).toBe(JSON.stringify(VECTORS));
    expect(proxy.stats().retrievalServed).toBe(1);
    expect(proxy.stats().retrievalTotal).toBe(1);
    expect(proxy.stats().unmatched).toBe(0);
  });

  it('finds it whatever order the pipeline asks in', async () => {
    // A worker pool answers in whatever order the origin finished, so there is no cursor to
    // follow — and no need for one, since the answer is a function of the request.
    const bodies = [1, 2, 3].map((n) => ({ model: 'm', input: [`doc ${n}`] }));
    const proxy = await createProxy({
      mode: 'replay',
      retrievals: bodies.map((b, i) =>
        recorded(b, { rawResponse: JSON.stringify({ ...VECTORS, id: i }) }),
      ),
    });
    closers.push(proxy.close);

    for (const n of [2, 0, 1]) {
      const res = await post(`${proxy.url}/v1/embeddings`, bodies[n]!);
      expect(JSON.parse(res.text).id).toBe(n);
    }
    expect(proxy.stats().retrievalServed).toBe(3);
  });

  it('hands back both answers when the run asked the same thing twice', async () => {
    const body = { model: 'm', input: ['x'] };
    const proxy = await createProxy({
      mode: 'replay',
      retrievals: [
        recorded(body, { rawResponse: '{"n":1}' }),
        recorded(body, { rawResponse: '{"n":2}' }),
      ],
    });
    closers.push(proxy.close);

    expect((await post(`${proxy.url}/v1/embeddings`, body)).text).toBe('{"n":1}');
    expect((await post(`${proxy.url}/v1/embeddings`, body)).text).toBe('{"n":2}');
    expect(proxy.stats().retrievalServed).toBe(2);
  });

  it('halts with a reason when the recording has no answer for it', async () => {
    const proxy = await createProxy({
      mode: 'replay',
      retrievals: [recorded({ model: 'm', input: ['recorded'] })],
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, { model: 'm', input: ['never asked'] });

    expect(res.status).toBe(502);
    expect(res.text).toContain('no recorded retrieval call matches this request');
    expect(proxy.stats().unmatched).toBe(1);
  });

  it('says so plainly when the recording kept only a digest', async () => {
    const body = { model: 'm', input: ['x'] };
    const proxy = await createProxy({
      mode: 'replay',
      retrievals: [recorded(body, { rawResponse: '', digest: 'a'.repeat(64) })],
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, body);

    expect(res.status).toBe(502);
    expect(res.text).toContain('--retrieval-store=digest');
    expect(proxy.stats().retrievalServed).toBe(0);

    // And says the same thing on the retry. Clients retry a 502 — langchain does — and a
    // recorded call that was consumed without being served made the second attempt come back
    // "no recorded retrieval call matches this request", which is false and sends the reader
    // looking for a mismatch that does not exist.
    const again = await post(`${proxy.url}/v1/embeddings`, body);
    expect(again.text).toContain('--retrieval-store=digest');
  });

  it('goes live on an unmatched call under --loose', async () => {
    const up = stubUpstream(VECTORS);
    const proxy = await createProxy({
      mode: 'replay',
      loose: true,
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
      retrievals: [],
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, { model: 'm', input: ['new'] });

    expect(res.status).toBe(200);
    expect(proxy.stats().retrievalLive).toBe(1);
  });
});

/**
 * The batch a worker pool assembled in a different order.
 *
 * This is what an index build actually does: IndexRAG appends bridging facts to a list as the
 * thread pool completes them, so the same documents go into the same embedding call in a
 * different sequence on every run. Two replays of one real recording produced two different keys
 * and neither matched — the recording held exactly the right answers and could not find them.
 *
 * Reordering is exact here and nowhere else, because the API says so: the response carries
 * `data[i].index` and defines `data[i]` as the embedding of `input[i]`, so the vector recorded
 * for a text can be handed back against that text's new position with nothing assumed.
 */
describe('a batch whose order differs', () => {
  const TEXTS = ['alpha', 'beta', 'gamma', 'delta'];

  it('gives every text the vector that was recorded for it', async () => {
    const { call } = batch(TEXTS);
    const proxy = await createProxy({ mode: 'replay', retrievals: [call] });
    closers.push(proxy.close);

    const shuffled = ['gamma', 'alpha', 'delta', 'beta'];
    const res = await post(`${proxy.url}/v1/embeddings`, {
      model: 'text-embedding-3-small',
      input: shuffled,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    // Each item answers the text at its own position, and `index` is renumbered to match.
    expect(body.data.map((d: { probe: string }) => d.probe)).toEqual(shuffled);
    expect(body.data.map((d: { index: number }) => d.index)).toEqual([0, 1, 2, 3]);
    // Everything that is not `data` is the recording's: the same texts cost the same tokens.
    expect(body.usage).toEqual({ prompt_tokens: 40, total_tokens: 40 });
    expect(proxy.stats().retrievalServed).toBe(1);
    expect(proxy.stats().retrievalReordered).toBe(1);
  });

  it('serves the bytes untouched when the order did match', async () => {
    const { body, call } = batch(TEXTS);
    const proxy = await createProxy({ mode: 'replay', retrievals: [call] });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, body);

    expect(res.text).toBe(call.rawResponse);
    // The exact path stays exact: nothing was rebuilt, so nothing is counted as rebuilt.
    expect(proxy.stats().retrievalReordered).toBe(0);
    expect(proxy.stats().retrievalServed).toBe(1);
  });

  /**
   * A batch that is not a permutation has no answer, and filling the gap would put another
   * document's vector in the index with nothing downstream able to tell.
   */
  it('halts rather than guessing when a text was never embedded', async () => {
    const { call } = batch(TEXTS);
    const proxy = await createProxy({ mode: 'replay', retrievals: [call] });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, {
      model: 'text-embedding-3-small',
      input: ['gamma', 'alpha', 'delta', 'epsilon'],
    });

    expect(res.status).toBe(502);
    expect(proxy.stats().retrievalServed).toBe(0);
    expect(proxy.stats().unmatched).toBe(1);
  });

  it('halts when the batch is a different size', async () => {
    const { call } = batch(TEXTS);
    const proxy = await createProxy({ mode: 'replay', retrievals: [call] });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, {
      model: 'text-embedding-3-small',
      input: ['alpha', 'beta'],
    });
    expect(res.status).toBe(502);
  });

  it('does not cross a model boundary', async () => {
    // Same texts, different model: a different vector space, and not the same question.
    const { call } = batch(TEXTS);
    const proxy = await createProxy({ mode: 'replay', retrievals: [call] });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, {
      model: 'some-other-model',
      input: ['gamma', 'alpha', 'delta', 'beta'],
    });
    expect(res.status).toBe(502);
  });

  it('answers both copies when a batch carries the same text twice', async () => {
    const { call } = batch(['same', 'same', 'other']);
    const proxy = await createProxy({ mode: 'replay', retrievals: [call] });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, {
      model: 'text-embedding-3-small',
      input: ['other', 'same', 'same'],
    });
    const body = JSON.parse(res.text);
    expect(body.data.map((d: { probe: string }) => d.probe)).toEqual(['other', 'same', 'same']);
  });

  // A single input has no order to differ in, so there is nothing to reorder and no second key.
  it('does not offer a batch key for a one-item call', () => {
    const rule = defaultRetrievalRules()[0]!;
    expect(rule.batch?.key({ model: 'm', input: ['one'] })).toBeUndefined();
    expect(rule.batch?.key({ model: 'm', input: 'a bare string' })).toBeUndefined();
    // Token ids are a different call: integers in a row are not obviously independent of one
    // another the way texts are, so orca does not claim they are.
    expect(rule.batch?.key({ model: 'm', input: [[1, 2], [3]] })).toBeUndefined();
  });

  it('cannot reorder a recording made before batch keys existed', async () => {
    const { call } = batch(TEXTS);
    const proxy = await createProxy({
      mode: 'replay',
      retrievals: [{ ...call, batchKey: undefined, rawRequest: '' }],
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, {
      model: 'text-embedding-3-small',
      input: ['gamma', 'alpha', 'delta', 'beta'],
    });
    expect(res.status).toBe(502);
  });
});

describe('forking over a recorded index', () => {
  /**
   * The point of `forkable: false`. `orca replay <run> --from 3 --model claude-opus-5` asks a
   * different model the same questions over the same documents — so the chat turns go live and
   * every embedding is still answered from the recording. Re-embedding them would spend money to
   * recompute an identical value and leave the fork's index differing from its parent's.
   */
  it('keeps serving retrieval from the recording past the fork cursor', async () => {
    const body = { model: 'm', input: ['a paragraph'] };
    const up = stubUpstream(VECTORS);
    const proxy = await createProxy({
      mode: 'hybrid',
      forkAt: 0,
      forkModel: 'claude-opus-5',
      fetchImpl: up.fetchImpl,
      exchanges: [],
      retrievals: [recorded(body)],
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, body);

    expect(res.text).toBe(JSON.stringify(VECTORS));
    expect(proxy.stats().retrievalServed).toBe(1);
    // Nothing was asked of the network for it.
    expect(up.calls).toHaveLength(0);
  });

  it('goes live for a question the parent never asked', async () => {
    const up = stubUpstream(VECTORS);
    const proxy = await createProxy({
      mode: 'hybrid',
      forkAt: 0,
      fetchImpl: up.fetchImpl,
      passthroughUpstream: 'https://api.openai.com',
      exchanges: [],
      retrievals: [recorded({ model: 'm', input: ['recorded'] })],
    });
    closers.push(proxy.close);

    const res = await post(`${proxy.url}/v1/embeddings`, { model: 'm', input: ['brand new'] });

    expect(res.status).toBe(200);
    expect(proxy.stats().retrievalLive).toBe(1);
    expect(up.calls).toHaveLength(1);
  });
});

describe('what retrieval is not', () => {
  it('does not touch the chat path, which a dialect owns', async () => {
    const up = stubUpstream({
      id: 'chatcmpl-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      upstream: { openai: 'https://chat.example' },
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/chat/completions`, {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    // A model exchange, counted as one — not keyed bytes.
    expect(proxy.exchanges()).toHaveLength(1);
    expect(proxy.stats().retrievalServed).toBe(0);
  });

  it('is off entirely when the caller passes no rules', async () => {
    const up = stubUpstream(VECTORS);
    const seen: NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      fetchImpl: up.fetchImpl,
      retrievalRules: [],
      passthroughUpstream: 'https://api.openai.com',
      onNetExchange: (e) => void seen.push(e),
    });
    closers.push(proxy.close);

    await post(`${proxy.url}/v1/embeddings`, { model: 'm', input: ['x'] });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.replayKey).toBeUndefined();
  });
});
