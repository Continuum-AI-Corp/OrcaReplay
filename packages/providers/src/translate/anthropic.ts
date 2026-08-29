/**
 * Anthropic Messages API <-> canonical IR.
 *
 * Lossless for the round trip that matters: an intercepted request body converted to canonical and
 * back must be byte-equivalent enough to re-send. Fields the canonical IR has no room for
 * (`top_k`, `tool_choice`, `thinking`, per-tool `cache_control`, block-form system prompts) are
 * parked under namespaced `metadata` keys and restored on the way out. Canonical values always
 * win over the parked originals, so a fork that edits the system prompt is not silently ignored.
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
  unknownKeys,
} from './util.js';

/** Unconsumed top-level request fields, parked verbatim. */
export const ANTHROPIC_EXTRA = 'anthropic.extra';
/** The original block-form system prompt, so `cache_control` survives the round trip. */
export const ANTHROPIC_SYSTEM_BLOCKS = 'anthropic.system_blocks';
/** The original tool definitions by name, so server tools and `cache_control` survive. */
export const ANTHROPIC_TOOL_ORIGINALS = 'anthropic.tool_originals';

const REQUEST_KEYS: ReadonlySet<string> = new Set([
  'model',
  'system',
  'messages',
  'tools',
  'max_tokens',
  'temperature',
  'top_p',
  'stop_sequences',
  'stream',
]);

const STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'tool_use',
  'max_tokens',
  'stop_sequence',
]);

// ---------------------------------------------------------------------------
// request: wire -> canonical
// ---------------------------------------------------------------------------

export function anthropicToCanonicalRequest(body: unknown): CanonicalRequest {
  const src = asRecord(body);
  const metadata: Record<string, unknown> = {};

  const systemRaw = src['system'];
  let system: string | undefined;
  if (typeof systemRaw === 'string') {
    system = systemRaw;
  } else if (Array.isArray(systemRaw)) {
    system = systemRaw
      .map((block) => asString(asRecord(block)['text']) ?? '')
      .filter((text) => text !== '')
      .join('\n\n');
    metadata[ANTHROPIC_SYSTEM_BLOCKS] = systemRaw;
  }

  const toolsRaw = asArray(src['tools']);
  let tools: CanonicalTool[] | undefined;
  if (toolsRaw.length > 0) {
    const originals: Record<string, unknown> = {};
    tools = toolsRaw.map((raw) => {
      const t = asRecord(raw);
      const name = asString(t['name']) ?? '';
      originals[name] = raw;
      return omitUndefined<CanonicalTool>({
        name,
        description: asString(t['description']),
        input_schema: asRecord(t['input_schema']),
      });
    });
    metadata[ANTHROPIC_TOOL_ORIGINALS] = originals;
  }

  const extra = unknownKeys(src, REQUEST_KEYS);
  if (extra) metadata[ANTHROPIC_EXTRA] = extra;

  const stop = asArray(src['stop_sequences']).filter((s): s is string => typeof s === 'string');

  return omitUndefined<CanonicalRequest>({
    model: asString(src['model']) ?? '',
    system,
    messages: asArray(src['messages']).map(anthropicMessageToCanonical),
    tools,
    max_tokens: asNumber(src['max_tokens']),
    temperature: asNumber(src['temperature']),
    top_p: asNumber(src['top_p']),
    stop: stop.length > 0 ? stop : undefined,
    stream: asBoolean(src['stream']),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
}

function anthropicMessageToCanonical(raw: unknown): CanonicalMessage {
  const msg = asRecord(raw);
  const role = asString(msg['role']) === 'assistant' ? 'assistant' : 'user';
  const content = msg['content'];
  if (typeof content === 'string') return { role, content: [{ type: 'text', text: content }] };
  const blocks: CanonicalContent[] = [];
  for (const block of asArray(content)) {
    const mapped = anthropicBlockToCanonical(block);
    if (mapped) blocks.push(mapped);
  }
  return { role, content: blocks };
}

export function anthropicBlockToCanonical(raw: unknown): CanonicalContent | undefined {
  const block = asRecord(raw);
  switch (asString(block['type'])) {
    case 'text':
      return { type: 'text', text: asString(block['text']) ?? '' };
    case 'thinking':
      return { type: 'thinking', text: asString(block['thinking']) ?? '' };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: asString(block['id']) ?? '',
        name: asString(block['name']) ?? '',
        input: block['input'] ?? {},
      };
    case 'tool_result':
      return omitUndefined<CanonicalContent>({
        type: 'tool_result',
        tool_use_id: asString(block['tool_use_id']) ?? '',
        content: flattenToolResultContent(block['content']),
        is_error: asBoolean(block['is_error']),
      });
    case 'image': {
      const source = asRecord(block['source']);
      const url = asString(source['url']);
      return {
        type: 'image',
        media_type: asString(source['media_type']) ?? '',
        data: url ?? asString(source['data']) ?? '',
      };
    }
    default: {
      // An unfamiliar block with readable text is worth keeping; anything else (for example
      // `redacted_thinking`) has no canonical home and stays only in the recorded raw bytes.
      const text = asString(block['text']);
      return text === undefined ? undefined : { type: 'text', text };
    }
  }
}

/** Anthropic allows a tool_result body to be a string or a block array; canonical wants a string. */
function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return asArray(content)
    .map((block) => asString(asRecord(block)['text']) ?? '')
    .filter((text) => text !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// request: canonical -> wire
// ---------------------------------------------------------------------------

export function canonicalToAnthropicRequest(req: CanonicalRequest): Record<string, unknown> {
  const metadata = asRecord(req.metadata);
  const out: Record<string, unknown> = { ...asRecord(metadata[ANTHROPIC_EXTRA]) };

  out['model'] = req.model;
  out['messages'] = req.messages.map(canonicalMessageToAnthropic);

  if (req.system !== undefined) {
    const blocks = metadata[ANTHROPIC_SYSTEM_BLOCKS];
    // Only restore the block form when nobody edited the canonical text under it.
    const joined = Array.isArray(blocks)
      ? blocks
          .map((b) => asString(asRecord(b)['text']) ?? '')
          .filter((t) => t !== '')
          .join('\n\n')
      : undefined;
    out['system'] = joined === req.system ? blocks : req.system;
  }

  if (req.tools !== undefined) {
    const originals = asRecord(metadata[ANTHROPIC_TOOL_ORIGINALS]);
    out['tools'] = req.tools.map((tool) => {
      const base = { ...asRecord(originals[tool.name]) };
      base['name'] = tool.name;
      if (tool.description === undefined) delete base['description'];
      else base['description'] = tool.description;
      const hadSchema = 'input_schema' in base;
      const schema = tool.input_schema ?? {};
      if (hadSchema || Object.keys(schema).length > 0) base['input_schema'] = schema;
      return base;
    });
  }

  if (req.max_tokens !== undefined) out['max_tokens'] = req.max_tokens;
  if (req.temperature !== undefined) out['temperature'] = req.temperature;
  if (req.top_p !== undefined) out['top_p'] = req.top_p;
  if (req.stop !== undefined && req.stop.length > 0) out['stop_sequences'] = req.stop;
  if (req.stream !== undefined) out['stream'] = req.stream;
  return out;
}

function canonicalMessageToAnthropic(msg: CanonicalMessage): Record<string, unknown> {
  return {
    role: msg.role,
    content: msg.content.map(canonicalBlockToAnthropic),
  };
}

export function canonicalBlockToAnthropic(block: CanonicalContent): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      // The `signature` Anthropic requires when replaying a thinking block is not representable
      // in the canonical IR; replay the raw bytes when a turn used extended thinking.
      return { type: 'thinking', thinking: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return omitUndefined({
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      });
    case 'image':
      return /^https?:\/\//.test(block.data)
        ? { type: 'image', source: { type: 'url', url: block.data } }
        : {
            type: 'image',
            source: { type: 'base64', media_type: block.media_type, data: block.data },
          };
  }
}

// ---------------------------------------------------------------------------
// response
// ---------------------------------------------------------------------------

export function anthropicToCanonicalResponse(body: unknown): CanonicalResponse {
  const src = asRecord(body);
  if (asString(src['type']) === 'error') {
    const error = asRecord(src['error']);
    const message = asString(error['message']) ?? 'unknown provider error';
    return {
      id: asString(src['id']) ?? '',
      model: asString(src['model']) ?? '',
      stop_reason: 'error',
      content: [{ type: 'text', text: message }],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
  const content: CanonicalContent[] = [];
  for (const block of asArray(src['content'])) {
    const mapped = anthropicBlockToCanonical(block);
    if (mapped) content.push(mapped);
  }
  return {
    id: asString(src['id']) ?? '',
    model: asString(src['model']) ?? '',
    stop_reason: anthropicStopReason(src['stop_reason']),
    content,
    usage: anthropicUsage(src['usage']),
  };
}

export function anthropicStopReason(value: unknown): StopReason {
  const name = asString(value);
  if (name !== undefined && STOP_REASONS.has(name)) return name as StopReason;
  // `null` mid-stream, plus future values such as `refusal` or `pause_turn`: the turn ended and
  // no tool call is pending, which is exactly what `end_turn` means to every consumer.
  return 'end_turn';
}

export function anthropicUsage(value: unknown): Usage {
  const u = asRecord(value);
  return omitUndefined<Usage>({
    input_tokens: asNumber(u['input_tokens']) ?? 0,
    output_tokens: asNumber(u['output_tokens']) ?? 0,
    cache_read_tokens: asNumber(u['cache_read_input_tokens']),
    cache_write_tokens: asNumber(u['cache_creation_input_tokens']),
  });
}

// ---------------------------------------------------------------------------
// streaming
// ---------------------------------------------------------------------------

interface BlockState {
  type: string;
  text: string;
  id: string;
  name: string;
  startInput: unknown;
  json: string;
  sawJson: boolean;
}

/**
 * Incremental assembler shared by `parseAnthropicSse` (recorded streams) and the live provider.
 * Feed chunks, take the canonical deltas it returns, then ask for the assembled response.
 */
export class AnthropicStreamAssembler {
  private readonly decoder = new SseDecoder();
  private readonly blocks = new Map<number, BlockState>();
  private readonly order: number[] = [];
  private id = '';
  private model = '';
  private stop: StopReason = 'end_turn';
  private usage: Usage = { input_tokens: 0, output_tokens: 0 };
  private errorText: string | undefined;

  push(chunk: string): CanonicalChunk[] {
    const out: CanonicalChunk[] = [];
    for (const frame of this.decoder.push(chunk)) this.handle(frame.event, frameJson(frame), out);
    return out;
  }

  flush(): CanonicalChunk[] {
    const out: CanonicalChunk[] = [];
    for (const frame of this.decoder.flush()) this.handle(frame.event, frameJson(frame), out);
    return out;
  }

  result(): CanonicalResponse {
    const content: CanonicalContent[] = [];
    for (const index of this.order) {
      const block = this.blocks.get(index);
      if (!block) continue;
      if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.sawJson ? parseToolInput(block.json) : (block.startInput ?? {}),
        });
      } else if (block.type === 'thinking') {
        content.push({ type: 'thinking', text: block.text });
      } else if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      }
    }
    if (this.errorText !== undefined) content.push({ type: 'text', text: this.errorText });
    return {
      id: this.id,
      model: this.model,
      stop_reason: this.stop,
      content,
      usage: this.usage,
    };
  }

  private handle(
    event: string | undefined,
    data: Record<string, unknown> | undefined,
    out: CanonicalChunk[],
  ): void {
    if (!data) return;
    const type = asString(data['type']) ?? event ?? '';
    switch (type) {
      case 'message_start': {
        const message = asRecord(data['message']);
        this.id = asString(message['id']) ?? this.id;
        this.model = asString(message['model']) ?? this.model;
        this.mergeUsage(message['usage']);
        return;
      }
      case 'content_block_start': {
        const index = asNumber(data['index']) ?? this.order.length;
        const start = asRecord(data['content_block']);
        const block: BlockState = {
          type: asString(start['type']) ?? 'text',
          text: asString(start['text']) ?? asString(start['thinking']) ?? '',
          id: asString(start['id']) ?? '',
          name: asString(start['name']) ?? '',
          startInput: start['input'],
          json: '',
          sawJson: false,
        };
        this.blocks.set(index, block);
        this.order.push(index);
        if (block.type === 'tool_use') {
          // Tell the consumer which tool started before any argument bytes arrive.
          out.push({ type: 'tool_use_delta', id: block.id, name: block.name, partial_json: '' });
        } else if (block.text !== '' && block.type === 'text') {
          out.push({ type: 'text_delta', text: block.text });
        }
        return;
      }
      case 'content_block_delta': {
        const index = asNumber(data['index']) ?? 0;
        const delta = asRecord(data['delta']);
        const kind = asString(delta['type']);
        const block = this.blockAt(index, kind === 'input_json_delta' ? 'tool_use' : 'text');
        if (kind === 'text_delta') {
          const text = asString(delta['text']) ?? '';
          block.text += text;
          if (text !== '') out.push({ type: 'text_delta', text });
        } else if (kind === 'thinking_delta') {
          block.type = 'thinking';
          block.text += asString(delta['thinking']) ?? '';
        } else if (kind === 'input_json_delta') {
          const partial = asString(delta['partial_json']) ?? '';
          block.json += partial;
          block.sawJson = true;
          out.push({
            type: 'tool_use_delta',
            id: block.id,
            name: block.name,
            partial_json: partial,
          });
        }
        // `signature_delta` and future delta types carry nothing the canonical IR can hold.
        return;
      }
      case 'message_delta': {
        const delta = asRecord(data['delta']);
        if (delta['stop_reason'] !== undefined && delta['stop_reason'] !== null) {
          this.stop = anthropicStopReason(delta['stop_reason']);
        }
        this.mergeUsage(data['usage']);
        return;
      }
      case 'error': {
        const error = asRecord(data['error']);
        this.errorText = asString(error['message']) ?? 'unknown provider error';
        this.stop = 'error';
        return;
      }
      default:
        // ping, content_block_stop, message_stop and anything the API adds later.
        return;
    }
  }

  private blockAt(index: number, fallbackType: string): BlockState {
    const existing = this.blocks.get(index);
    if (existing) return existing;
    const block: BlockState = {
      type: fallbackType,
      text: '',
      id: '',
      name: '',
      startInput: undefined,
      json: '',
      sawJson: false,
    };
    this.blocks.set(index, block);
    this.order.push(index);
    return block;
  }

  private mergeUsage(raw: unknown): void {
    const u = asRecord(raw);
    const next = { ...this.usage };
    const input = asNumber(u['input_tokens']);
    const output = asNumber(u['output_tokens']);
    const read = asNumber(u['cache_read_input_tokens']);
    const write = asNumber(u['cache_creation_input_tokens']);
    if (input !== undefined) next.input_tokens = input;
    if (output !== undefined) next.output_tokens = output;
    if (read !== undefined) next.cache_read_tokens = read;
    if (write !== undefined) next.cache_write_tokens = write;
    this.usage = next;
  }
}

/** Assemble a complete response from a recorded Anthropic SSE stream. */
export function parseAnthropicSse(chunks: string[] | string): CanonicalResponse {
  const assembler = new AnthropicStreamAssembler();
  for (const chunk of toChunks(chunks)) assembler.push(chunk);
  assembler.flush();
  return assembler.result();
}
