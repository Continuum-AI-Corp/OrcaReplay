/**
 * A deterministic OpenAI- and Anthropic-shaped origin.
 *
 * Deterministic on purpose: a replay is judged on matching the bytes it recorded, so an origin that
 * varied its answer would make an exact match indistinguishable from a lucky one.
 *
 * It answers the shapes frameworks actually use rather than the simplest one — streaming SSE, tool
 * calls, and `/v1/messages` — because those are where a recording proxy is most likely to break and
 * a stub that only served a plain completion would have proved nothing about either.
 */
import { createServer } from 'node:http';

const REPLY = 'the stub answered';

function completion(seen) {
  const wantsTool = Array.isArray(seen.tools) && seen.tools.length > 0;
  const message = wantsTool
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_stub_1',
            type: 'function',
            function: {
              name: seen.tools[0]?.function?.name ?? 'unknown',
              arguments: '{"city":"Paris"}',
            },
          },
        ],
      }
    : { role: 'assistant', content: REPLY };

  return {
    id: 'chatcmpl-stub-1',
    object: 'chat.completion',
    created: 1756000000,
    model: seen.model ?? 'stub-1',
    choices: [{ index: 0, message, finish_reason: wantsTool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
  };
}

/** The same answer as the delta frames a streaming client expects. */
function stream(seen) {
  const base = {
    id: 'chatcmpl-stub-1',
    object: 'chat.completion.chunk',
    created: 1756000000,
    model: seen.model ?? 'stub-1',
  };
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: 'the stub ' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: 'answered' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  return `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`;
}

/**
 * The Responses API shape.
 *
 * Here because it is the OpenAI Agents SDK's *default* — not an option it offers — so a check that
 * quietly switched the SDK to chat completions would prove the wrong path works. orca has carried a
 * `responses` dialect since early on; until this, nothing end to end exercised it.
 */
function responses(seen) {
  return {
    id: 'resp_stub_1',
    object: 'response',
    created_at: 1756000000,
    status: 'completed',
    model: seen.model ?? 'stub-1',
    output: [
      {
        id: 'msg_stub_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: REPLY, annotations: [] }],
      },
    ],
    usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
    parallel_tool_calls: false,
    tool_choice: 'auto',
    tools: [],
  };
}

/**
 * Embeddings, deterministic per input text.
 *
 * A function of the text and nothing else, which is the property the whole retrieval-replay
 * mechanism rests on — and the reason a check can assert that a replayed index is the recorded
 * one rather than a similar one. A stub that returned random vectors would make a correct replay
 * indistinguishable from a lucky one, exactly as a varying completion would.
 *
 * `encoding_format: "base64"` is answered in base64, because that is what the OpenAI SDK asks for
 * by default and a stub that always returned floats would exercise a path real clients do not
 * take.
 */
function embeddings(seen) {
  const inputs = Array.isArray(seen.input) ? seen.input : [seen.input ?? ''];
  const base64 = seen.encoding_format === 'base64';
  return {
    object: 'list',
    data: inputs.map((text, index) => {
      const vector = vectorFor(String(text));
      return {
        object: 'embedding',
        index,
        embedding: base64 ? encodeFloats(vector) : vector,
      };
    }),
    model: seen.model ?? 'stub-embedding',
    usage: { prompt_tokens: inputs.length * 4, total_tokens: inputs.length * 4 },
  };
}

/** Eight dimensions, derived from the text so the same text always embeds the same way. */
function vectorFor(text) {
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return Array.from({ length: 8 }, (_, i) => {
    hash = Math.imul(hash ^ (i + 1), 16777619) >>> 0;
    return Number((hash / 2 ** 32 - 0.5).toFixed(6));
  });
}

/** Little-endian float32, base64 — the encoding the OpenAI SDK decodes. */
function encodeFloats(vector) {
  const buf = Buffer.alloc(vector.length * 4);
  vector.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf.toString('base64');
}

function anthropic(seen) {
  return {
    id: 'msg_stub_1',
    type: 'message',
    role: 'assistant',
    model: seen.model ?? 'claude-stub',
    content: [{ type: 'text', text: REPLY }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 9, output_tokens: 4 },
  };
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let seen = {};
    try {
      seen = JSON.parse(body || '{}');
    } catch {
      // A body this stub cannot parse is still a request worth answering; the shape under test is
      // whether orca captured it, not whether the client sent valid JSON.
    }

    // Before `/completions`, which it does not end in, but ahead of the generic branch for the
    // same reason the others are: an embeddings client cannot parse a chat completion.
    if (req.url?.endsWith('/embeddings')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(embeddings(seen)));
      return;
    }
    // Before the generic branch: a Responses request wants Responses output back, not a
    // chat.completion the SDK cannot parse.
    if (req.url?.includes('/responses')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responses(seen)));
      return;
    }
    if (req.url?.includes('/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(anthropic(seen)));
      return;
    }
    if (seen.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(stream(seen));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion(seen)));
  });
});

server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`);
});
