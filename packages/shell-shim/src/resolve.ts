import { access, constants, realpath } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

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

    const candidate = join(entry, name);
    if (await isExecutableFile(candidate)) return candidate;
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
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
