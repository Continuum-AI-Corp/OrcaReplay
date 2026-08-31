import type {
  CanonicalContent,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalTool,
  StopReason,
} from '@orcareplay/plugin-api';

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

/**
 * The Codex CLI's subscription transport is an OpenAI Responses-shaped endpoint, but it is not
 * the public `/v1/responses` API: it lives at `/backend-api/codex/responses`, sends zstd-compressed
 * JSON and returns a Responses SSE stream. Keeping this dialect here lets the proxy replay the
 * bytes exactly while still using the normal canonical matcher and trace timeline.
 */
export function codexDialect(): Dialect {
  return {
    id: 'codex',
    defaultUpstream: 'https://chatgpt.com',
    requestPath: '/backend-api/codex/responses',
    matches: (p) => p === '/backend-api/codex/responses',
    // Only Codex subscription model ids belong here. Generic GPT names must continue to route to
    // the public OpenAI dialect when a fork changes an ordinary provider request.
    ownsModel: (model) => /^gpt-5\.6-(?:sol|terra|luna)$/i.test(model.trim()),
    toCanonicalRequest: codexToCanonicalRequest,
    toCanonicalResponse: codexToCanonicalResponse,
    parseStream: parseCodexSse,
    withModel: (raw, model) => ({ ...(raw as Record<string, unknown>), model }),
    fromCanonicalRequest: canonicalToCodexRequest,
    fromCanonicalResponse: (res, streamed) =>
      streamed ? canonicalToCodexSse(res) : JSON.stringify(canonicalToCodexResponse(res)),
  };
}

function codexToCanonicalRequest(raw: unknown): CanonicalRequest {
  const src = asRecord(raw);
  const systemParts: string[] = [];
  const messages: CanonicalMessage[] = [];
  const input = src['input'];
  const items = Array.isArray(input) ? input : input === undefined ? [] : [input];
  for (const item of items) {
    const value = asRecord(item);
    const type = asString(value['type']);
    if (type === 'function_call_output') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: asString(value['call_id']) ?? '',
            content: stringifyText(value['output']),
          },
        ],
      });
      continue;
    }
    if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: asString(value['call_id']) ?? '',
            name: asString(value['name']) ?? '',
            input: parseJson(asString(value['arguments']) ?? '{}'),
          },
        ],
      });
      continue;
    }
    const role = asString(value['role']) ?? 'user';
    const content = codexContent(value['content'] ?? value['text']);
    if (role === 'system' || role === 'developer') {
      const text = content
        .filter(
          (block): block is Extract<CanonicalContent, { type: 'text' }> => block.type === 'text',
        )
        .map((block) => block.text)
        .join('\n');
      if (text) systemParts.push(text);
    } else {
      messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content });
    }
  }
  if (typeof input === 'string')
    messages.push({ role: 'user', content: [{ type: 'text', text: input }] });

  const tools = codexTools(src['tools']);
  return omitUndefined({
    model: asString(src['model']) ?? '',
    system:
      asString(src['instructions']) ?? (systemParts.length ? systemParts.join('\n\n') : undefined),
    messages,
    tools: tools.length ? tools : undefined,
    max_tokens: asNumber(src['max_output_tokens']),
    temperature: asNumber(src['temperature']),
    top_p: asNumber(src['top_p']),
    stream: src['stream'] === true,
  });
}

function codexToCanonicalResponse(raw: unknown): CanonicalResponse {
  return codexResponse(asRecord(asRecord(raw)['response'] ?? raw), []);
}

function parseCodexSse(body: string): CanonicalResponse {
  let response: Record<string, unknown> = {};
  const deltas: string[] = [];
  const output: unknown[] = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    const event = asRecord(parseJson(data));
    const type = asString(event['type']);
    if (
      type === 'response.created' ||
      type === 'response.completed' ||
      type === 'response.in_progress'
    ) {
      response = asRecord(event['response']);
    } else if (type === 'response.output_text.delta') {
      const delta = asString(event['delta']);
      if (delta) deltas.push(delta);
    } else if (type === 'response.output_item.done') {
      output.push(asRecord(event['item']));
    }
  }
  return codexResponse(response, deltas, output);
}

function codexResponse(
  response: Record<string, unknown>,
  deltas: string[],
  streamedOutput: unknown[] = [],
): CanonicalResponse {
  const content: CanonicalContent[] = [];
  const output = streamedOutput.length
    ? streamedOutput
    : Array.isArray(response['output'])
      ? response['output']
      : [];
  for (const raw of output) {
    const item = asRecord(raw);
    const type = asString(item['type']);
    if (type === 'function_call') {
      content.push({
        type: 'tool_use',
        id: asString(item['call_id']) ?? '',
        name: asString(item['name']) ?? '',
        input: parseJson(asString(item['arguments']) ?? '{}'),
      });
    } else if (type === 'message') {
      content.push(...codexContent(item['content']));
    }
  }
  if (deltas.length) content.unshift({ type: 'text', text: deltas.join('') });
  const usage = asRecord(response['usage']);
  const status = asString(response['status']);
  const stop_reason: StopReason =
    status === 'incomplete' ? 'max_tokens' : status === 'failed' ? 'error' : 'end_turn';
  return {
    id: asString(response['id']) ?? 'codex-response',
    model: asString(response['model']) ?? '',
    stop_reason,
    content,
    usage: {
      input_tokens: asNumber(usage['input_tokens']) ?? 0,
      output_tokens: asNumber(usage['output_tokens']) ?? 0,
    },
  };
}

function codexContent(raw: unknown): CanonicalContent[] {
  if (typeof raw === 'string') return raw ? [{ type: 'text', text: raw }] : [];
  const out: CanonicalContent[] = [];
  for (const part of Array.isArray(raw) ? raw : []) {
    const value = asRecord(part);
    const type = asString(value['type']);
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      out.push({ type: 'text', text: asString(value['text']) ?? '' });
    } else if (type === 'reasoning') {
      out.push({ type: 'thinking', text: asString(value['summary']) ?? '' });
    }
  }
  return out;
}

function codexTools(raw: unknown): CanonicalTool[] {
  const out: CanonicalTool[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const value = asRecord(item);
    if (asString(value['type']) !== 'function') continue;
    const parameters = asRecord(value['parameters'] ?? value['input_schema']);
    const name = asString(value['name']);
    if (name)
      out.push({ name, description: asString(value['description']), input_schema: parameters });
  }
  return out;
}

function canonicalToCodexRequest(req: CanonicalRequest): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  for (const message of req.messages) {
    const blocks = message.content.filter((block) => block.type === 'text');
    if (blocks.length) {
      input.push({
        type: 'message',
        role: message.role,
        content: blocks.map((block) => ({
          type: 'input_text',
          text: block.type === 'text' ? block.text : '',
        })),
      });
    }
  }
  return {
    model: req.model,
    ...(req.system === undefined ? {} : { instructions: req.system }),
    input,
    ...(req.tools === undefined
      ? {}
      : { tools: req.tools.map((tool) => ({ type: 'function', ...tool })) }),
    ...(req.max_tokens === undefined ? {} : { max_output_tokens: req.max_tokens }),
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.top_p === undefined ? {} : { top_p: req.top_p }),
    ...(req.stream === undefined ? {} : { stream: req.stream }),
  };
}

function canonicalToCodexResponse(res: CanonicalResponse): Record<string, unknown> {
  return {
    id: res.id,
    object: 'response',
    model: res.model,
    status: 'completed',
    output: res.content,
  };
}

function canonicalToCodexSse(res: CanonicalResponse): string {
  return `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: canonicalToCodexResponse(res) })}\n\n`;
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function asString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

function asNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function stringifyText(raw: unknown): string {
  return typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const [key, item] of Object.entries(value)) if (item === undefined) delete value[key];
  return value;
}

export function selectDialect(dialects: Dialect[], path: string): Dialect | undefined {
  return dialects.find((d) => d.matches(path));
}
