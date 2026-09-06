import { access, constants, open, realpath, stat } from 'node:fs/promises';
import { delimiter, extname, join, resolve } from 'node:path';

/**
 * Find the real binary a shim is standing in for.
 *
 * The shim directory is prepended to PATH, so the one thing this must never do is return the
 * shim itself: that is an exec loop, and it would happen inside the user's agent run rather than
 * anywhere convenient. Comparison is by resolved real path, because PATH routinely contains the
 * same directory spelled several ways (`/x`, `/x/.`, a symlink) and a string compare misses those.
 *
 * One directory is not enough to exclude, though. A run inside a run — or an agent that records
 * things for a living and is now being recorded — has *another* run's shim directory on PATH, and
 * a `sh` found there is a shim script, not a binary: spawning it re-runs the runner, which
 * resolves again, and the command hangs in a hundred-deep exec loop until something kills it. The
 * shim scripts carry a marker comment, so anything carrying it is refused no matter which
 * directory it sits in.
 */
const SHIM_MARKER = 'orca record';

export async function resolveRealBinary(
  name: string,
  pathVar: string,
  shimDir: string,
): Promise<string | undefined> {
  const shimReal = await safeRealpath(resolve(shimDir));

  for (const entry of pathVar.split(delimiter)) {
    if (entry === '') continue;
    const dirReal = await safeRealpath(resolve(entry));
    if (dirReal !== undefined && shimReal !== undefined && dirReal === shimReal) continue;

    for (const candidateName of candidateNames(name)) {
      const candidate = join(entry, candidateName);
      if (await isExecutableFile(candidate)) {
        if (await isOrcaShim(candidate)) continue;
        return candidate;
      }
    }
  }
  // Deliberately undefined rather than a guess: exec'ing the wrong binary is worse than a clear
  // error the caller can report.
  return undefined;
}

/**
 * Whether the file is one of orca's own shim scripts, identified by its marker comment.
 *
 * Read from the head of the file: a script's shebang-and-comment block sits in the first few
 * hundred bytes, and anything else on PATH is a binary whose first bytes are safe to read and
 * discard. A file that cannot be read is not a shim — the exec attempt will say what is wrong
 * with it.
 */
async function isOrcaShim(path: string): Promise<boolean> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (handle === undefined) return false;
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(SHIM_MARKER);
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

async function safeRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    // Windows does not expose POSIX execute bits. The extension/PATHEXT lookup above is the
    // executable check there; stat keeps a valid .exe/.cmd/.bat discoverable on that platform.
    if (process.platform === 'win32') return (await stat(path)).isFile();
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(name: string): string[] {
  if (process.platform !== 'win32' || extname(name) !== '') return [name];
  const pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return [
    name,
    ...pathext
      .split(';')
      .filter(Boolean)
      .map((ext) => `${name}${ext.toLowerCase()}`),
  ];
}
