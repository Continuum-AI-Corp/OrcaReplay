import { StringDecoder } from 'node:string_decoder';

export type JsonRpcKind = 'request' | 'response' | 'notification' | 'unknown';

/** One newline-delimited JSON-RPC message observed on the wire. */
export interface JsonRpcFrame {
  /** The line exactly as it arrived, minus its terminator. Present even when parsing failed. */
  raw: string;
  /** The parsed message, or undefined when the line was not valid JSON. */
  message?: unknown;
  kind: JsonRpcKind;
  id?: string | number;
  method?: string;
}

/**
 * Whether a parsed line could be a JSON-RPC message at all.
 *
 * Exported because the readers of a capture have to apply the same rule as the writer of it, and
 * the two already drifted apart once: the reader without a shape check died on a `null` line while
 * the writer was happily recording them.
 *
 * A line that is not an object is *kept* by {@link toFrame}, as `{ raw, kind: 'unknown' }` — the
 * recording holds what the server actually said, which is the point of a recording. What must not
 * happen is treating it as a message afterwards: it has no `id` to read, and every consumer reads
 * `id`.
 *
 * Arrays go with the rest. A JSON-RPC batch is an array, nothing here has ever produced or answered
 * one, and calling it a message would only move the same crash further in.
 */
export function isJsonRpcMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFrame(line: string): JsonRpcFrame | undefined {
  const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
  // Blank lines are keep-alive padding, not messages; reporting them would be noise.
  if (raw.trim() === '') return undefined;

  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    // A server that emits a stray log line must not take the agent down with it.
    return { raw, kind: 'unknown' };
  }
  if (!isJsonRpcMessage(message)) return { raw, message, kind: 'unknown' };

  const method = typeof message['method'] === 'string' ? message['method'] : undefined;
  const rawId = message['id'];
  // `id: 0` is a legal id, so presence is tested rather than truthiness.
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : undefined;

  const frame: JsonRpcFrame = { raw, message, kind: 'unknown' };
  if (id !== undefined) frame.id = id;
  if (method !== undefined) frame.method = method;

  if (method !== undefined) frame.kind = id !== undefined ? 'request' : 'notification';
  else if (id !== undefined && ('result' in message || 'error' in message)) frame.kind = 'response';

  return frame;
}

/**
 * Splits an MCP stdio byte stream into JSON-RPC frames.
 *
 * Chunk boundaries fall wherever the OS put them — mid-message and mid-character — so bytes are
 * decoded incrementally and lines are accumulated in parts rather than by re-concatenating a
 * growing buffer, which would be quadratic on the large tool results MCP servers actually send.
 */
export class JsonRpcFramer {
  readonly #decoder = new StringDecoder('utf8');
  #parts: string[] = [];

  push(chunk: Uint8Array): JsonRpcFrame[] {
    const text = this.#decoder.write(Buffer.from(chunk));
    if (text.length === 0) return [];

    const frames: JsonRpcFrame[] = [];
    let start = 0;
    for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', start)) {
      this.#parts.push(text.slice(start, nl));
      const frame = toFrame(this.#take());
      if (frame) frames.push(frame);
      start = nl + 1;
    }
    if (start < text.length) this.#parts.push(text.slice(start));
    return frames;
  }

  /** Emits a trailing line that never got its newline — a server that exited mid-write. */
  flush(): JsonRpcFrame[] {
    const tail = this.#decoder.end();
    if (tail.length > 0) this.#parts.push(tail);
    const line = this.#take();
    if (line === '') return [];
    const frame = toFrame(line);
    return frame ? [frame] : [];
  }

  #take(): string {
    const line = this.#parts.length === 1 ? (this.#parts[0] as string) : this.#parts.join('');
    this.#parts = [];
    return line;
  }
}
