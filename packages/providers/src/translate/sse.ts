/**
 * Minimal SSE frame decoder.
 *
 * Recorded streams arrive as whatever slices the socket happened to produce, so framing has to
 * survive a boundary in the middle of a `data:` line. Handles LF, CRLF and CR frame separators.
 */

export interface SseFrame {
  event?: string;
  data: string;
}

const SEPARATORS = ['\r\n\r\n', '\n\n', '\r\r'] as const;

export class SseDecoder {
  private buffer = '';

  /** Feed one chunk; returns every frame that is now complete. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      let at = -1;
      let width = 0;
      for (const sep of SEPARATORS) {
        const i = this.buffer.indexOf(sep);
        if (i !== -1 && (at === -1 || i < at)) {
          at = i;
          width = sep.length;
        }
      }
      if (at === -1) break;
      const raw = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + width);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Emit any trailing frame that never got its blank line (a stream cut short). */
  flush(): SseFrame[] {
    const rest = this.buffer;
    this.buffer = '';
    const frame = parseFrame(rest);
    return frame ? [frame] : [];
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  if (raw.trim() === '') return undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0 && event === undefined) return undefined;
  return event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') };
}

/** JSON-parse a frame payload, returning undefined for `[DONE]` and for garbage. */
export function frameJson(frame: SseFrame): Record<string, unknown> | undefined {
  const text = frame.data.trim();
  if (text === '' || text === '[DONE]') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Normalize `chunks` given either as one recorded string or as the slices the socket produced. */
export function toChunks(chunks: string[] | string): string[] {
  return typeof chunks === 'string' ? [chunks] : chunks;
}
