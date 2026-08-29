/**
 * Live provider for anything OpenAI-shaped: OpenAI itself, OpenRouter, LiteLLM, vLLM, Ollama.
 *
 * The wire format is the contract, not the vendor, so the only knobs are `baseUrl`, the key, and
 * the id this provider answers to (which is what shows up in error messages and trace events).
 */

import type {
  CanonicalChunk,
  CanonicalRequest,
  ModelInfo,
  Money,
  Provider,
  Usage,
} from '@orcareplay/plugin-api';
import {
  OpenAiStreamAssembler,
  canonicalToOpenaiRequest,
  openaiToCanonicalResponse,
} from './translate/openai.js';
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

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_COMPATIBLE_ID = 'openai-compatible';

export interface OpenAiCompatibleProviderOptions extends ProviderRuntimeOptions {
  /** Provider id, so a gateway keeps its own name in traces and errors. */
  id?: string;
}

export class OpenAiCompatibleProvider implements Provider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleProviderOptions = {}) {
    this.id = options.id ?? OPENAI_COMPATIBLE_ID;
    this.baseUrl = options.baseUrl ?? OPENAI_DEFAULT_BASE_URL;
    this.apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this.extraHeaders = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async models(): Promise<ModelInfo[]> {
    const res = await this.fetchImpl(joinUrl(this.baseUrl, 'models'), {
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
    const body = canonicalToOpenaiRequest({ ...req, stream: true });
    // Without this, a streamed OpenAI response carries no usage at all and every turn costs $0.
    if (body['stream_options'] === undefined) body['stream_options'] = { include_usage: true };

    const res = await this.fetchImpl(joinUrl(this.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: this.headers('text/event-stream'),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await httpError(this.id, res);
    if (isJsonResponse(res)) {
      yield* syntheticChunks(openaiToCanonicalResponse(await (res.json() as Promise<unknown>)));
      return;
    }

    const assembler = new OpenAiStreamAssembler();
    for await (const text of streamText(res)) yield* assembler.push(text);
    yield* assembler.flush();
    yield { type: 'done', response: assembler.result() };
  }

  price(usage: Usage, model: string): Money | null {
    return priceFor(usage, model);
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept };
    // Local servers (Ollama, vLLM) take no key at all; sending an empty bearer breaks some of them.
    if (this.apiKey !== '') headers['authorization'] = `Bearer ${this.apiKey}`;
    return { ...headers, ...this.extraHeaders };
  }
}
