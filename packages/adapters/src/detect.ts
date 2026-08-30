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
  if (process.platform === 'win32') return hasWindowsBinary(name, process.env.PATH ?? '');

  return new Promise((resolve) => {
    // execFile, never a shell: `name` reaches the lookup as one argv element, so an agent id
    // carrying shell metacharacters cannot become a command.
    execFile('which', [name], { timeout: 5_000 }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

async function hasWindowsBinary(name: string, pathVar: string): Promise<boolean> {
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
          return true;
        }
      } catch {
        // Keep searching the rest of PATH. Detection must never take the CLI down.
      }
    }
  }
  return false;
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
