import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveRealBinary } from './resolve.js';

/**
 * What the shim records about one shell invocation.
 *
 * Deliberately not the output itself. The model already sees a rendering of stdout via the tool
 * result; what it never sees — and what the protocol layer therefore cannot recover — is the exit
 * code, the wall duration, the real argv, and which stream each byte came out of.
 */
export interface ShellFrame {
  name: string;
  argv: string[];
  cwd: string;
  exitCode: number;
  signal: string | null;
  startedAt: string;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface RunShimOptions {
  name: string;
  argv: string[];
  shimDir: string;
  framesPath: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Stand in for one shell binary: run the real one, forward everything, write down what happened.
 *
 * Two rules, both about not being noticed. The passthrough must be byte-faithful, so stdio is
 * inherited outright rather than piped — piping would let us count bytes but would also strip the
 * TTY, and a harness that checks `isatty` would change its behaviour because we were watching.
 * And every capture-side failure is swallowed: losing a frame costs a line in the trace, whereas
 * throwing here breaks the command the user was actually running.
 */
export async function runShim(options: RunShimOptions): Promise<number> {
  const real = await resolveRealBinary(options.name, options.env.PATH ?? '', options.shimDir);

  if (real === undefined) {
    process.stderr.write(
      `orca shell-shim: cannot find the real "${options.name}" on PATH.\n` +
        `  the shim directory is ${options.shimDir}\n` +
        `  re-run without recording, or report this with your PATH\n`,
    );
    return 127;
  }

  const startedAt = new Date();
  const startedNs = process.hrtime.bigint();

  // Counting bytes requires piping, which removes the TTY. Only do it when there is no TTY to
  // remove — under `orca record` the agent has already given us pipes, which is the case we care
  // about, and an interactive terminal keeps its exact behaviour.
  const canCount = !process.stdout.isTTY && !process.stderr.isTTY;

  const child = spawn(real, options.argv, {
    env: options.env,
    stdio: canCount ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  });

  let stdoutBytes = 0;
  let stderrBytes = 0;
  if (canCount) {
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      process.stderr.write(chunk);
    });
  }

  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  const onInt = forward('SIGINT');
  const onTerm = forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  const { code, signal } = await new Promise<{ code: number; signal: string | null }>((resolve) => {
    child.on('error', (err) => {
      process.stderr.write(`orca shell-shim: could not run ${real}: ${String(err)}\n`);
      resolve({ code: 127, signal: null });
    });
    child.on('close', (c, s) => resolve({ code: c ?? 0, signal: s }));
  });

  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);

  record(options.framesPath, {
    name: options.name,
    argv: options.argv,
    cwd: process.cwd(),
    exitCode: code,
    signal,
    startedAt: startedAt.toISOString(),
    durationMs: Number((process.hrtime.bigint() - startedNs) / 1_000_000n),
    stdoutBytes,
    stderrBytes,
  });

  return code;
}

function record(framesPath: string, frame: ShellFrame): void {
  try {
    // Synchronous and append-only: the process is about to exit, and a lost write here would be
    // invisible. One line per invocation keeps the file greppable like events.jsonl.
    appendFileSync(framesPath, `${JSON.stringify(frame)}\n`, { mode: 0o600 });
  } catch {
    // Capture is best-effort by design. See the note on runShim.
  }
}

/**
 * Entry point the generated shim scripts call:
 * `node runner-bin.js <name> <shimDir> <framesPath> -- [args...]`
 *
 * The three shim parameters arrive as argv, not environment. An agent is entitled to sanitise the
 * environment of the commands it runs, and if it did, an env-carried shim would keep working while
 * silently capturing nothing — the exact failure mode this whole layer exists to avoid.
 */
export async function main(argv: string[]): Promise<number> {
  const separator = argv.indexOf('--');
  const [name, shimDir, framesPath] =
    separator === -1 ? [argv[0], argv[1], argv[2]] : argv.slice(0, separator);
  const rest = separator === -1 ? argv.slice(3) : argv.slice(separator + 1);

  if (!name || !shimDir || !framesPath) {
    process.stderr.write(
      'orca shell-shim: invoked without its shim parameters; not launched by orca record\n',
    );
    return 127;
  }
  return runShim({
    name: basename(name),
    argv: rest,
    shimDir,
    framesPath,
    env: process.env,
  });
}
