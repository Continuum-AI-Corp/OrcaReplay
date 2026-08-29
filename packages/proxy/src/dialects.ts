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
  /** Request path this dialect posts to, for a request translated *into* it. */
  requestPath: string;
  /**
   * Does this dialect serve the given model?
   *
   * Kept on the dialect rather than in a table in the proxy, for the same reason everything else
   * here is: the proxy is handed a list of dialects and knows nothing about which exist, so a
   * third party can add one without the routing needing to learn about it.
   */
  ownsModel(model: string): boolean;
  /** Build a wire request from the canonical form — the inbound half of a cross-provider fork. */
  fromCanonicalRequest(req: CanonicalRequest): unknown;
  /** Build a wire response the agent will accept — the outbound half. */
  fromCanonicalResponse(res: CanonicalResponse, streamed: boolean): string;
}

export function anthropicDialect(translators: {
  toCanonicalRequest: (raw: unknown) => CanonicalRequest;
  toCanonicalResponse: (raw: unknown) => CanonicalResponse;
  parseSse: (body: string) => CanonicalResponse;
  fromCanonicalRequest: (req: CanonicalRequest) => Record<string, unknown>;
  fromCanonicalResponse: (res: CanonicalResponse) => Record<string, unknown>;
  toSse: (res: CanonicalResponse) => string;
}): Dialect {
  return {
    id: 'anthropic',
    defaultUpstream: 'https://api.anthropic.com',
    requestPath: '/v1/messages',
    matches: (p) => p.startsWith('/v1/messages'),
    // Claude is the only family Anthropic serves, so the test is the name rather than a list that
    // would need editing every time a model ships.
    ownsModel: (m) => /^(?:.*\/)?claude[-.]/i.test(m.trim()),
    toCanonicalRequest: translators.toCanonicalRequest,
    toCanonicalResponse: translators.toCanonicalResponse,
    parseStream: translators.parseSse,
    withModel: (raw, model) => ({ ...(raw as Record<string, unknown>), model }),
    fromCanonicalRequest: translators.fromCanonicalRequest,
    fromCanonicalResponse: (res, streamed) =>
      streamed ? translators.toSse(res) : JSON.stringify(translators.fromCanonicalResponse(res)),
  };
}

export function openaiDialect(translators: {
  toCanonicalRequest: (raw: unknown) => CanonicalRequest;
  toCanonicalResponse: (raw: unknown) => CanonicalResponse;
  parseSse: (body: string) => CanonicalResponse;
  fromCanonicalRequest: (req: CanonicalRequest) => Record<string, unknown>;
  fromCanonicalResponse: (res: CanonicalResponse) => Record<string, unknown>;
  toSse: (res: CanonicalResponse) => string;
}): Dialect {
  return {
    id: 'openai',
    defaultUpstream: 'https://api.openai.com',
    requestPath: '/v1/chat/completions',
    // Agents reach chat completions through both /v1/chat/completions and /chat/completions
    // depending on how their SDK joins the base URL. Accept either rather than making the user
    // discover which one their harness picked.
    matches: (p) => p.endsWith('/chat/completions') || p.endsWith('/completions'),
    // Everything that is not Claude. The chat-completions shape is what GLM, Qwen, DeepSeek and
    // every gateway speak, so it is the right default rather than a list of known vendors — an
    // unknown model reaches an OpenAI-compatible endpoint, which is where an unknown model lives.
    ownsModel: (m) => !/^(?:.*\/)?claude[-.]/i.test(m.trim()),
    toCanonicalRequest: translators.toCanonicalRequest,
    toCanonicalResponse: translators.toCanonicalResponse,
    parseStream: translators.parseSse,
    withModel: (raw, model) => ({ ...(raw as Record<string, unknown>), model }),
    fromCanonicalRequest: translators.fromCanonicalRequest,
    fromCanonicalResponse: (res, streamed) =>
      streamed ? translators.toSse(res) : JSON.stringify(translators.fromCanonicalResponse(res)),
  };
}

export function selectDialect(dialects: Dialect[], path: string): Dialect | undefined {
  return dialects.find((d) => d.matches(path));
}
