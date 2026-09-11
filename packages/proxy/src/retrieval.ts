import { createHash } from 'node:crypto';
import type { BatchRetrieval, RetrievalRule } from '@orcareplay/plugin-api';

/**
 * Retrieval calls: the half of a RAG run that is not a model exchange and is not opaque either.
 *
 * Orca's two existing answers to a POST were "a dialect reads it" and "forward it and record the
 * bytes". A retrieval stack falls between them. `/v1/embeddings` is no dialect's path — there is
 * no conversation in it, no tools, no stop reason, and translating it to the canonical request
 * shape would be a lie — so it took the second answer, and a recording of an indexing run could
 * be replayed only as far as its first embedding call, where strict replay answered 502.
 *
 * What makes the third answer possible is determinism. A chat completion is sampled; the same
 * request can come back different, which is why replay needs a matching ladder and why an inexact
 * match is an event. An embedding is a function: the same text and the same model give the same
 * vector. So a recorded retrieval call can be looked up by its own request and served back byte
 * for byte, with none of the ladder's machinery and none of its caveats.
 *
 * The fidelity numbers stay separate for the same reason. `exact=N` is a statement about a
 * matching ladder these calls never climb, and folding them in would make a recording look more
 * faithfully reproduced the more embeddings it happened to make. They get their own axis.
 */

/** How a recorded retrieval call is stored, and what that costs. */
export type RetrievalStore = 'full' | 'digest';

/**
 * One recorded retrieval call, rebuilt from a trace.
 *
 * The response bytes are the whole point: replay hands them back unchanged, so an index rebuilt
 * on replay is the index that was recorded rather than one that merely resembles it.
 */
export interface RecordedRetrieval {
  /** seq of the `net.request` this came from, for pointing back at the parent trace. */
  seq: number;
  /** Which rule claimed it. */
  rule: string;
  /** What a replay looks it up by. */
  key: string;
  path: string;
  status: number;
  contentType: string;
  /**
   * The request as it was sent. Needed only to reorder a batch — see {@link BatchRetrieval} —
   * and empty for a recording made before that existed, which simply cannot be reordered.
   */
  rawRequest: string;
  /** Empty when the run was recorded with `--retrieval-store=digest`. */
  rawResponse: string;
  /** Present when the body was not kept: enough to verify a match, not enough to serve one. */
  digest?: string;
  /** A second key that ignores batch order, when the rule that claimed this call offers one. */
  batchKey?: string;
}

/**
 * The default lookup key: a digest of the request body with every object key sorted.
 *
 * Sorted because JSON object order is not meaningful and two SDKs serialise the same call
 * differently — langchain sends `{input, model, encoding_format}`, a hand-written client sends
 * `{model, input}`, and a replay that hashed the bytes would call those two different questions.
 *
 * Everything else is kept. A rule may narrow this, but the default has to be the strict one:
 * dropping a field a provider actually honours — `dimensions`, `truncate`, `input_type` — would
 * serve the vectors for a different question and nothing downstream could tell.
 */
export function retrievalKey(raw: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(raw)))
    .digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** `n items` for a list, `1 item` for a bare string, nothing when the field is absent. */
function countOf(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return 1;
  return undefined;
}

function describeEmbedding(raw: unknown): string {
  const body = asRecord(raw);
  const n = countOf(body['input']);
  const model = typeof body['model'] === 'string' ? body['model'] : 'an unnamed model';
  return n === undefined ? model : `${n} input${n === 1 ? '' : 's'} to ${model}`;
}

function describeRerank(raw: unknown): string {
  const body = asRecord(raw);
  const n = countOf(body['documents']);
  const model = typeof body['model'] === 'string' ? body['model'] : 'an unnamed model';
  return n === undefined ? model : `${n} document${n === 1 ? '' : 's'} through ${model}`;
}

/** The `input` of an embeddings request as a list of strings, or nothing if it is not one. */
function embeddingInputs(raw: unknown): string[] | undefined {
  const input = asRecord(raw)['input'];
  if (!Array.isArray(input) || input.length < 2) return undefined;
  // Only text. An `input` of token-id arrays is a different call, and the positional argument
  // below is about texts being independent of one another — which integers in a row are not
  // obviously enough for orca to claim.
  return input.every((v) => typeof v === 'string') ? (input as string[]) : undefined;
}

/**
 * Reordering an embeddings batch, and the one thing that makes it exact rather than clever.
 *
 * The OpenAI embeddings API defines `data[i]` as the embedding of `input[i]` and puts that
 * correspondence in the body as `data[i].index`. An embedding is a function of its own text; the
 * texts beside it in the batch do not enter into it. So given the recorded texts, the recorded
 * vectors, and a live batch that is a permutation of those texts, there is exactly one correct
 * answer and this builds it.
 *
 * Everything that is not `data` is kept from the recording, `usage` included: the same texts cost
 * the same tokens whatever order they were sent in.
 *
 * Anything short of an exact permutation returns undefined and the replay halts. A batch with a
 * text the recording never embedded has no answer, and inventing one — reusing a neighbour, or
 * returning a shorter list — would put a wrong vector in an index and leave nothing to notice it.
 */
const embeddingBatch: BatchRetrieval = {
  key(raw) {
    const inputs = embeddingInputs(raw);
    if (inputs === undefined) return undefined;
    // The batch as a multiset. Sorted rather than hashed per item so that two batches with the
    // same texts in different orders — and only those — collide.
    return retrievalKey({ ...asRecord(raw), input: [...inputs].sort() });
  },

  reorder(recordedRequest, recordedResponse, liveRequest) {
    const recordedInputs = embeddingInputs(recordedRequest);
    const liveInputs = embeddingInputs(liveRequest);
    if (recordedInputs === undefined || liveInputs === undefined) return undefined;
    if (recordedInputs.length !== liveInputs.length) return undefined;

    let body: Record<string, unknown>;
    try {
      body = asRecord(JSON.parse(recordedResponse));
    } catch {
      return undefined;
    }
    const data = body['data'];
    if (!Array.isArray(data) || data.length !== recordedInputs.length) return undefined;

    // Text → the recorded items for it, in order. A queue rather than a single entry because a
    // batch may legitimately carry the same text twice, and both copies are owed an answer.
    const byText = new Map<string, unknown[]>();
    for (const item of data) {
      const at = asRecord(item)['index'];
      if (typeof at !== 'number' || !Number.isInteger(at)) return undefined;
      const text = recordedInputs[at];
      if (text === undefined) return undefined;
      const queue = byText.get(text);
      if (queue) queue.push(item);
      else byText.set(text, [item]);
    }

    const reordered: unknown[] = [];
    for (const [i, text] of liveInputs.entries()) {
      const item = byText.get(text)?.shift();
      if (item === undefined) return undefined;
      reordered.push({ ...asRecord(item), index: i });
    }
    return JSON.stringify({ ...body, data: reordered });
  },
};

/**
 * The endpoints orca claims as retrieval, by the shape of their path.
 *
 * Matched on the suffix rather than on `/v1/...`: a base URL rewritten through `/forward/` keeps
 * its version segment inside the encoded base, so what the client appends and what the proxy sees
 * is `/embeddings`. The same suffix is what an Ollama, a vLLM or a gateway mounts it under.
 *
 * Rerank is one rule, not one per vendor. Cohere, Jina and Voyage all answer `POST .../rerank`
 * with the same request shape, and nothing on a plaintext call says which of them the base URL
 * named — so three rules differing only by a vendor guess would mean two that can never fire.
 * The key is a digest of the request either way, which does not care whose endpoint it was.
 */
export function defaultRetrievalRules(): RetrievalRule[] {
  return [
    {
      id: 'openai-embeddings',
      matches: (path) => path.endsWith('/embeddings'),
      key: retrievalKey,
      describe: describeEmbedding,
      // Its API defines `data[i]` as the embedding of `input[i]` and says so in the body, which
      // is what makes reordering exact rather than a guess. See {@link embeddingBatch}.
      batch: embeddingBatch,
      forkable: false,
    },
    {
      // Cohere v2 and anything that copied it. Distinct from `/embeddings` — `'/v1/embeddings'`
      // does not end in `/embed`, so the two rules cannot both claim a path.
      id: 'cohere-embed',
      matches: (path) => path.endsWith('/embed'),
      key: retrievalKey,
      describe: describeEmbedding,
      // No `batch`: this response carries no per-item index, so nothing in it says which
      // embedding answers which text. Order-insensitive matching would have to assume the
      // correspondence, and an assumption here misfiles a vector in an index with nothing to
      // notice afterwards.
      forkable: false,
    },
    {
      id: 'rerank',
      matches: (path) => path.endsWith('/rerank'),
      key: retrievalKey,
      describe: describeRerank,
      forkable: false,
    },
  ];
}

/** The first rule that claims this endpoint, or nothing. */
export function selectRetrievalRule(
  rules: readonly RetrievalRule[],
  path: string,
  host?: string,
): RetrievalRule | undefined {
  return rules.find((rule) => {
    try {
      return rule.matches(path, host);
    } catch {
      // A third-party rule that throws is a rule that does not claim this path. The alternative
      // is one bad plugin taking down every retrieval call in the run.
      return false;
    }
  });
}

/**
 * Index recorded retrieval calls for replay lookup: by exact key, and by batch key where the rule
 * that claimed the call offered one.
 *
 * Two maps rather than one so the exact path stays exact. A byte-identical request is served the
 * recorded bytes with nothing rebuilt; only a request that misses falls through to the batch map,
 * where the answer is reassembled and the run says so.
 */
export function indexRetrievals(recorded: readonly RecordedRetrieval[]): RetrievalIndex {
  const byKey = new Map<string, RecordedRetrieval[]>();
  const byBatch = new Map<string, RecordedRetrieval[]>();
  for (const call of recorded) {
    push(byKey, call.key, call);
    if (call.batchKey !== undefined) push(byBatch, call.batchKey, call);
  }
  return { byKey, byBatch };
}

export interface RetrievalIndex {
  byKey: Map<string, RecordedRetrieval[]>;
  byBatch: Map<string, RecordedRetrieval[]>;
}

function push(into: Map<string, RecordedRetrieval[]>, key: string, call: RecordedRetrieval): void {
  const at = into.get(key);
  if (at) at.push(call);
  else into.set(key, [call]);
}

/** Drop a call from both maps once it has been served, so it can never be served twice. */
export function consume(index: RetrievalIndex, call: RecordedRetrieval): void {
  for (const [map, key] of [
    [index.byKey, call.key],
    [index.byBatch, call.batchKey],
  ] as const) {
    if (key === undefined) continue;
    const queue = map.get(key);
    if (queue === undefined) continue;
    const at = queue.indexOf(call);
    if (at !== -1) queue.splice(at, 1);
  }
}
