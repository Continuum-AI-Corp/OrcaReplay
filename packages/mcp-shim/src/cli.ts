#!/usr/bin/env node
import { createWriteStream, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JsonRpcFrame } from './framing.js';
import { runShim } from './shim.js';
import type { FrameDirection } from './shim.js';

export interface ShimCliArgs {
  name: string;
  out?: string;
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
  let i = 0;

  for (; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') break;
    if (arg === '--name' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value === '--') fail(`${arg} needs a value`);
      if (arg === '--name') name = value;
      else out = value;
      i += 1;
      continue;
    }
    fail(`unexpected argument '${arg}'`);
  }

  if (name === undefined) fail('--name is required: it labels this server in the trace');
  if (argv[i] !== '--') fail("missing '--' separator before the MCP server command");
  const command = argv[i + 1];
  if (command === undefined) fail("no command after '--': give the MCP server to launch");

  return { name, out, command, args: argv.slice(i + 2) };
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
