/**
 * The small amount of HTTP every provider needs: URL joining, streamed decoding, and errors that
 * say what went wrong and what to do about it.
 *
 * `fetch` is injected rather than imported so that tests, the recording proxy and a gateway can
 * all substitute their own transport. Nothing here reaches the network on its own.
 */

import type { CanonicalChunk, CanonicalResponse, ProviderOptions } from '@orcareplay/plugin-api';
import { asRecord, asString, stringifyToolInput } from './translate/util.js';

export interface ProviderRuntimeOptions extends ProviderOptions {
  /** Transport override. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Decode a streamed response body as text, whichever stream flavour the transport hands back. */
export async function* streamText(res: Response): AsyncGenerator<string> {
  const body: unknown = res.body;
  if (body === null || body === undefined) {
    const text = await res.text();
    if (text !== '') yield text;
    return;
  }
  const decoder = new TextDecoder();
  const iterable = body as Partial<AsyncIterable<Uint8Array>>;
  if (typeof iterable[Symbol.asyncIterator] === 'function') {
    for await (const part of body as AsyncIterable<Uint8Array>) {
      const text = decoder.decode(part, { stream: true });
      if (text !== '') yield text;
    }
  } else {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text !== '') yield text;
    }
  }
  const tail = decoder.decode();
  if (tail !== '') yield tail;
}

/**
 * Build the error for a non-2xx response. The status alone is not actionable, so this pulls the
 * provider's own message out of either dialect's error envelope and appends the usual remedy.
 */
export async function httpError(providerId: string, res: Response): Promise<Error> {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    raw = '';
  }
  let detail = raw.slice(0, 400).trim();
  try {
    const body = asRecord(JSON.parse(raw));
    const error = asRecord(body['error']);
    const message = asString(error['message']) ?? asString(body['message']);
    const kind = asString(error['type']) ?? asString(body['type']);
    if (message !== undefined) detail = kind ? `${kind}: ${message}` : message;
  } catch {
    // Gateways and load balancers answer with HTML; the truncated body is the best detail there is.
  }
  const status = res.statusText ? `${res.status} ${res.statusText}` : String(res.status);
  const hint = remedy(res.status);
  return new Error(
    `${providerId}: HTTP ${status}${detail === '' ? '' : ` — ${detail}`}${hint === '' ? '' : ` (${hint})`}`,
  );
}

function remedy(status: number): string {
  if (status === 401 || status === 403) return 'check the api key and its permissions';
  if (status === 404) return 'check baseUrl and the model id';
  if (status === 413) return 'the request is too large; fork from an earlier checkpoint';
  if (status === 429) return 'rate limited: retry with backoff or lower concurrency';
  if (status >= 500) return 'provider side failure: retry, or replay from the trace instead';
  return 'check the request body against the provider docs';
}

/** True when a server answered a stream request with one whole JSON body instead. */
export function isJsonResponse(res: Response): boolean {
  const contentType = res.headers.get('content-type') ?? '';
  return !contentType.includes('event-stream') && contentType.includes('json');
}

/**
 * Replay an already-complete response as the chunk sequence a stream would have produced.
 *
 * Gateways and local servers quietly ignore `stream: true` more often than anyone would like.
 * Yielding nothing in that case looks exactly like a model that said nothing, which is the worst
 * possible failure for a debugger.
 */
export function* syntheticChunks(response: CanonicalResponse): Generator<CanonicalChunk> {
  for (const block of response.content) {
    if (block.type === 'text' && block.text !== '') {
      yield { type: 'text_delta', text: block.text };
    } else if (block.type === 'tool_use') {
      yield {
        type: 'tool_use_delta',
        id: block.id,
        name: block.name,
        partial_json: stringifyToolInput(block.input),
      };
    }
  }
  yield { type: 'done', response };
}
