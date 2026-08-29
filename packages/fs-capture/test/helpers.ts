import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

/** realpath() matters on macOS, where os.tmpdir() is a symlink and git reports the real path. */
export async function makeTempDir(prefix = 'orca-fs-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** Sorted paths of every regular file under `dir`, relative to it and slash-separated. */
export async function listFilesRecursive(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFilesRecursive(join(dir, entry.name), rel)));
    else found.push(rel);
  }
  return found.sort();
}
