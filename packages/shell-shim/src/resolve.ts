import { access, constants, realpath, stat } from 'node:fs/promises';
import { delimiter, extname, join, resolve } from 'node:path';

/**
 * Find the real binary a shim is standing in for.
 *
 * The shim directory is prepended to PATH, so the one thing this must never do is return the
 * shim itself: that is an exec loop, and it would happen inside the user's agent run rather than
 * anywhere convenient. Comparison is by resolved real path, because PATH routinely contains the
 * same directory spelled several ways (`/x`, `/x/.`, a symlink) and a string compare misses those.
 */
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
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  // Deliberately undefined rather than a guess: exec'ing the wrong binary is worse than a clear
  // error the caller can report.
  return undefined;
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
