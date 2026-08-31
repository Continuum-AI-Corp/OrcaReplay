import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, extname, join } from 'node:path';

/**
 * Detection runs before every recording, and a detector that throws would take the whole run with
 * it. Every helper here answers false instead of failing.
 */
export async function hasBinary(name: string): Promise<boolean> {
  if (process.platform === 'win32') {
    return (await resolveWindowsBinary(name, process.env.PATH ?? '')) !== undefined;
  }

  return new Promise((resolve) => {
    // execFile, never a shell: `name` reaches the lookup as one argv element, so an agent id
    // carrying shell metacharacters cannot become a command.
    execFile('which', [name], { timeout: 5_000 }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

/**
 * The path a launcher must actually spawn, or undefined when the name is not on PATH.
 *
 * Detection and launching have to agree. On Windows an npm-installed agent is three shims —
 * `claude`, `claude.cmd`, `claude.ps1` — and only the `.cmd` is something `CreateProcess` will
 * run. `spawn` does no PATHEXT resolution of its own, so a launcher handed the bare name finds
 * the extensionless shell script, cannot execute it, and reports ENOENT for an agent that
 * `orca doctor` had just called present. Resolving here, against the same PATHEXT walk detection
 * uses, is what keeps the two answers the same.
 *
 * Not `shell: true`: that would hand the agent's own arguments to a command interpreter.
 */
export async function resolveBinary(name: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return name;
  // An explicit path is already the answer; PATH does not enter into it.
  if (name.includes('/') || name.includes('\\')) return name;
  return resolveWindowsBinary(name, process.env.PATH ?? '');
}

/** What `spawn` must actually be given to launch `command` with `args`. */
export interface LaunchTarget {
  file: string;
  args: string[];
  /** True only for a Windows batch shim, which `spawn` refuses to run any other way. */
  shell: boolean;
}

/** cmd.exe reads these before the program does, so they have to be escaped for it first. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Quote one argument so that cmd.exe hands the program back exactly the string we started with.
 *
 * Two parsers run in sequence: cmd.exe strips `^` escapes, then the program's own CommandLineToArgv
 * splits what is left. So the backslash-before-quote doubling has to happen first, and the `^`
 * escaping of everything — the quotes we just added included — second.
 */
function quoteForCmd(arg: string): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"');
  quoted = quoted.replace(/(\\*)$/, '$1$1');
  return `"${quoted}"`.replace(CMD_META, '^$&');
}

/**
 * Resolve a command to something `spawn` can launch on this platform.
 *
 * Windows makes this three cases rather than one. An npm-installed agent is a set of shims —
 * `claude`, `claude.cmd`, `claude.ps1` — and `spawn` does no PATHEXT resolution, so the bare name
 * finds the extensionless shell script and fails ENOENT. Resolving to the `.cmd` then hits the
 * second wall: since the batch-injection fix, Node refuses to spawn `.cmd` or `.bat` without a
 * shell and answers EINVAL. Only a batch shim needs that shell, and only then do the arguments
 * have to survive cmd.exe, which is what the quoting is for. A real `.exe` still spawns directly.
 */
export async function resolveLaunch(command: string, args: string[]): Promise<LaunchTarget> {
  if (process.platform !== 'win32') return { file: command, args, shell: false };
  const file = (await resolveBinary(command)) ?? command;
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args, shell: false };
  return { file: quoteForCmd(file), args: args.map(quoteForCmd), shell: true };
}

async function resolveWindowsBinary(name: string, pathVar: string): Promise<string | undefined> {
  const extensions =
    extname(name) !== ''
      ? ['']
      : (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const entry of pathVar.split(delimiter)) {
    if (entry === '') continue;
    for (const extension of extensions) {
      const candidate = join(entry, `${name}${extension.toLowerCase()}`);
      try {
        if ((await stat(candidate)).isFile()) {
          await access(candidate);
          return candidate;
        }
      } catch {
        // Keep searching the rest of PATH. Detection must never take the CLI down.
      }
    }
  }
  return undefined;
}

/**
 * The home directory as the *child process* will see it. A host that hands us a rebuilt env object
 * detaches `process.env` from the OS environment, and `os.homedir()` then answers for a home the
 * agent will never be launched with — so the JS-visible value wins where it is set.
 */
export function homeDir(): string {
  return process.env['HOME'] || process.env['USERPROFILE'] || homedir();
}

/** True when `~/<relative>` exists — the cheap "this agent has been run here before" signal. */
export function homeDirHas(relative: string): boolean {
  try {
    return existsSync(join(homeDir(), relative));
  } catch {
    return false;
  }
}

/** True when any of the given binaries or home-relative config paths is present. */
export async function detectAgent(binaries: string[], homePaths: string[]): Promise<boolean> {
  if (homePaths.some(homeDirHas)) return true;
  for (const bin of binaries) {
    if (await hasBinary(bin)) return true;
  }
  return false;
}
