#!/usr/bin/env node
import { createWriteStream, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { runMock, type JsonRpcMessage, type RecordedFrame } from './mock.js';
import { fileURLToPath } from 'node:url';
import { isJsonRpcMessage, type JsonRpcFrame } from './framing.js';
import { runShim } from './shim.js';
import type { FrameDirection } from './shim.js';

export interface ShimCliArgs {
  name: string;
  out?: string;
  /** Recording to answer from, instead of starting the server. */
  replay?: string;
  command: string;
  args: string[];
}

export interface ShimCliIo {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export const USAGE =
  'usage: orca-mcp-shim --name <server-name> [--out <file.jsonl>] -- <command> [args...]';

function fail(problem: string): never {
  throw new Error(`${problem}\n${USAGE}`);
}

/**
 * Everything after `--` belongs to the MCP server, untouched — servers take `--name` and `--out`
 * of their own, and swallowing them here would silently change how the server runs.
 */
export function parseArgs(argv: string[]): ShimCliArgs {
  let name: string | undefined;
  let out: string | undefined;
  let replay: string | undefined;
  let i = 0;

  for (; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') break;
    if (arg === '--name' || arg === '--out' || arg === '--replay') {
      const value = argv[i + 1];
      if (value === undefined || value === '--') fail(`${arg} needs a value`);
      if (arg === '--name') name = value;
      else if (arg === '--out') out = value;
      else replay = value;
      i += 1;
      continue;
    }
    fail(`unexpected argument '${arg}'`);
  }

  if (name === undefined) fail('--name is required: it labels this server in the trace');
  if (argv[i] !== '--') fail("missing '--' separator before the MCP server command");
  const command = argv[i + 1];
  if (command === undefined) fail("no command after '--': give the MCP server to launch");

  return { name, out, replay, command, args: argv.slice(i + 2) };
}

/**
 * One line of the capture file, as written.
 *
 * Exported because the recorder reads these back, and it used to do so through a type of its own
 * that named the same fields differently — `server` for `name`, `direction` for `dir`. Nothing
 * caught it: JSON.parse casts to whatever you claim, so every frame arrived with an undefined
 * server, and `direction === 'in'` was false for all of them, which recorded every request as a
 * response. The writer owns the format; the reader imports it.
 */
export interface McpFrameRecord {
  /** RFC3339, stamped when the frame passed through the shim — not when it was read back. */
  ts: string;
  /** The server's name in the agent's own config. */
  name: string;
  dir: FrameDirection;
  kind: string;
  raw: string;
  id?: string | number;
  method?: string;
}

/**
 * Whether a parsed capture line is a frame, rather than merely valid JSON.
 *
 * One predicate for the format, used by both readers of this file. Several shims share one capture
 * — see the `--out` comment below — so an interleaved write can leave a line that parses to `null`,
 * to a number, or to an object with none of these fields, and *every* reader has to survive it. The
 * two that dereference `name` are one file apart and both used to cast straight through.
 *
 * `name` and `raw` only: those are what the readers touch before they know anything else. The rest
 * is checked where it is used, because what is unsafe differs between them — the recorder builds an
 * instant out of `ts`, and this file does not.
 */
export function isMcpFrameRecord(value: unknown): value is McpFrameRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<McpFrameRecord>;
  return typeof record.name === 'string' && typeof record.raw === 'string';
}

/**
 * Where the object starting at `from` ends, or -1 if it does not end on this line.
 *
 * Braces only: a `}` can appear inside this line in three places, and two of them are handled by
 * counting. Inside a string it is text, which is what the quote and escape tracking is for; inside
 * a nested object it is that object's, which is what the depth is for; the third is the one being
 * looked for. Brackets need no counting of their own, because a `}` inside an array belongs to an
 * object that opened inside it.
 */
function endOfObject(line: string, from: number): number {
  if (line[from] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = from; at < line.length; at += 1) {
    const ch = line[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return at + 1;
  }
  return -1;
}

/**
 * The records on one line, which is nearly always one.
 *
 * The shim writes record with a single write, and that is not a single `write`
 * syscall. A short write — a full disk, a quota, a process killed inside it — leaves part of one on
 * disk with no newline behind it, and the next writer's bytes land straight on the end: one line
 * holding more than it should. Skipping such a line whole threw away whatever on it was *complete*,
 * so work that was recorded in full went missing because a different writer was interrupted.
 * Losing the torn one is unavoidable; losing its neighbour is not.
 *
 * **Cut where the JSON ends, not where a key begins.** Cutting at the next opening only rescues
 * what comes *after* a fragment. The other direction is just as reachable — a write short by only
 * its newline, followed by one short by fewer bytes than the opening is long — and there the
 * fragment is too small to be recognised, so the complete record before it was
 * swallowed with it. Scanning for the end of each object finds both, and stops depending on which
 * key the writer happens to put first.
 *
 * A fragment yields nothing, which is the partial final line this reader has always tolerated:
 * recovery must not invent record out of a prefix.
 *
 * Duplicated from the shell shim's reader rather than shared: both packages are published on their
 * own and deliberately carry no dependency that could pull a runtime into the agent's process, so
 * there is no module both can import. They are kept identical on purpose — two readers of an
 * append-only file drifting apart is the bug this pair keeps producing.
 */
export function recordsOnLine(line: string): string[] {
  const values: string[] = [];
  let from = 0;
  while (from < line.length) {
    const end = endOfObject(line, from);
    if (end === -1) {
      // Nothing starting here is a whole object, so these bytes are a fragment. Something that
      // begins after them may still be whole, so look rather than give up on the line.
      const next = line.indexOf('{', from + 1);
      if (next === -1) break;
      from = next;
      continue;
    }
    values.push(line.slice(from, end));
    from = end;
  }
  return values;
}

function toRecord(name: string, dir: FrameDirection, frame: JsonRpcFrame): string {
  const record: McpFrameRecord = {
    ts: new Date().toISOString(),
    name,
    dir,
    kind: frame.kind,
    raw: frame.raw,
  };
  if (frame.id !== undefined) record.id = frame.id;
  if (frame.method !== undefined) record.method = frame.method;
  return `${JSON.stringify(record)}\n`;
}

/** A mock's answer in the same capture format the pass-through shim writes. */
function toMockRecord(name: string, dir: FrameDirection, message: JsonRpcMessage): string {
  const raw = JSON.stringify(message);
  const record: McpFrameRecord = {
    ts: new Date().toISOString(),
    name,
    dir,
    kind:
      message.method === undefined
        ? 'response'
        : message.id === undefined
          ? 'notification'
          : 'request',
    raw,
  };
  if (message.id !== undefined) record.id = message.id;
  if (message.method !== undefined) record.method = message.method;
  return `${JSON.stringify(record)}
`;
}

/** The frames this server produced, read back out of a capture several servers may share. */
async function readFrames(path: string, name: string): Promise<RecordedFrame[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  const frames: RecordedFrame[] = [];
  for (const piece of text.split(/\r?\n/).flatMap((line) => recordsOnLine(line))) {
    if (piece.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(piece);
    } catch {
      continue;
    }
    // The `--replay` reader, so a torn line in a *recording* used to kill the replay of it rather
    // than cost one frame: the shim died before serving a single recorded answer, every MCP server
    // in the run with it.
    if (!isMcpFrameRecord(value)) continue;
    const record = value;
    if (record.name !== name) continue;
    let message: unknown;
    try {
      message = JSON.parse(record.raw);
    } catch {
      // A line the shim saw but could not parse is still in the capture; it just cannot answer.
      continue;
    }
    // Neither can one that parsed to something that is not a message, and `JSON.parse` is happy
    // with those: a bare `null` line from a server is recorded as `raw: "null"` — a perfectly
    // well-formed record — so it went straight past the guard above and was cast to a message.
    // `indexFrames` then read `.id` off `null`, and `runMock` indexes before it answers anything,
    // so one such line anywhere in a recording killed the whole replay at startup and every MCP
    // server in the run with it. Recording tolerated it and replay did not, which is the asymmetry
    // this reader exists to close.
    if (!isJsonRpcMessage(message)) continue;
    frames.push({
      server: record.name,
      direction: record.dir === 'in' ? 'in' : 'out',
      at: record.ts,
      ...(record.id === undefined ? {} : { id: record.id }),
      ...(record.method === undefined ? {} : { method: record.method }),
      message: message as JsonRpcMessage,
    });
  }
  return frames;
}

export async function main(argv: string[], io: ShimCliIo = {}): Promise<number> {
  const parsed = parseArgs(argv);

  // Append: several servers in one run may share a capture file, and a rerun must not erase it.
  const sink = parsed.out ? createWriteStream(parsed.out, { flags: 'a' }) : undefined;
  if (sink) {
    // The server keeps running whatever happens to the capture — but an empty trace with no
    // explanation is its own debugging problem, so say it once on stderr.
    sink.once('error', (err: Error) => {
      (io.stderr ?? process.stderr).write(
        `orca-mcp-shim: capture to ${parsed.out} disabled: ${err.message}\n`,
      );
    });
    sink.on('error', () => {});
  }

  try {
    // Replay: answer from the recording and never start the server. The command is still parsed,
    // because the config the agent reads is the same file either way — what changes is whether
    // orca runs what it names. Frames are still written, so the replay is a readable run of its
    // own rather than one whose MCP layer left no trace at all.
    if (parsed.replay !== undefined) {
      const frames = await readFrames(parsed.replay, parsed.name);
      return await runMock({
        name: parsed.name,
        frames,
        onMiss: (method: string) =>
          (io.stderr ?? process.stderr).write(
            `orca-mcp-shim: no recorded response for ${method} on ${parsed.name}
`,
          ),
        ...(sink
          ? {
              onFrame: (dir: 'in' | 'out', message: JsonRpcMessage) =>
                void sink.write(toMockRecord(parsed.name, dir, message)),
            }
          : {}),
        ...(io.stdin ? { stdin: io.stdin } : {}),
        ...(io.stdout ? { stdout: io.stdout } : {}),
      });
    }

    return await runShim({
      name: parsed.name,
      command: parsed.command,
      args: parsed.args,
      ...(sink
        ? { onFrame: (dir, frame) => void sink.write(toRecord(parsed.name, dir, frame)) }
        : {}),
      ...io,
    });
  } finally {
    if (sink) {
      await new Promise<void>((resolve) => {
        sink.once('close', () => resolve());
        sink.end(() => resolve());
      });
    }
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // realpath both sides: npm installs the bin as a symlink, and argv[1] is the link path.
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // Nothing is left to read; let the loop drain the last writes and exit on its own.
      process.stdin.pause();
    },
    (err: Error) => {
      process.stderr.write(`orca-mcp-shim: ${err.message}\n`);
      process.exitCode = 1;
      process.stdin.pause();
    },
  );
}
