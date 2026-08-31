#!/usr/bin/env node
import { createWriteStream, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { runMock, type JsonRpcMessage, type RecordedFrame } from './mock.js';
import { fileURLToPath } from 'node:url';
import type { JsonRpcFrame } from './framing.js';
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
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let record: McpFrameRecord;
    try {
      record = JSON.parse(line) as McpFrameRecord;
    } catch {
      continue;
    }
    if (record.name !== name) continue;
    let message: unknown;
    try {
      message = JSON.parse(record.raw);
    } catch {
      // A line the shim saw but could not parse is still in the capture; it just cannot answer.
      continue;
    }
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
