import type { Readable, Writable } from 'node:stream';
import { JsonRpcFramer } from '@orcareplay/mcp-shim';
import { Orca } from './api.js';
import { ORCA_VERSION } from './version.js';

/**
 * Orca as tools an agent can call.
 *
 * `@orcareplay/mcp-shim` records an agent's *own* MCP traffic — it is a tee, so nothing has ever
 * let an agent ask orca a question. That is backwards for this product in particular: "replay my
 * last run and tell me what diverged" is the most useful thing an agent could ask a replay
 * debugger, and it is a question no observability tool can answer, because a trace is a file.
 *
 * Written against the framer the shim already has rather than an SDK. The stdio transport is
 * newline-delimited JSON-RPC and the surface is four method names, so a runtime dependency here
 * would cost more than it carries — and this package has none.
 *
 * The tool set is deliberately narrow and read-mostly. `orca_replay` costs nothing and touches no
 * network; `orca_compare` spends real tokens, and says so in its own description, because an
 * agent choosing a tool reads that string and nothing else.
 */

/** The version of the MCP spec these messages are shaped for. */
const PROTOCOL_VERSION = '2025-06-18';

const METHOD_NOT_FOUND = -32601;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Every tool takes `run`, because "which run" is the only question all of them share. */
const RUN_ARG = {
  run: {
    type: 'string',
    description:
      'Run id, or "last" for the newest recording. Defaults to "last". Replay traces are ' +
      'skipped when resolving "last", so it means the newest run you actually recorded.',
  },
} as const;

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'orca_list_runs',
    description:
      'List every agent run recorded in this project, newest first, with the run it was forked ' +
      'from where there is one. Start here when you do not already know which run to look at.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'orca_show_run',
    description:
      'The full timeline of one run: every model turn with its token counts and stop reason, ' +
      'every tool call with its arguments and result, every shell command with its exit code, ' +
      'and every file the run changed. This is what tells you why an agent did something, ' +
      'rather than what it cost.',
    inputSchema: { type: 'object', properties: { ...RUN_ARG } },
  },
  {
    name: 'orca_checkpoints',
    description:
      'The points in a run a fork can start from — where the conversation prefix is complete and ' +
      'the workspace was snapshotted. Use before orca_compare to pick a fork point.',
    inputSchema: { type: 'object', properties: { ...RUN_ARG } },
  },
  {
    name: 'orca_graph',
    description:
      'What caused what in a run, as a list of edges. Each edge says which event produced which, ' +
      'and whether it is `recorded` — the recorder watched it happen and wrote it into the trace ' +
      '— or `inferred`, meaning this derived it just now from the rule it names and the trace ' +
      'does not vouch for it. Pass `to` to get only the chain that produced one event, which is ' +
      'the shape of an answer to "why did this fail" rather than "what happened".',
    inputSchema: {
      type: 'object',
      properties: {
        ...RUN_ARG,
        to: {
          type: 'number',
          description: 'Narrow to the chain that produced this event seq. Omit for the whole run.',
        },
      },
    },
  },
  {
    name: 'orca_replay',
    description:
      'Re-run a recording exactly, with the network blocked and no tokens spent, and report what ' +
      'could not be reproduced: divergences, and requests the recording could not serve. Free ' +
      'and repeatable. Use it to confirm a failure is deterministic before trying to explain it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...RUN_ARG,
        worktree: {
          type: 'boolean',
          description:
            'Replay in a scratch copy instead of over the working tree. Slower, and leaves the ' +
            'files you are looking at untouched.',
        },
      },
    },
  },
  {
    name: 'orca_compare',
    description:
      'Fork one recorded run onto several models from the same checkpoint — same files, same ' +
      'conversation prefix — and grade each with a command you choose. SPENDS REAL TOKENS and ' +
      'reaches the network: every model named is actually called. Ask before using it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...RUN_ARG,
        models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Model ids to compare. Required.',
        },
        from: { type: 'number', description: 'Checkpoint seq to fork at, from orca_checkpoints.' },
        verify: {
          type: 'string',
          description: 'Shell command whose exit code is the verdict, e.g. "npm test".',
        },
      },
      required: ['models'],
    },
  },
];

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A tool result in MCP's shape: text content, plus the flag that says it failed. */
function content(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function ok(json: unknown): Record<string, unknown> {
  return content(JSON.stringify(json, null, 2));
}

/**
 * Handle one message.
 *
 * Returns `undefined` for a notification, which by definition has no id to answer — replying to
 * one is a protocol error that some clients treat as fatal.
 */
export async function handleMcpMessage(
  orca: Orca,
  message: unknown,
): Promise<JsonRpcResponse | undefined> {
  const req = asRecord(message) as JsonRpcRequest;
  const { id, method } = req;
  if (id === undefined) return undefined;

  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'orcareplay', version: ORCA_VERSION },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: MCP_TOOLS });
    case 'tools/call':
      return reply(await callTool(orca, asRecord(req.params)));
    default:
      return fail(METHOD_NOT_FOUND, `orca's MCP server does not implement '${method ?? '(none)'}'`);
  }
}

/**
 * Run one tool.
 *
 * Every failure comes back as `isError` content rather than a JSON-RPC error: the spec draws that
 * line so a model can read what went wrong and try something else, where a transport error ends
 * the session. A bad run id is an ordinary answer here, not a crash.
 */
async function callTool(orca: Orca, params: Record<string, unknown>): Promise<unknown> {
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  const args = asRecord(params['arguments']);
  const run = typeof args['run'] === 'string' && args['run'] !== '' ? args['run'] : 'last';

  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) {
    return content(
      `no such tool '${name}'. orca serves: ${MCP_TOOLS.map((t) => t.name).join(', ')}`,
      true,
    );
  }

  try {
    switch (name) {
      case 'orca_list_runs':
        return ok(await orca.list());
      case 'orca_show_run':
        return ok(await orca.show(run));
      case 'orca_checkpoints':
        return ok(await orca.checkpoints(run));
      case 'orca_graph': {
        const to = args['to'];
        if (to !== undefined && typeof to !== 'number') {
          return content('to must be a number', true);
        }
        return ok(await orca.graph(run, to === undefined ? {} : { to }));
      }
      case 'orca_replay': {
        const worktree = args['worktree'];
        if (worktree !== undefined && typeof worktree !== 'boolean') {
          return content('worktree must be a boolean', true);
        }
        return ok(await orca.replay(run, worktree === true ? { worktree: true } : {}));
      }
      case 'orca_compare': {
        const models = Array.isArray(args['models'])
          ? args['models'].filter((m): m is string => typeof m === 'string')
          : [];
        if (models.length === 0) return content('compare needs at least one model id', true);
        const from = args['from'];
        // Coercing a string here would silently fork from checkpoint 0 and produce a comparison
        // whose one variable was not the model.
        if (from !== undefined && typeof from !== 'number') {
          return content(`from must be a number, got ${JSON.stringify(from)}`, true);
        }
        const verify = args['verify'];
        if (verify !== undefined && typeof verify !== 'string') {
          return content('verify must be a string', true);
        }
        return ok(
          await orca.compare(run, {
            models,
            ...(typeof from === 'number' ? { from } : {}),
            ...(typeof verify === 'string' ? { verify } : {}),
          }),
        );
      }
      default:
        return content(`no such tool '${name}'`, true);
    }
  } catch (err) {
    return content(err instanceof Error ? err.message : String(err), true);
  }
}

export interface ServeMcpOptions {
  orca: Orca;
  input: Readable;
  output: Writable;
}

/**
 * Serve MCP over a stream pair until the input ends.
 *
 * Messages are handled one at a time. Concurrency would buy nothing — every tool here is either a
 * file read or a subprocess that owns the working tree — and it would let two replays fight over
 * the same checkout.
 */
export async function serveMcp({ orca, input, output }: ServeMcpOptions): Promise<void> {
  const framer = new JsonRpcFramer();
  for await (const chunk of input) {
    for (const frame of framer.push(chunk as Uint8Array)) {
      // A line that is not JSON is a stray log from something upstream, not a message. Dropping it
      // is the only safe answer: there is no id to report an error against.
      if (frame.message === undefined) continue;
      const response = await handleMcpMessage(orca, frame.message);
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
