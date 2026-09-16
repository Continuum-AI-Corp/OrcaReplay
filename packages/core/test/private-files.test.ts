import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { restrictToOwner } from '../src/private-files.js';

const run = promisify(execFile);
const onWindows = process.platform === 'win32';

/** Absolute, as the implementation is: Git for Windows ships a POSIX `whoami` earlier on PATH. */
const system32 = (exe: string): string =>
  join(process.env['SystemRoot'] ?? 'C:\Windows', 'System32', exe);

/** SDDL's fixed abbreviations. The superusers, which reach a 0600 file on POSIX too, as root. */
const BUILTIN = { BA: 'S-1-5-32-544', SY: 'S-1-5-18' } as const;

/**
 * The ACL of a path, as SDDL.
 *
 * `icacls` prints trustee *names* by default and those are localized — a test matching
 * `BUILTIN\Users` would pass on a German machine by failing to find what it was looking for.
 * `/save` writes SDDL instead, which is SIDs. (`Get-Acl` would be the obvious tool and is not
 * dependable: PowerShell cannot autoload `Microsoft.PowerShell.Security` on every machine.)
 */
async function sddl(path: string): Promise<string> {
  const out = join(await mkdtemp(join(tmpdir(), 'orca-sddl-')), 'acl');
  await run(system32('icacls.exe'), [path, '/save', out]);
  // UTF-16LE, and two lines: the entry's name, then its descriptor.
  const lines = (await readFile(out, 'utf16le')).trim().split(/\r?\n/);
  return lines[1]!.trim();
}

/** Every trustee in a DACL, by SID, with `BA`/`SY` expanded. */
function trustees(descriptor: string): string[] {
  const found = [...descriptor.matchAll(/\(A;[^;]*;[^;]*;[^;]*;[^;]*;([^)]+)\)/g)].map(
    (m) => BUILTIN[m[1] as keyof typeof BUILTIN] ?? m[1]!,
  );
  return [...new Set(found)].sort();
}

/** `P` in the DACL flags: this path no longer inherits anything. */
function isProtected(descriptor: string): boolean {
  return (/^D:([A-Z]*)/.exec(descriptor)?.[1] ?? '').includes('P');
}

let ownerOnly: string[];
beforeAll(async () => {
  if (!onWindows) return;
  const { stdout } = await run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  ownerOnly = [/S-1-[\d-]+/.exec(stdout)![0], BUILTIN.BA, BUILTIN.SY].sort();
});

/**
 * 0600 and 0700, on a filesystem that has no such thing.
 *
 * `chmod` on Windows sets the read-only attribute; the mode is discarded and `stat` answers 0o666
 * whatever was asked for. That had been read as an assertion the platform *cannot provide* — but
 * the file does have permissions there, spelled as an ACL, and a run directory under a workspace
 * inherits one granting read to every account on the machine. So the run CA's private key and the
 * gateway API key in `config.json` were readable by all of them.
 *
 * These tests are the same promise, checked in the currency each platform keeps it in.
 */
describe('restrictToOwner', () => {
  it.runIf(!onWindows)('gives POSIX exactly the mode it was asked for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-perm-'));
    const file = join(dir, 'secret');
    await writeFile(file, 'sk-secret\n', { mode: 0o666 });

    await restrictToOwner(dir, 0o700);
    await restrictToOwner(file, 0o600);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it.runIf(onWindows)(
    'leaves a file to its owner and the superusers, and no one else',
    async () => {
      const file = join(await mkdtemp(join(tmpdir(), 'orca-perm-')), 'secret');
      await writeFile(file, 'sk-secret\n');

      // The control, and the reason this exists: a file written the ordinary way carries whatever
      // the location handed down — here two further accounts, every ACE flagged inherited.
      const before = await sddl(file);
      expect(isProtected(before)).toBe(false);
      expect(trustees(before)).not.toEqual(ownerOnly);

      await restrictToOwner(file, 0o600);

      const after = await sddl(file);
      // Inheritance is the whole problem: every over-broad grant arrived that way.
      expect(isProtected(after)).toBe(true);
      expect(trustees(after)).toEqual(ownerOnly);
    },
  );

  it.runIf(onWindows)(
    'restricts a directory so that later writes inside it are covered',
    async () => {
      const dir = join(await mkdtemp(join(tmpdir(), 'orca-perm-')), 'tls');
      await mkdir(dir);

      await restrictToOwner(dir, 0o700);
      expect(isProtected(await sddl(dir))).toBe(true);

      // Written *after* the restriction, and never restricted itself. On a tree of many files this
      // inheritance is the only affordable way to hold the line — one call, not one per file.
      const later = join(dir, 'written-later');
      await writeFile(later, 'x');

      expect(trustees(await sddl(later))).toEqual(ownerOnly);
    },
  );
});
