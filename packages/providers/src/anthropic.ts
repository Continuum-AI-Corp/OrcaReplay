/** Live Anthropic Messages API provider. Streams, and hands back canonical chunks. */

import type {
  CanonicalChunk,
  CanonicalRequest,
  ModelInfo,
  Money,
  Provider,
  Usage,
} from '@orcareplay/plugin-api';
import {
  AnthropicStreamAssembler,
  anthropicToCanonicalResponse,
  canonicalToAnthropicRequest,
} from './translate/anthropic.js';
import { asArray, asRecord, asString } from './translate/util.js';
import {
  httpError,
  isJsonResponse,
  joinUrl,
  streamText,
  syntheticChunks,
  type ProviderRuntimeOptions,
} from './http.js';
import { modelInfoFor, priceFor } from './pricing.js';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
/** The Messages API rejects a request without max_tokens; canonical treats it as optional. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

export type AnthropicProviderOptions = ProviderRuntimeOptions;

export class AnthropicProvider implements Provider {
  readonly id: string = 'anthropic';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL;
    this.apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
    this.extraHeaders = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async models(): Promise<ModelInfo[]> {
    const res = await this.fetchImpl(joinUrl(this.baseUrl, 'v1/models'), {
      method: 'GET',
      headers: this.headers('application/json'),
    });
    if (!res.ok) throw await httpError(this.id, res);
    const body = asRecord(await (res.json() as Promise<unknown>));
    return asArray(body['data']).map((raw) => {
      const id = asString(asRecord(raw)['id']) ?? '';
      return modelInfoFor(id) ?? { id };
    });
  }

  async *invoke(req: CanonicalRequest, signal?: AbortSignal): AsyncGenerator<CanonicalChunk> {
    if (this.apiKey === '') {
      throw new Error(
        'anthropic: no API key. Pass { apiKey } when creating the provider or set ANTHROPIC_API_KEY.',
      );
    }
    const body = canonicalToAnthropicRequest({
      ...req,
      max_tokens: req.max_tokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      stream: true,
    });
    const res = await this.fetchImpl(joinUrl(this.baseUrl, 'v1/messages'), {
      method: 'POST',
      headers: this.headers('text/event-stream'),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await httpError(this.id, res);
    if (isJsonResponse(res)) {
      yield* syntheticChunks(anthropicToCanonicalResponse(await (res.json() as Promise<unknown>)));
      return;
    }

    const assembler = new AnthropicStreamAssembler();
    for await (const text of streamText(res)) yield* assembler.push(text);
    yield* assembler.flush();
    yield { type: 'done', response: assembler.result() };
  }

  price(usage: Usage, model: string): Money | null {
    return priceFor(usage, model);
  }

  private headers(accept: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept,
      'anthropic-version': ANTHROPIC_VERSION,
      'x-api-key': this.apiKey,
      ...this.extraHeaders,
    };
  }
}
