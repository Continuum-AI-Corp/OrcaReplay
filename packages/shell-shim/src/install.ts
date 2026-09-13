import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ShellFrame } from './runner.js';

/**
 * Shells an agent actually reaches for. Shimming more binaries buys detail and costs blast radius.
 *
 * `zsh` is here because of how harnesses resolve their shell rather than despite it: OpenCode
 * reads `$SHELL` and execs that binary by absolute path, so a PATH shim in front of `bash` and
 * `sh` alone sat unused on every macOS run while the shell tool happily used `/bin/zsh`. The
 * adapter points `$SHELL` at the shim instead, which requires a shim named `zsh` to exist.
 */
export const DEFAULT_SHIMS = ['sh', 'bash', 'zsh'] as const;

export interface InstallOptions {
  runDir: string;
  /**
   * Defaults to a private temporary directory, not the run directory.
   *
   * The frames file is a transport: orca reads it once, turns each frame into a `shell.*` event,
   * and those reach disk through `TraceWriter`, which redacts. The file itself is written by the
   * shim running inside the agent's own shell invocations, so nothing orca owns can redact it on
   * the way in — and a frame carries `argv` and `cwd` verbatim, which is the most secret-dense
   * text in a run: `curl -H 'Authorization: Bearer …'`, `git clone https://user:token@host/…`,
   * an inline `AWS_SECRET_ACCESS_KEY=…`.
   *
   * While it sat in the run directory that made it a sink the write path never touched, `orca
   * scrub` never rewrote, and nobody deleted — so `orca scrub --match <secret>` answered "nothing
   * matched — the trace is unchanged" with the secret still beside the trace.
   */
  framesPath?: string;
  shims?: readonly string[];
}

export interface InstalledShim {
  /** Prepend this to PATH. */
  dir: string;
  framesPath: string;
  /** The directory holding {@link framesPath}, for {@link discardShellFrames}. */
  transportDir: string;
  shimmed: string[];
  /** Environment overlay the child needs for the shims to work. */
  env: Record<string, string>;
}

/**
 * Write a directory of shim executables to prepend to PATH.
 *
 * On POSIX, each shim is a small shell script whose shebang names an absolute interpreter, so it
 * never consults PATH to start — and PATH is exactly where our own shims live. Windows cannot
 * execute an extensionless script from PATH, so it gets a `.cmd` shim with the same argv contract.
 */
export async function installShellShim(options: InstallOptions): Promise<InstalledShim> {
  const dir = join(options.runDir, 'shims');
  const transportDir = options.framesPath
    ? dirname(options.framesPath)
    : await mkdtemp(join(tmpdir(), 'orca-shell-'));
  const framesPath = options.framesPath ?? join(transportDir, 'shell-frames.jsonl');
  const shims = options.shims ?? DEFAULT_SHIMS;

  await mkdir(dir, { recursive: true });

  const runner = await resolveRunnerBin();
  const node = process.execPath;
  const windows = process.platform === 'win32';

  for (const name of shims) {
    const script = windows
      ? [
          '@echo off',
          'rem Written by orca record. Runs the real binary and notes what happened.',
          `${quoteCmd(node)} ${quoteCmd(runner)} ${quoteCmd(name)} ${quoteCmd(dir)} ${quoteCmd(framesPath)} -- %*`,
          'exit /b %ERRORLEVEL%',
          '',
        ].join('\r\n')
      : [
          '#!/bin/sh',
          '# Written by orca record. Runs the real binary and notes what happened.',
          `exec ${quotePosix(node)} ${quotePosix(runner)} ${quotePosix(name)} ${quotePosix(dir)} ${quotePosix(framesPath)} -- "$@"`,
          '',
        ].join('\n');
    const path = join(dir, windows ? `${name}.cmd` : name);
    await writeFile(path, script, { mode: 0o755 });
    await chmod(path, 0o755);
  }

  await writeFile(framesPath, '', { flag: 'a', mode: 0o600 }).catch(() => {
    // An unwritable frames file must not stop the run; the shim swallows write errors too.
  });

  return {
    dir,
    framesPath,
    transportDir,
    shimmed: [...shims],
    env: { ORCA_SHIM_DIR: dir, ORCA_SHIM_FRAMES: framesPath },
  };
}

/** Read back what the shims observed. Tolerates a partial final line, like events.jsonl. */
/**
 * Take the transport away once it has been read.
 *
 * The directory, not the file: nothing else was ever put in it, and removing the directory also
 * takes anything a shell that outlived the run wrote beside the file afterwards. Returns a message
 * rather than throwing — a run that produced a trace must not fail at teardown.
 */
export async function discardShellFrames(dir: string): Promise<string | undefined> {
  try {
    await rm(dir, { recursive: true, force: true });
    return undefined;
  } catch (err) {
    return String(err);
  }
}

export async function readShellFrames(framesPath: string): Promise<ShellFrame[]> {
  const raw = await readFile(framesPath, 'utf8').catch(() => '');
  const frames: ShellFrame[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      frames.push(JSON.parse(line) as ShellFrame);
    } catch {
      // A process killed mid-write leaves a partial line. That is the run we most want to read.
    }
  }
  return frames;
}

/**
 * Locate the compiled shim entry point.
 *
 * This module is loaded from `dist/` in a real install but from `src/` when the workspace aliases
 * packages to source, and only the compiled `.js` can actually be exec'd. Resolving by probing
 * rather than assuming means the shim works in both, and fails with a sentence instead of an
 * empty stdout when it works in neither.
 */
export async function resolveRunnerBin(): Promise<string> {
  const candidates = [
    new URL('./runner-bin.js', import.meta.url),
    new URL('../dist/runner-bin.js', import.meta.url),
  ].map((url) => fileURLToPath(url));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next layout
    }
  }
  throw new Error(
    `orca shell-shim: no compiled runner found (looked in ${candidates.join(', ')})\n` +
      '  run `npm run build` before recording with shell capture',
  );
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
