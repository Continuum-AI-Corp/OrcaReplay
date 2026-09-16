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
  join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', exe);

/**
 * SDDL's fixed abbreviations for the well-known SIDs that turn up here. `BA` and `SY` are the
 * superusers, which reach a 0600 file on POSIX too, as root; `BU` is BUILTIN\\Users, which is what
 * a store must never grant and what the tests plant in order to check that it does not.
 */
const BUILTIN = { BA: 'S-1-5-32-544', SY: 'S-1-5-18', BU: 'S-1-5-32-545' } as const;

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

/** Every trustee in a DACL, by SID, with the abbreviations above expanded. */
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

  it.runIf(onWindows)('never widens the path it is narrowing, even for an instant', async () => {
    // `/reset` is the obvious way to clear explicit ACEs and the wrong one: it hands the path
    // whatever its parent has, and only a second call narrows it again. `.orca` is never
    // restricted — only `.orca/runs` is — so on every Windows command the store root would spend
    // that window readable by every account on the machine, and a child created in it keeps what
    // it inherited, since icacls does not re-propagate afterwards.
    //
    // A detector, not a proof: it can only fail while such a window exists, never spuriously.
    const parent = await mkdtemp(join(tmpdir(), 'orca-perm-'));
    await run(system32('icacls.exe'), [parent, '/grant', '*S-1-5-32-545:(OI)(CI)(F)', '/q']);
    const store = join(parent, 'runs');
    await mkdir(store);
    await restrictToOwner(store, 0o700);

    let stop = false;
    const seen: string[] = [];
    const born = (async () => {
      // Left on disk rather than cleaned up as they go: `icacls` still holds a handle on the one
      // it has just read, and racing a `rm` against that is how this test failed under load
      // rather than how the code under test failed. The whole tree is a mkdtemp.
      for (let n = 0; !stop && n < 200; n++) {
        const child = join(store, `run_${n}`);
        await mkdir(child);
        seen.push(...trustees(await sddl(child)));
      }
    })();
    for (let i = 0; i < 5; i++) await restrictToOwner(store, 0o700);
    stop = true;
    await born;

    expect(seen.length, 'the probe never got to run').toBeGreaterThan(0);
    expect([...new Set(seen)].sort()).toEqual(ownerOnly);
  });

  it.runIf(onWindows)('replaces the DACL rather than adding to it', async () => {
    // `/inheritance:r` removes only inherited ACEs and `/grant:r` replaces explicit ones only for
    // the trustees it names, so an explicit grant to anybody else used to survive both. Not a
    // hypothetical shape: "Replace all child object permissions" converts inherited ACEs into
    // explicit ones, and so do `robocopy /SEC` and a tree carried between machines.
    const dir = join(await mkdtemp(join(tmpdir(), 'orca-perm-')), 'runs');
    await mkdir(dir);
    const USERS = 'S-1-5-32-545'; // BUILTIN\\Users — by SID, so no name has to resolve
    await run(system32('icacls.exe'), [dir, '/grant', `*${USERS}:(OI)(CI)(F)`, '/q']);
    expect(trustees(await sddl(dir)), 'precondition').toContain(USERS);

    await restrictToOwner(dir, 0o700);

    expect(trustees(await sddl(dir))).toEqual(ownerOnly);
    // And the inheritable half of it is gone, so nothing written afterwards picks it up either.
    const later = join(dir, 'events.jsonl');
    await writeFile(later, 'x');
    expect(trustees(await sddl(later))).toEqual(ownerOnly);
  });

  it.runIf(onWindows)('refuses rather than guessing where icacls lives', async () => {
    // `'C:\\Windows'` as a fallback is not one: `\\W` is not an escape, so the literal's value is
    // `C:Windows` — and a drive letter with no separator is drive-relative. CreateProcess resolves
    // it against the current directory on C:, which during a recording is the workspace being
    // recorded, and `Windows/System32/icacls.exe` is a storable git path. The guess hands the key
    // to exactly the reader this function exists to shut out.
    const file = join(await mkdtemp(join(tmpdir(), 'orca-perm-')), 'secret');
    await writeFile(file, 'sk-secret\n');
    const saved = process.env['SystemRoot'];
    delete process.env['SystemRoot'];
    try {
      await expect(restrictToOwner(file, 0o600)).rejects.toThrow(/SystemRoot is not set/);
    } finally {
      process.env['SystemRoot'] = saved;
    }
  });

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
