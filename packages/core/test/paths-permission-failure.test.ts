import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The permission call refusing, which is a filesystem away rather than a bug.
 *
 * `mkdir`'s `mode` is a request: a filesystem without permissions ignores it and reports success.
 * `chmod` on that same filesystem fails — EPERM on vfat, ENOTSUP elsewhere — so a call that was
 * added for tidiness aborts whatever was going to be written. `ensureRunsDir` is the first thing
 * `record`, `attach`, `replay`, `pull` and `quickstart` all do, which makes it the worst place to
 * put one: an exFAT or vfat workspace that recorded before would stop recording at all.
 *
 * Mocked rather than staged on a real volume, because the machine this was written on has only
 * NTFS and CI only ext4 — the condition is not reachable by arranging a directory, only by
 * arranging the failure.
 */
vi.mock('../src/private-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/private-files.js')>()),
  restrictToOwner: vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error('EPERM: operation not permitted, chmod'), { code: 'EPERM' }),
    ),
}));

const { ensureRunsDir, runsDir } = await import('../src/paths.js');

describe('ensureRunsDir when the permission call refuses', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-perm-fail-'));
  });

  /**
   * POSIX: the store is already what it should be. umask can only clear bits, so
   * `mkdir(0o700)` has given at most 0700 and the call only restores what an exotic umask took
   * away — worth losing on a filesystem that cannot answer. `sync.ts` swallows the same call in
   * three places for the same reason.
   */
  it.runIf(process.platform !== 'win32')('records anyway, as it did before', async () => {
    await expect(ensureRunsDir(cwd)).resolves.toBe(runsDir(cwd));
  });

  /**
   * Windows: the mode was discarded and this call is the entire protection, so a refusal has to
   * stop the recording rather than produce a store the machine can read.
   */
  it.runIf(process.platform === 'win32')('refuses, rather than recording unprotected', async () => {
    await expect(ensureRunsDir(cwd)).rejects.toThrow(/not permitted/);
  });
});
