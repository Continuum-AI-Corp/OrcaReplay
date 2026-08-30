/**
 * OpenAI Responses API <-> canonical IR.
 *
 * This is the dialect the OpenAI Agents SDK and the Codex CLI speak by default, and until it
 * existed the proxy answered `404` to both of them — so recording either did not merely capture
 * nothing, it killed the agent on its first turn.
 *
 * Three shape differences carry all the weight, and each one is a place a naive port of the
 * chat-completions translator would silently corrupt a trace:
 *
 *   - The system prompt is a top-level `instructions` string, not a message with a role.
 *   - Tool calls and their results are *top-level items in `input`*, not fields on a message.
 *     Canonical follows Anthropic, where they are content blocks, so both directions have to
 *     lift and re-flatten them.
 *   - A tool call has two identifiers: the item `id` (`fc_…`) and the `call_id` (`call_…`).
 *     Only `call_id` is what a later `function_call_output` references, so that is the one
 *     canonical carries. Keying on `id` produces a trace where every fork 400s.
 */

import type {
  CanonicalContent,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalTool,
  StopReason,
  Usage,
} from '@orcareplay/plugin-api';
import { SseDecoder, encodeSseFrame, frameJson, toChunks } from './sse.js';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  canonicalErrorText,
  omitUndefined,
  parseToolInput,
  stringifyToolInput,
  unknownKeys,
} from './util.js';

/** Unconsumed top-level request fields, parked verbatim. */
export const RESPONSES_EXTRA = 'openai_responses.extra';
/** The original tool definitions by name, so `strict` and vendor extras survive a round trip. */
export const RESPONSES_TOOL_ORIGINALS = 'openai_responses.tool_originals';

const REQUEST_KEYS: ReadonlySet<string> = new Set([
  'model',
  'instructions',
  'input',
  'tools',
  'max_output_tokens',
  'temperature',
  'top_p',
  'stream',
]);

// ---------------------------------------------------------------------------
// request: wire -> canonical
// ---------------------------------------------------------------------------

export function responsesToCanonicalRequest(body: unknown): CanonicalRequest {
  const src = asRecord(body);
  const metadata: Record<string, unknown> = {};

  const systemParts: string[] = [];
  const instructions = asString(src['instructions']);
  if (instructions !== undefined && instructions !== '') systemParts.push(instructions);

  const messages: CanonicalMessage[] = [];
  /** Open message of each role, so consecutive items of a kind batch into one turn. */
  let assistantBatch: CanonicalMessage | undefined;
  let resultBatch: CanonicalMessage | undefined;

  const push = (role: 'user' | 'assistant', block: CanonicalContent): void => {
    const batch = role === 'assistant' ? assistantBatch : resultBatch;
    if (batch) {
      batch.content.push(block);
      return;
    }
    const created: CanonicalMessage = { role, content: [block] };
    messages.push(created);
    if (role === 'assistant') assistantBatch = created;
    else resultBatch = created;
  };
  const breakBatches = (): void => {
    assistantBatch = undefined;
    resultBatch = undefined;
  };

  const rawInput = src['input'];
  if (typeof rawInput === 'string') {
    if (rawInput !== '')
      messages.push({ role: 'user', content: [{ type: 'text', text: rawInput }] });
  } else {
    for (const raw of asArray(rawInput)) {
      const item = asRecord(raw);
      const type = asString(item['type']);

      if (type === 'function_call') {
        resultBatch = undefined;
        push('assistant', {
          type: 'tool_use',
          // `call_id`, never the item `id`: it is what the matching output references.
          id: asString(item['call_id']) ?? asString(item['id']) ?? '',
          name: asString(item['name']) ?? '',
          input: parseToolInput(asString(item['arguments']) ?? ''),
        });
        continue;
      }

      if (type === 'function_call_output') {
        assistantBatch = undefined;
        push('user', {
          type: 'tool_result',
          tool_use_id: asString(item['call_id']) ?? '',
          content: flattenContent(item['output']),
        });
        continue;
      }

      if (type === 'reasoning') {
        resultBatch = undefined;
        const text = asArray(item['summary'])
          .map((part) => asString(asRecord(part)['text']) ?? '')
          .filter((t) => t !== '')
          .join('\n');
        if (text !== '') push('assistant', { type: 'thinking', text });
        continue;
      }

      // Anything else is a message, whether or not it says so.
      const role = asString(item['role']) ?? 'user';
      if (role === 'system' || role === 'developer') {
        systemParts.push(flattenContent(item['content']));
        continue;
      }
      breakBatches();
      const content = messageContent(item['content']);
      if (content.length === 0) continue;
      messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content });
    }
  }

  const toolsRaw = asArray(src['tools']);
  let tools: CanonicalTool[] | undefined;
  if (toolsRaw.length > 0) {
    const originals: Record<string, unknown> = {};
    tools = toolsRaw.map((raw) => {
      const tool = asRecord(raw);
      // Flat here, unlike chat completions, where the same fields sit under `function`. Reading
      // the nested shape as a fallback costs nothing and covers a gateway that normalises.
      const fn = asRecord(tool['function']);
      const name = asString(tool['name']) ?? asString(fn['name']) ?? '';
      originals[name] = raw;
      return omitUndefined<CanonicalTool>({
        name,
        description: asString(tool['description']) ?? asString(fn['description']),
        input_schema: asRecord(tool['parameters'] ?? fn['parameters']),
      });
    });
    metadata[RESPONSES_TOOL_ORIGINALS] = originals;
  }

  const extra = unknownKeys(src, REQUEST_KEYS);
  if (extra) metadata[RESPONSES_EXTRA] = extra;

  return omitUndefined<CanonicalRequest>({
    model: asString(src['model']) ?? '',
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages,
    tools,
    max_tokens: asNumber(src['max_output_tokens']),
    temperature: asNumber(src['temperature']),
    top_p: asNumber(src['top_p']),
    stream: typeof src['stream'] === 'boolean' ? src['stream'] : undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
}

/** Content parts of a message item, in either the input or the output spelling. */
function messageContent(value: unknown): CanonicalContent[] {
  if (typeof value === 'string') return value === '' ? [] : [{ type: 'text', text: value }];
  const out: CanonicalContent[] = [];
  for (const raw of asArray(value)) {
    const part = asRecord(raw);
    const type = asString(part['type']);
    if (type === 'input_image') {
      const url = asString(part['image_url']) ?? '';
      const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
      out.push(
        match
          ? { type: 'image', media_type: match[1]!, data: match[2]! }
          : { type: 'text', text: url },
      );
      continue;
    }
    const text = asString(part['text']) ?? asString(part['refusal']);
    if (text !== undefined && text !== '') out.push({ type: 'text', text });
  }
  return out;
}

/** Everything readable in a value that may be a string, a part list, or a bare object. */
function flattenContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const rec = asRecord(part);
        return asString(rec['text']) ?? asString(rec['output']) ?? '';
      })
      .filter((t) => t !== '')
      .join('');
  }
  const rec = asRecord(value);
  return asString(rec['text']) ?? asString(rec['output']) ?? JSON.stringify(value) ?? '';
}

// ---------------------------------------------------------------------------
// request: canonical -> wire
// ---------------------------------------------------------------------------

export function responsesTextPart(
  text: string,
  role: 'user' | 'assistant',
): Record<string, unknown> {
  return { type: role === 'assistant' ? 'output_text' : 'input_text', text };
}

export function canonicalToResponsesRequest(req: CanonicalRequest): Record<string, unknown> {
  const meta = asRecord(req.metadata);
  const originals = asRecord(meta[RESPONSES_TOOL_ORIGINALS]);
  const input: Array<Record<string, unknown>> = [];

  for (const message of req.messages) {
    // A message turn is split back apart: prose stays a message, tool traffic becomes the
    // top-level items this API models them as.
    const prose = message.content.filter((b) => b.type === 'text' || b.type === 'image');
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: stringifyToolInput(block.input),
        });
      } else if (block.type === 'tool_result') {
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: block.content,
        });
      } else if (block.type === 'thinking') {
        input.push({
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: block.text }],
        });
      }
    }
    if (prose.length === 0) continue;
    input.push({
      role: message.role,
      content: prose.map((block) =>
        block.type === 'text'
          ? responsesTextPart(block.text, message.role)
          : {
              type: 'input_image',
              image_url: `data:${block.media_type};base64,${block.data}`,
            },
      ),
    });
  }

  const tools = req.tools?.map((tool) => {
    const original = originals[tool.name];
    if (original !== undefined) return original;
    return omitUndefined({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    });
  });

  return omitUndefined({
    model: req.model,
    instructions: req.system,
    input,
    tools,
    max_output_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: req.stream,
    ...asRecord(meta[RESPONSES_EXTRA]),
  });
}

// ---------------------------------------------------------------------------
// response: wire -> canonical
// ---------------------------------------------------------------------------

export function responsesToCanonicalResponse(body: unknown): CanonicalResponse {
  const src = asRecord(body);
  const error = src['error'];
  const status = asString(src['status']);
  if ((error !== undefined && error !== null) || status === 'failed') {
    const err = asRecord(error);
    return {
      id: asString(src['id']) ?? '',
      model: asString(src['model']) ?? '',
      stop_reason: 'error',
      content: [{ type: 'text', text: asString(err['message']) ?? 'unknown provider error' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content: CanonicalContent[] = [];
  let sawToolCall = false;
  for (const raw of asArray(src['output'])) {
    const item = asRecord(raw);
    switch (asString(item['type'])) {
      case 'reasoning': {
        const text = asArray(item['summary'])
          .map((part) => asString(asRecord(part)['text']) ?? '')
          .filter((t) => t !== '')
          .join('\n');
        if (text !== '') content.push({ type: 'thinking', text });
        break;
      }
      case 'function_call':
        sawToolCall = true;
        content.push({
          type: 'tool_use',
          id: asString(item['call_id']) ?? asString(item['id']) ?? '',
          name: asString(item['name']) ?? '',
          input: parseToolInput(asString(item['arguments']) ?? ''),
        });
        break;
      default:
        content.push(...messageContent(item['content']));
    }
  }

  return {
    id: asString(src['id']) ?? '',
    model: asString(src['model']) ?? '',
    stop_reason: responsesStopReason(status, src['incomplete_details'], sawToolCall),
    content,
    usage: responsesUsage(src['usage']),
  };
}

/**
 * Why `max_tokens` outranks `tool_use`: a turn cut off by the output cap mid-tool-call is a
 * truncation, and reporting it as a completed tool call is how a reader concludes the model
 * chose to stop when it was actually stopped.
 */
export function responsesStopReason(
  status: string | undefined,
  incompleteDetails: unknown,
  sawToolCall: boolean,
): StopReason {
  if (status === 'incomplete') {
    const reason = asString(asRecord(incompleteDetails)['reason']);
    if (reason === 'max_output_tokens') return 'max_tokens';
  }
  return sawToolCall ? 'tool_use' : 'end_turn';
}

export function responsesUsage(value: unknown): Usage {
  const u = asRecord(value);
  const input = asNumber(u['input_tokens']) ?? 0;
  const cached = asNumber(asRecord(u['input_tokens_details'])['cached_tokens']);
  return omitUndefined<Usage>({
    // Canonical follows Anthropic and counts the cache tiers separately; this API, like chat
    // completions, counts cached tokens inside the input total.
    input_tokens: Math.max(0, input - (cached ?? 0)),
    output_tokens: asNumber(u['output_tokens']) ?? 0,
    cache_read_tokens: cached,
  });
}

// ---------------------------------------------------------------------------
// response: canonical -> wire
// ---------------------------------------------------------------------------

function canonicalToResponsesUsage(usage: Usage): Record<string, unknown> {
  const cached = usage.cache_read_tokens;
  const input = usage.input_tokens + (cached ?? 0);
  return omitUndefined({
    input_tokens: input,
    output_tokens: usage.output_tokens,
    total_tokens: input + usage.output_tokens,
    input_tokens_details: cached === undefined ? undefined : { cached_tokens: cached },
  });
}

/** Stable item ids. A clock or a counter read here would break byte-exact replay. */
function itemId(prefix: string, index: number): string {
  return `${prefix}_${index}`;
}

export function canonicalToResponsesResponse(res: CanonicalResponse): Record<string, unknown> {
  const head = { id: res.id, object: 'response', model: res.model };
  if (res.stop_reason === 'error') {
    return {
      ...head,
      status: 'failed',
      error: { code: 'error', message: canonicalErrorText(res.content) },
      output: [],
      usage: canonicalToResponsesUsage(res.usage),
    };
  }

  const output: Array<Record<string, unknown>> = [];
  res.content.forEach((block, index) => {
    if (block.type === 'thinking') {
      output.push({
        type: 'reasoning',
        id: itemId('rs', index),
        summary: [{ type: 'summary_text', text: block.text }],
      });
    } else if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        id: itemId('fc', index),
        call_id: block.id,
        name: block.name,
        arguments: stringifyToolInput(block.input),
        status: 'completed',
      });
    } else if (block.type === 'text') {
      output.push({
        type: 'message',
        id: itemId('msg', index),
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: block.text, annotations: [] }],
      });
    }
  });

  return omitUndefined({
    ...head,
    status: res.stop_reason === 'max_tokens' ? 'incomplete' : 'completed',
    incomplete_details:
      res.stop_reason === 'max_tokens' ? { reason: 'max_output_tokens' } : undefined,
    output,
    usage: canonicalToResponsesUsage(res.usage),
  });
}

// ---------------------------------------------------------------------------
// streaming
// ---------------------------------------------------------------------------

const TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed']);

/**
 * The event stream for one turn, in the typed-event form the Responses API uses.
 *
 * The terminal `response.completed` event carries the entire response, so a reader that has it
 * needs nothing else — but a debugger's most valuable stream is the one that was cut off before
 * that event arrived, so the deltas are accumulated in parallel and used when it never came.
 */
export function parseResponsesSse(chunks: string[] | string): CanonicalResponse {
  interface Item {
    kind: 'message' | 'function_call' | 'reasoning';
    id: string;
    callId: string;
    name: string;
    args: string;
    text: string;
  }
  const items = new Map<number, Item>();
  /** Deltas name their item by `item_id`; the index is how they are ordered. */
  const indexOfItem = new Map<string, number>();
  let head: { id: string; model: string } = { id: '', model: '' };

  const at = (index: number, kind: Item['kind'] = 'message'): Item => {
    let item = items.get(index);
    if (!item) {
      item = { kind, id: '', callId: '', name: '', args: '', text: '' };
      items.set(index, item);
    }
    return item;
  };
  const resolve = (data: Record<string, unknown>): Item => {
    const byId = indexOfItem.get(asString(data['item_id']) ?? '');
    return at(byId ?? asNumber(data['output_index']) ?? 0);
  };

  const decoder = new SseDecoder();
  const frames = [...toChunks(chunks).flatMap((c) => decoder.push(c)), ...decoder.flush()];

  for (const frame of frames) {
    const data = frameJson(frame);
    if (!data) continue;
    const type = asString(data['type']) ?? frame.event ?? '';

    if (TERMINAL_EVENTS.has(type)) {
      const response = data['response'];
      if (response !== undefined) return responsesToCanonicalResponse(response);
    }

    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        const response = asRecord(data['response']);
        head = {
          id: asString(response['id']) ?? head.id,
          model: asString(response['model']) ?? head.model,
        };
        break;
      }
      case 'response.output_item.added': {
        const index = asNumber(data['output_index']) ?? items.size;
        const raw = asRecord(data['item']);
        const kindRaw = asString(raw['type']);
        const kind: Item['kind'] =
          kindRaw === 'function_call'
            ? 'function_call'
            : kindRaw === 'reasoning'
              ? 'reasoning'
              : 'message';
        const item = at(index, kind);
        item.kind = kind;
        item.id = asString(raw['id']) ?? '';
        item.callId = asString(raw['call_id']) ?? '';
        item.name = asString(raw['name']) ?? '';
        item.args = asString(raw['arguments']) ?? '';
        if (item.id !== '') indexOfItem.set(item.id, index);
        break;
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        resolve(data).text += asString(data['delta']) ?? '';
        break;
      case 'response.reasoning_summary_text.delta': {
        const item = resolve(data);
        item.kind = 'reasoning';
        item.text += asString(data['delta']) ?? '';
        break;
      }
      case 'response.function_call_arguments.delta': {
        const item = resolve(data);
        item.kind = 'function_call';
        item.args += asString(data['delta']) ?? '';
        break;
      }
      default:
        break;
    }
  }

  const content: CanonicalContent[] = [];
  let sawToolCall = false;
  for (const index of [...items.keys()].sort((a, b) => a - b)) {
    const item = items.get(index)!;
    if (item.kind === 'function_call') {
      sawToolCall = true;
      content.push({
        type: 'tool_use',
        id: item.callId !== '' ? item.callId : item.id,
        name: item.name,
        input: parseToolInput(item.args),
      });
    } else if (item.text !== '') {
      content.push({ type: item.kind === 'reasoning' ? 'thinking' : 'text', text: item.text });
    }
  }

  return {
    id: head.id,
    model: head.model,
    stop_reason: sawToolCall ? 'tool_use' : 'end_turn',
    content,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * The event sequence for one assistant turn, ending in `response.completed`.
 *
 * This is the half a cross-provider fork needs: a reply obtained from Anthropic has to reach a
 * Responses-speaking agent in the shape that agent's SDK will parse.
 */
export function canonicalToResponsesSse(res: CanonicalResponse): string {
  const frames: string[] = [];
  const emit = (event: string, data: Record<string, unknown>): void => {
    frames.push(encodeSseFrame({ event, data: JSON.stringify({ type: event, ...data }) }));
  };

  emit('response.created', {
    response: { id: res.id, object: 'response', model: res.model, status: 'in_progress' },
  });

  if (res.stop_reason === 'error') {
    emit('response.failed', { response: canonicalToResponsesResponse(res) });
    return frames.join('');
  }

  const wire = canonicalToResponsesResponse(res);
  const output = (wire['output'] ?? []) as Array<Record<string, unknown>>;
  output.forEach((item, index) => {
    const type = asString(item['type']);
    const id = asString(item['id']) ?? '';
    if (type === 'function_call') {
      emit('response.output_item.added', {
        output_index: index,
        item: { ...item, arguments: '' },
      });
      emit('response.function_call_arguments.delta', {
        item_id: id,
        output_index: index,
        // One delta carrying the whole argument string: the fragment boundaries a live stream
        // happened to use are not canonical, and the reader only sees the concatenation.
        delta: asString(item['arguments']) ?? '',
      });
      emit('response.function_call_arguments.done', {
        item_id: id,
        output_index: index,
        arguments: asString(item['arguments']) ?? '',
      });
    } else if (type === 'reasoning') {
      emit('response.output_item.added', { output_index: index, item: { ...item, summary: [] } });
      emit('response.reasoning_summary_text.delta', {
        item_id: id,
        output_index: index,
        delta: asString(asRecord(asArray(item['summary'])[0])['text']) ?? '',
      });
    } else {
      emit('response.output_item.added', { output_index: index, item: { ...item, content: [] } });
      emit('response.output_text.delta', {
        item_id: id,
        output_index: index,
        delta: asString(asRecord(asArray(item['content'])[0])['text']) ?? '',
      });
    }
    emit('response.output_item.done', { output_index: index, item });
  });

  emit('response.completed', { response: wire });
  return frames.join('');
}
