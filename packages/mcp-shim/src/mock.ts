import { createInterface } from 'node:readline';

/**
 * Answering an MCP client from a recording, without the server.
 *
 * Recording MCP was only ever half of what the layer is for. The point of capturing a server's
 * traffic is that the run stays reproducible after the server is not: the token is revoked, the
 * repository moved, the service was turned off. Replay re-instrumented the same config and started
 * the real server again, so a recording of an MCP run could be read but not reproduced — and once
 * the server was gone it came apart on the first call.
 *
 * This is the other half. The shim answers from the frames the recording captured and never
 * launches the child at all.
 */

/** A JSON-RPC message as it travels on the wire, which is what the capture stores. */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** One recorded frame, as `mcp-frames.jsonl` stores it. */
export interface RecordedFrame {
  server: string;
  direction: 'in' | 'out';
  at: string;
  id?: string | number;
  method?: string;
  message: JsonRpcMessage;
}

export interface MockOptions {
  name: string;
  frames: RecordedFrame[];
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** Told what could not be answered, so a caller can report it rather than let the client hang. */
  onMiss?: (method: string) => void;
  /**
   * Every message that crossed the shim, so a replay records what it served.
   *
   * A replay is a run of its own and has to be readable as one. Without this its trace has no
   * `mcp.*` events at all, which reads as "the agent made no MCP calls" rather than as "these were
   * answered from the parent recording" — the same ambiguity the capture layer exists to remove.
   */
  onFrame?: (direction: 'in' | 'out', message: JsonRpcMessage) => void;
}

/**
 * Strip the per-run identifiers MCP carries alongside the arguments.
 *
 * `_meta` is the protocol's own side channel and every client fills it with things that are new
 * each run — Claude Code puts the tool-use id and a progress token there. Comparing it makes an
 * exact match impossible for `tools/call`, which is the one call anybody replays.
 */
function withoutMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMeta);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === '_meta') continue;
    out[key] = withoutMeta(inner);
  }
  return out;
}

/**
 * Identity of a request: its method and its arguments, with per-run identifiers removed.
 *
 * Ids are deliberately not part of it either. A client numbers its requests per session, so the
 * same call carries a different id on every run and matching on it would miss every time.
 */
export function keyOf(message: JsonRpcMessage): string {
  const method = typeof message.method === 'string' ? message.method : '';
  let params = '';
  try {
    params = JSON.stringify(withoutMeta(message.params ?? null));
  } catch {
    // A params object that will not serialise still identifies its method.
  }
  return `${method} ${params}`;
}

/**
 * Responses from the recording, keyed by the request that drew them, in the order they came.
 *
 * A list per key rather than one entry: a client that called the same tool with the same arguments
 * twice was answered twice, and may have been answered differently — a second `tools/call` against
 * a queue returns the next item, not the first one again.
 */
export interface FrameIndex {
  /** Answers to the exact question, arguments and all. */
  byKey: Map<string, JsonRpcMessage[]>;
  /** Answers to the method alone, for a question whose arguments cannot repeat. */
  byMethod: Map<string, JsonRpcMessage[]>;
}

export function indexFrames(frames: RecordedFrame[]): FrameIndex {
  const keyById = new Map<string | number, string>();
  const methodById = new Map<string | number, string>();
  const byKey = new Map<string, JsonRpcMessage[]>();
  const byMethod = new Map<string, JsonRpcMessage[]>();
  const push = (map: Map<string, JsonRpcMessage[]>, key: string, value: JsonRpcMessage): void => {
    const bucket = map.get(key);
    if (bucket === undefined) map.set(key, [value]);
    else bucket.push(value);
  };
  for (const record of frames) {
    const message = record.message;
    if (record.direction === 'in') {
      if (message.id === undefined) continue;
      keyById.set(message.id, keyOf(message));
      methodById.set(message.id, typeof message.method === 'string' ? message.method : '');
      continue;
    }
    // A response carries no method of its own; the id is what ties it to the question asked.
    if (message.id === undefined) continue;
    const key = keyById.get(message.id);
    if (key !== undefined) push(byKey, key, message);
    const method = methodById.get(message.id);
    if (method !== undefined) push(byMethod, method, message);
  }
  return { byKey, byMethod };
}

/** Serve an MCP client entirely from a recording. Resolves when the client closes stdin. */
export async function runMock(options: MockOptions): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const { byKey, byMethod } = indexFrames(options.frames);
  const used = new Map<string, number>();

  return new Promise((resolve) => {
    const lines = createInterface({ input: stdin });
    lines.on('line', (line) => {
      if (line.trim() === '') return;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      options.onFrame?.('in', message);
      // A notification expects no answer, and inventing one desynchronises the client.
      if (message.id === undefined) return;

      // Two rungs, for the same reason the model matcher has four. Some questions repeat exactly
      // and are answered on the first: a `tools/call` with the same arguments. Others cannot —
      // `initialize` carries the client's own version and capabilities, and a client that is not
      // byte-for-byte the recorded one still has to be answered or nothing else in the session
      // happens. Falling back to the method alone answers those in the order they were asked.
      const method = typeof message.method === 'string' ? message.method : '';
      const key = keyOf(message);
      const exact = byKey.get(key);
      const bucket = exact ?? byMethod.get(method) ?? [];
      const slot = exact === undefined ? `method:${method}` : key;
      const nth = used.get(slot) ?? 0;
      // Past the end, the last recorded answer stands: a client that calls once more than the
      // recording did gets a stale answer rather than an error it has no way to interpret.
      const recorded = bucket.length === 0 ? undefined : bucket[Math.min(nth, bucket.length - 1)];
      used.set(slot, nth + 1);

      if (recorded === undefined) {
        const method = typeof message.method === 'string' ? message.method : '(no method)';
        options.onMiss?.(method);
        // JSON-RPC "method not found". The client is told this server cannot do that, which is
        // true of a recording that never saw it — and is recoverable, where silence is a hang.
        const answer: JsonRpcMessage = {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `orca: no recorded response for ${method}` },
        };
        options.onFrame?.('out', answer);
        stdout.write(`${JSON.stringify(answer)}\n`);
        return;
      }
      // The recorded id belonged to the recorded session; the client is waiting on its own.
      const answer: JsonRpcMessage = { ...recorded, id: message.id };
      options.onFrame?.('out', answer);
      stdout.write(`${JSON.stringify(answer)}\n`);
    });
    lines.on('close', () => resolve(0));
  });
}
