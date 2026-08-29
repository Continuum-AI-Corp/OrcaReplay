import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ShellFrame } from './runner.js';

/** Shells an agent actually reaches for. Shimming more binaries buys detail and costs blast radius. */
export const DEFAULT_SHIMS = ['sh', 'bash'] as const;

export interface InstallOptions {
  runDir: string;
  /** Defaults to `<runDir>/shell-frames.jsonl`. */
  framesPath?: string;
  shims?: readonly string[];
}

export interface InstalledShim {
  /** Prepend this to PATH. */
  dir: string;
  framesPath: string;
  shimmed: string[];
  /** Environment overlay the child needs for the shims to work. */
  env: Record<string, string>;
}

/**
 * Write a directory of shim executables to prepend to PATH.
 *
 * Each shim is a POSIX `sh` script rather than a Node script, for one specific reason: its shebang
 * names an absolute interpreter, so it never consults PATH to start — and PATH is exactly where
 * our own shims live. A `#!/usr/bin/env node` shebang would resolve through the directory we just
 * poisoned.
 */
export async function installShellShim(options: InstallOptions): Promise<InstalledShim> {
  const dir = join(options.runDir, 'shims');
  const framesPath = options.framesPath ?? join(options.runDir, 'shell-frames.jsonl');
  const shims = options.shims ?? DEFAULT_SHIMS;

  await mkdir(dir, { recursive: true });

  const runner = await resolveRunnerBin();
  const node = process.execPath;

  for (const name of shims) {
    const script = [
      '#!/bin/sh',
      '# Written by orca record. Runs the real binary and notes what happened.',
      `exec ${quote(node)} ${quote(runner)} ${quote(name)} ${quote(dir)} ${quote(framesPath)} -- "$@"`,
      '',
    ].join('\n');
    const path = join(dir, name);
    await writeFile(path, script, { mode: 0o755 });
    await chmod(path, 0o755);
  }

  await writeFile(framesPath, '', { flag: 'a', mode: 0o600 }).catch(() => {
    // An unwritable frames file must not stop the run; the shim swallows write errors too.
  });

  return {
    dir,
    framesPath,
    shimmed: [...shims],
    env: { ORCA_SHIM_DIR: dir, ORCA_SHIM_FRAMES: framesPath },
  };
}

/** Read back what the shims observed. Tolerates a partial final line, like events.jsonl. */
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

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
