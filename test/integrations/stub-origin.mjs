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
/** How many Responses calls this instance has answered, so a handoff can happen on the first. */
let responseCalls = 0;

function responses(seen) {
  responseCalls += 1;
  // Only when a handoff is actually on offer. The Agents SDK implements a handoff as a function
  // tool named `transfer_to_<agent>`, so driving one means answering with that call — and a check
  // whose agent has no handoffs sees none of this.
  const transfer = (Array.isArray(seen.tools) ? seen.tools : []).find((t) =>
    String(t?.name ?? '').startsWith('transfer_to_'),
  );
  if (responseCalls === 1 && transfer !== undefined) {
    return {
      id: 'resp_stub_handoff',
      object: 'response',
      created_at: 1756000000,
      status: 'completed',
      model: seen.model ?? 'stub-1',
      output: [
        {
          id: 'fc_stub_1',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_stub_1',
          name: transfer.name,
          arguments: '{}',
        },
      ],
      usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
      parallel_tool_calls: false,
      tool_choice: 'auto',
      tools: [],
    };
  }
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
