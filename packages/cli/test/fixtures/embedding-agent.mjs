#!/usr/bin/env node
/**
 * An agent that only embeds — the shape of an index build, for the capture-warning tests.
 *
 * Not contrived either. `scripts/build_kb.py` in IndexRAG makes exactly one kind of call, and it
 * is this one: a batch of texts to `/v1/embeddings`, no conversation anywhere. Before retrieval
 * had an answer, recording that printed `capture.empty exchanges=0 cause="the agent never called
 * the proxy — it may not read a base-URL variable"` over a run whose variable was set correctly
 * and whose every call orca had captured.
 */
const base = process.env.OPENAI_BASE_URL;
if (!base) {
  console.error('embedding-agent: OPENAI_BASE_URL is not set');
  process.exit(2);
}

const res = await fetch(`${base}/embeddings`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${process.env.OPENAI_API_KEY ?? 'test-key'}`,
  },
  body: JSON.stringify({ model: 'stub-embedding', input: ['one', 'two'] }),
});

if (!res.ok) {
  console.error(`embedding-agent: upstream ${res.status}: ${await res.text()}`);
  process.exit(3);
}

const body = await res.json();
console.log(`embedding-agent: embedded ${body.data?.length ?? 0} inputs`);
