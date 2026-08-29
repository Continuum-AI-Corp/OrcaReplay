import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { JsonRpcFramer } from './framing.js';
import type { JsonRpcFrame } from './framing.js';

/** Direction of a frame: `in` is agent to server, `out` is server to agent. */
export type FrameDirection = 'in' | 'out';

export interface ShimOptions {
  /** Server name from the rewritten MCP config, carried into the capture. */
  name: string;
  command: string;
  args: string[];
  onFrame?: (dir: FrameDirection, frame: JsonRpcFrame) => void;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** The signals a parent agent uses to stop a server; the child, not us, decides what they mean. */
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) {
    const number = constants.signals[signal];
    return typeof number === 'number' ? 128 + number : 1;
  }
  return 0;
}

/**
 * Runs the real MCP server as a child and passes both directions through byte for byte, teeing a
 * parsed copy of each JSON-RPC frame to `onFrame`.
 *
 * Fidelity beats completeness here: the bytes are piped (so backpressure and ordering are the
 * stream layer's business, not ours) and the capture only ever observes a copy. Anything the
 * capture side does wrong — a parse failure, a throwing callback — is swallowed, because a
 * debugger that breaks the thing it is debugging is worse than no debugger.
 */
export function runShim(opts: ShimOptions): Promise<number> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  const launchFailure = (err: Error): Error =>
    new Error(`failed to launch MCP server '${opts.name}' (${opts.command}): ${err.message}`, {
      cause: err,
    });

  return new Promise<number>((resolve, reject) => {
    let child;
    try {
      // Some launch failures (an argv over the OS limit) throw here rather than emitting 'error'.
      child = spawn(opts.command, opts.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(launchFailure(err as Error));
      return;
    }
    let settled = false;

    const emit = (dir: FrameDirection, frames: JsonRpcFrame[]): void => {
      const onFrame = opts.onFrame;
      if (!onFrame) return;
      for (const frame of frames) {
        try {
          onFrame(dir, frame);
        } catch {
          // Capture is a side channel. It never gets a vote on the agent's traffic.
        }
      }
    };

    const tee = (source: NodeJS.ReadableStream, dir: FrameDirection): ((chunk: Buffer) => void) => {
      const framer = new JsonRpcFramer();
      const onData = (chunk: Buffer): void => emit(dir, framer.push(chunk));
      source.on('data', onData);
      source.on('end', () => emit(dir, framer.flush()));
      return onData;
    };

    // A closed pipe (the child exits while the agent is still writing) is normal shutdown, not an
    // error to crash on.
    const ignore = (): void => {};
    child.stdin.on('error', ignore);
    stdout.on('error', ignore);
    stderr.on('error', ignore);

    stdin.pipe(child.stdin);
    const onStdinData = tee(stdin, 'in');
    // The agent's stdout is not ours to close: keep it open for whatever runs after us.
    child.stdout.pipe(stdout, { end: false });
    tee(child.stdout, 'out');
    child.stderr.pipe(stderr, { end: false });

    const forward = FORWARDED_SIGNALS.map((signal) => {
      const handler = (): void => {
        child.kill(signal);
      };
      process.on(signal, handler);
      return { signal, handler };
    });

    const cleanup = (): void => {
      for (const { signal, handler } of forward) process.removeListener(signal, handler);
      stdin.removeListener('data', onStdinData);
      stdin.unpipe(child.stdin);
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(launchFailure(err));
    });

    // 'close' rather than 'exit': by then every stdio stream has flushed and ended, so no captured
    // byte is lost to a race with the exit code.
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(exitCodeFor(code, signal));
    });
  });
}
