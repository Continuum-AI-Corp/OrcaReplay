import type { CanonicalRequest, CanonicalResponse } from '@orcareplay/plugin-api';

/**
 * A wire dialect the proxy can sit in front of.
 *
 * The proxy deliberately does not know which dialects exist — it is handed a list. That is what
 * lets a third party support a new model API without touching the interception core, and it keeps
 * all wire-format knowledge in @orcareplay/providers where it belongs.
 */
export interface Dialect {
  id: string;
  /** Does this dialect own the given request path? */
  matches(path: string): boolean;
  /** Upstream origin to forward to when no override is configured. */
  defaultUpstream: string;
  toCanonicalRequest(raw: unknown): CanonicalRequest;
  toCanonicalResponse(raw: unknown): CanonicalResponse;
  /** Parse a recorded SSE body into a response, for streamed exchanges. */
  parseStream(body: string): CanonicalResponse;
  /** Rewrite the model on a raw request body, for fork replay onto a different model. */
  withModel(raw: unknown, model: string): unknown;
}

export function anthropicDialect(translators: {
  toCanonicalRequest: (raw: unknown) => CanonicalRequest;
  toCanonicalResponse: (raw: unknown) => CanonicalResponse;
  parseSse: (body: string) => CanonicalResponse;
}): Dialect {
  return {
    id: 'anthropic',
    defaultUpstream: 'https://api.anthropic.com',
    matches: (p) => p.startsWith('/v1/messages'),
    toCanonicalRequest: translators.toCanonicalRequest,
    toCanonicalResponse: translators.toCanonicalResponse,
    parseStream: translators.parseSse,
    withModel: (raw, model) => ({ ...(raw as Record<string, unknown>), model }),
  };
}

export function openaiDialect(translators: {
  toCanonicalRequest: (raw: unknown) => CanonicalRequest;
  toCanonicalResponse: (raw: unknown) => CanonicalResponse;
  parseSse: (body: string) => CanonicalResponse;
}): Dialect {
  return {
    id: 'openai',
    defaultUpstream: 'https://api.openai.com',
    // Agents reach chat completions through both /v1/chat/completions and /chat/completions
    // depending on how their SDK joins the base URL. Accept either rather than making the user
    // discover which one their harness picked.
    matches: (p) => p.endsWith('/chat/completions') || p.endsWith('/completions'),
    toCanonicalRequest: translators.toCanonicalRequest,
    toCanonicalResponse: translators.toCanonicalResponse,
    parseStream: translators.parseSse,
    withModel: (raw, model) => ({ ...(raw as Record<string, unknown>), model }),
  };
}

export function selectDialect(dialects: Dialect[], path: string): Dialect | undefined {
  return dialects.find((d) => d.matches(path));
}
