/**
 * OpenAI Chat Completions <-> canonical IR.
 *
 * The load-bearing asymmetry is tool arguments: OpenAI sends a JSON *string*, canonical holds a
 * parsed *object*. Both directions round trip, including arguments the model truncated into
 * invalid JSON, which are kept under `_raw` rather than thrown away or thrown on.
 */

import type {
  CanonicalChunk,
  CanonicalContent,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalTool,
  StopReason,
  Usage,
} from '@orcareplay/plugin-api';
import { SseDecoder, frameJson, toChunks } from './sse.js';
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  omitUndefined,
  parseToolInput,
  stringifyToolInput,
  unknownKeys,
} from './util.js';

/** Unconsumed top-level request fields, parked verbatim. */
export const OPENAI_EXTRA = 'openai.extra';
/** The original tool definitions by name, so `strict` and vendor extras survive. */
export const OPENAI_TOOL_ORIGINALS = 'openai.tool_originals';
/** Which of `max_tokens` / `max_completion_tokens` the caller used. */
export const OPENAI_MAX_TOKENS_FIELD = 'openai.max_tokens_field';
/** Whether the system prompt arrived as role `system` or role `developer`. */
export const OPENAI_SYSTEM_ROLE = 'openai.system_role';

const REQUEST_KEYS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'tools',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'stop',
  'stream',
]);

// ---------------------------------------------------------------------------
// request: wire -> canonical
// ---------------------------------------------------------------------------

export function openaiToCanonicalRequest(body: unknown): CanonicalRequest {
  const src = asRecord(body);
  const metadata: Record<string, unknown> = {};

  const systemParts: string[] = [];
  let systemRole: string | undefined;
  const messages: CanonicalMessage[] = [];
  let toolBatch: CanonicalMessage | undefined;

  for (const raw of asArray(src['messages'])) {
    const msg = asRecord(raw);
    const role = asString(msg['role']) ?? 'user';
    if (role === 'system' || role === 'developer') {
      systemParts.push(flattenContent(msg['content']));
      systemRole ??= role;
      continue;
    }
    if (role === 'tool' || role === 'function') {
      const block: CanonicalContent = {
        type: 'tool_result',
        tool_use_id: asString(msg['tool_call_id']) ?? asString(msg['name']) ?? '',
        content: flattenContent(msg['content']),
      };
      // Anthropic wants every result for a turn in one user message; canonical follows suit.
      if (toolBatch) toolBatch.content.push(block);
      else {
        toolBatch = { role: 'user', content: [block] };
        messages.push(toolBatch);
      }
      continue;
    }
    toolBatch = undefined;
    messages.push(openaiMessageToCanonical(role, msg));
  }

  const toolsRaw = asArray(src['tools']);
  let tools: CanonicalTool[] | undefined;
  if (toolsRaw.length > 0) {
    const originals: Record<string, unknown> = {};
    tools = toolsRaw.map((raw) => {
      const tool = asRecord(raw);
      const fn = asRecord(tool['function']);
      const name = asString(fn['name']) ?? asString(tool['name']) ?? '';
      originals[name] = raw;
      return omitUndefined<CanonicalTool>({
        name,
        description: asString(fn['description']) ?? asString(tool['description']),
        input_schema: asRecord(fn['parameters'] ?? tool['parameters']),
      });
    });
    metadata[OPENAI_TOOL_ORIGINALS] = originals;
  }

  const maxCompletion = asNumber(src['max_completion_tokens']);
  const maxLegacy = asNumber(src['max_tokens']);
  if (maxCompletion !== undefined) metadata[OPENAI_MAX_TOKENS_FIELD] = 'max_completion_tokens';
  else if (maxLegacy !== undefined) metadata[OPENAI_MAX_TOKENS_FIELD] = 'max_tokens';
  if (systemRole !== undefined) metadata[OPENAI_SYSTEM_ROLE] = systemRole;

  const extra = unknownKeys(src, REQUEST_KEYS);
  if (extra) metadata[OPENAI_EXTRA] = extra;

  const stopRaw = src['stop'];
  const stop =
    typeof stopRaw === 'string'
      ? [stopRaw]
      : asArray(stopRaw).filter((s): s is string => typeof s === 'string');

  return omitUndefined<CanonicalRequest>({
    model: asString(src['model']) ?? '',
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages,
    tools,
    max_tokens: maxCompletion ?? maxLegacy,
    temperature: asNumber(src['temperature']),
    top_p: asNumber(src['top_p']),
    stop: stop.length > 0 ? stop : undefined,
    stream: asBoolean(src['stream']),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
}

function openaiMessageToCanonical(role: string, msg: Record<string, unknown>): CanonicalMessage {
  const content: CanonicalContent[] = [];
  const raw = msg['content'];
  if (typeof raw === 'string') {
    if (raw !== '') content.push({ type: 'text', text: raw });
  } else {
    for (const part of asArray(raw)) {
      const mapped = openaiPartToCanonical(part);
      if (mapped) content.push(mapped);
    }
  }
  for (const call of asArray(msg['tool_calls'])) {
    const tc = asRecord(call);
    const fn = asRecord(tc['function']);
    content.push({
      type: 'tool_use',
      id: asString(tc['id']) ?? '',
      name: asString(fn['name']) ?? '',
      input: parseToolInput(asString(fn['arguments']) ?? ''),
    });
  }
  return { role: role === 'assistant' ? 'assistant' : 'user', content };
}

function openaiPartToCanonical(raw: unknown): CanonicalContent | undefined {
  const part = asRecord(raw);
  const type = asString(part['type']);
  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    return { type: 'text', text: asString(part['text']) ?? '' };
  }
  if (type === 'image_url' || type === 'input_image') {
    const url = asString(asRecord(part['image_url'])['url']) ?? asString(part['image_url']) ?? '';
    return dataUrlToImage(url);
  }
  // Audio and other modalities have no canonical home; the raw bytes still hold them.
  return undefined;
}

function dataUrlToImage(url: string): CanonicalContent {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match) return { type: 'image', media_type: match[1] ?? '', data: match[2] ?? '' };
  return { type: 'image', media_type: '', data: url };
}

/** OpenAI message content may be a string or an array of parts; canonical text is a string. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return asArray(content)
    .map((part) => asString(asRecord(part)['text']) ?? '')
    .filter((text) => text !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// request: canonical -> wire
// ---------------------------------------------------------------------------

export function canonicalToOpenaiRequest(req: CanonicalRequest): Record<string, unknown> {
  const metadata = asRecord(req.metadata);
  const out: Record<string, unknown> = { ...asRecord(metadata[OPENAI_EXTRA]) };
  out['model'] = req.model;

  const messages: Record<string, unknown>[] = [];
  if (req.system !== undefined) {
    const role = asString(metadata[OPENAI_SYSTEM_ROLE]) ?? 'system';
    messages.push({ role, content: req.system });
  }
  for (const msg of req.messages) messages.push(...canonicalMessageToOpenai(msg));
  out['messages'] = messages;

  if (req.tools !== undefined) {
    const originals = asRecord(metadata[OPENAI_TOOL_ORIGINALS]);
    out['tools'] = req.tools.map((tool) => {
      const original = asRecord(originals[tool.name]);
      const base = { ...original };
      const fn = { ...asRecord(original['function']) };
      base['type'] = asString(original['type']) ?? 'function';
      fn['name'] = tool.name;
      if (tool.description === undefined) delete fn['description'];
      else fn['description'] = tool.description;
      const schema = tool.input_schema ?? {};
      if ('parameters' in fn || Object.keys(schema).length > 0) fn['parameters'] = schema;
      base['function'] = fn;
      return base;
    });
  }

  if (req.max_tokens !== undefined) {
    const field = asString(metadata[OPENAI_MAX_TOKENS_FIELD]) ?? 'max_tokens';
    out[field] = req.max_tokens;
  }
  if (req.temperature !== undefined) out['temperature'] = req.temperature;
  if (req.top_p !== undefined) out['top_p'] = req.top_p;
  if (req.stop !== undefined && req.stop.length > 0) out['stop'] = req.stop;
  if (req.stream !== undefined) out['stream'] = req.stream;
  return out;
}

/** One canonical message can become several OpenAI messages: tool results are their own turns. */
function canonicalMessageToOpenai(msg: CanonicalMessage): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const rest: CanonicalContent[] = [];
  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
    } else {
      rest.push(block);
    }
  }

  const toolCalls = rest
    .filter((b): b is Extract<CanonicalContent, { type: 'tool_use' }> => b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: stringifyToolInput(b.input) },
    }));
  const visible = rest.filter((b) => b.type === 'text' || b.type === 'image');
  const allText = visible.every((b) => b.type === 'text');

  if (msg.role === 'assistant') {
    if (visible.length === 0 && toolCalls.length === 0) return out;
    const text = visible
      .map((b) => (b.type === 'text' ? b.text : ''))
      .filter((t) => t !== '')
      .join('\n');
    const message: Record<string, unknown> = { role: 'assistant' };
    message['content'] = toolCalls.length > 0 && text === '' ? null : text;
    if (toolCalls.length > 0) message['tool_calls'] = toolCalls;
    out.push(message);
    return out;
  }

  if (visible.length > 0) {
    out.push({
      role: 'user',
      content: allText
        ? visible.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
        : visible.map(canonicalPartToOpenai),
    });
  }
  return out;
}

function canonicalPartToOpenai(block: CanonicalContent): Record<string, unknown> {
  if (block.type === 'image') {
    const url = /^https?:\/\//.test(block.data)
      ? block.data
      : `data:${block.media_type};base64,${block.data}`;
    return { type: 'image_url', image_url: { url } };
  }
  return { type: 'text', text: block.type === 'text' ? block.text : '' };
}

// ---------------------------------------------------------------------------
// response
// ---------------------------------------------------------------------------

export function openaiToCanonicalResponse(body: unknown): CanonicalResponse {
  const src = asRecord(body);
  const error = src['error'];
  if (error !== undefined && error !== null) {
    const err = asRecord(error);
    return {
      id: asString(src['id']) ?? '',
      model: asString(src['model']) ?? '',
      stop_reason: 'error',
      content: [{ type: 'text', text: asString(err['message']) ?? 'unknown provider error' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const choice = asRecord(asArray(src['choices'])[0]);
  const message = asRecord(choice['message']);
  const content: CanonicalContent[] = [];
  const reasoning = asString(message['reasoning_content']) ?? asString(message['reasoning']);
  if (reasoning !== undefined && reasoning !== '')
    content.push({ type: 'thinking', text: reasoning });
  const text = flattenContent(message['content']);
  if (text !== '') content.push({ type: 'text', text });
  for (const call of asArray(message['tool_calls'])) {
    const tc = asRecord(call);
    const fn = asRecord(tc['function']);
    content.push({
      type: 'tool_use',
      id: asString(tc['id']) ?? '',
      name: asString(fn['name']) ?? '',
      input: parseToolInput(asString(fn['arguments']) ?? ''),
    });
  }

  return {
    id: asString(src['id']) ?? '',
    model: asString(src['model']) ?? '',
    stop_reason: openaiStopReason(choice['finish_reason']),
    content,
    usage: openaiUsage(src['usage']),
  };
}

export function openaiStopReason(value: unknown): StopReason {
  switch (asString(value)) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      // `stop`, `content_filter`, null and anything added later: the turn is over and no tool
      // call is pending. OpenAI has no separate stop-sequence reason.
      return 'end_turn';
  }
}

export function openaiUsage(value: unknown): Usage {
  const u = asRecord(value);
  const prompt = asNumber(u['prompt_tokens']) ?? 0;
  const cached =
    asNumber(asRecord(u['prompt_tokens_details'])['cached_tokens']) ??
    asNumber(u['prompt_cache_hit_tokens']);
  return omitUndefined<Usage>({
    // OpenAI counts cached tokens inside prompt_tokens; Anthropic does not. Canonical follows
    // Anthropic, so cost math can add the cache tiers without double counting.
    input_tokens: Math.max(0, prompt - (cached ?? 0)),
    output_tokens: asNumber(u['completion_tokens']) ?? 0,
    cache_read_tokens: cached,
  });
}

// ---------------------------------------------------------------------------
// streaming
// ---------------------------------------------------------------------------

interface ToolCallState {
  id: string;
  name: string;
  args: string;
}

/** Incremental assembler for OpenAI-shaped SSE, shared by the recorder and the live provider. */
export class OpenAiStreamAssembler {
  private readonly decoder = new SseDecoder();
  private readonly calls = new Map<number, ToolCallState>();
  private id = '';
  private model = '';
  private text = '';
  private thinking = '';
  private stop: StopReason = 'end_turn';
  private usage: Usage = { input_tokens: 0, output_tokens: 0 };
  private errorText: string | undefined;

  push(chunk: string): CanonicalChunk[] {
    const out: CanonicalChunk[] = [];
    for (const frame of this.decoder.push(chunk)) this.handle(frameJson(frame), out);
    return out;
  }

  flush(): CanonicalChunk[] {
    const out: CanonicalChunk[] = [];
    for (const frame of this.decoder.flush()) this.handle(frameJson(frame), out);
    return out;
  }

  result(): CanonicalResponse {
    const content: CanonicalContent[] = [];
    if (this.thinking !== '') content.push({ type: 'thinking', text: this.thinking });
    if (this.text !== '') content.push({ type: 'text', text: this.text });
    for (const index of [...this.calls.keys()].sort((a, b) => a - b)) {
      const call = this.calls.get(index);
      if (!call) continue;
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: parseToolInput(call.args),
      });
    }
    if (this.errorText !== undefined) content.push({ type: 'text', text: this.errorText });
    return { id: this.id, model: this.model, stop_reason: this.stop, content, usage: this.usage };
  }

  private handle(data: Record<string, unknown> | undefined, out: CanonicalChunk[]): void {
    if (!data) return;
    const error = data['error'];
    if (error !== undefined && error !== null) {
      this.errorText = asString(asRecord(error)['message']) ?? 'unknown provider error';
      this.stop = 'error';
      return;
    }
    this.id = asString(data['id']) ?? this.id;
    this.model = asString(data['model']) ?? this.model;
    if (data['usage'] !== undefined && data['usage'] !== null)
      this.usage = openaiUsage(data['usage']);

    const choice = asRecord(asArray(data['choices'])[0]);
    if (choice['finish_reason'] !== undefined && choice['finish_reason'] !== null) {
      this.stop = openaiStopReason(choice['finish_reason']);
    }
    const delta = asRecord(choice['delta']);
    const text =
      typeof delta['content'] === 'string' ? delta['content'] : flattenContent(delta['content']);
    if (text !== '') {
      this.text += text;
      out.push({ type: 'text_delta', text });
    }
    const reasoning = asString(delta['reasoning_content']) ?? asString(delta['reasoning']);
    if (reasoning !== undefined) this.thinking += reasoning;

    for (const raw of asArray(delta['tool_calls'])) {
      const tc = asRecord(raw);
      const index = asNumber(tc['index']) ?? 0;
      const call = this.calls.get(index) ?? { id: '', name: '', args: '' };
      const fn = asRecord(tc['function']);
      call.id = asString(tc['id']) ?? call.id;
      call.name = asString(fn['name']) ?? call.name;
      const partial = asString(fn['arguments']) ?? '';
      call.args += partial;
      this.calls.set(index, call);
      out.push({ type: 'tool_use_delta', id: call.id, name: call.name, partial_json: partial });
    }
  }
}

/** Assemble a complete response from a recorded OpenAI-shaped SSE stream. */
export function parseOpenaiSse(chunks: string[] | string): CanonicalResponse {
  const assembler = new OpenAiStreamAssembler();
  for (const chunk of toChunks(chunks)) assembler.push(chunk);
  assembler.flush();
  return assembler.result();
}
