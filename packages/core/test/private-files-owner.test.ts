import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ owner: '', writes: 0, sid: '' }));
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = (...args: Parameters<typeof real.execFile>) => real.execFile(...args);
  Object.defineProperty(execFile, promisify.custom, {
    value: async (exe: string, argv: string[], options: object = {}) => {
      if (exe.endsWith('powershell.exe')) return { stdout: probe.owner, stderr: '' };
      if (argv.includes('/grant:r')) probe.writes++;
      const result = await promisify(real.execFile)(exe, argv, options);
      if (probe.sid && argv.includes('/save')) {
        const { readFile, writeFile } = await import('node:fs/promises');
        const saved = argv[argv.indexOf('/save') + 1]!;
        await writeFile(
          saved,
          (await readFile(saved, 'utf16le')).replaceAll(probe.sid, 'LA'),
          'utf16le',
        );
      }
      return result;
    },
  });
  return {
    ...real,
    execFile,
  };
});

const { restrictToOwner } = await import('../src/private-files.js');

describe.runIf(process.platform === 'win32')('private file ownership', () => {
  let dir: string;
  afterEach(async () => {
    probe.sid = '';
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // A foreign owner can retain WRITE_DAC even when it has no ACE. Inject only the OS owner
  // response: the real filesystem, SID lookup and icacls calls remain in use, with no account
  // creation or privileged ownership changes needed on the developer's machine.
  it.each(['S-1-5-21-111-222-333-444', '', 'not a SID'])(
    'refuses owner %j before changing permissions',
    async (owner) => {
      dir = await mkdtemp(join(tmpdir(), 'orca-owner-test-'));
      const file = join(dir, 'secret');
      await writeFile(file, 'previous contents');
      probe.owner = owner;
      probe.writes = 0;
      await expect(restrictToOwner(file, 0o600)).rejects.toThrow(/untrusted owner/);
      expect(probe.writes).toBe(0);
      expect(await readFile(file, 'utf8')).toBe('previous contents');
    },
  );

  it('accepts the current account spelling supplied by Windows instead of guessing aliases', async () => {
    const { execFile } =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)(
      join(process.env['SystemRoot']!, 'System32', 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
    );
    probe.sid = /S-1-[\d-]+/.exec(stdout)![0];
    probe.owner = `${probe.sid}\nD:(A;;FA;;;LA)`;
    dir = await mkdtemp(join(tmpdir(), 'orca-owner-alias-'));
    const file = join(dir, 'secret');
    await writeFile(file, 'previous contents');
    await expect(restrictToOwner(file, 0o600)).resolves.toBeUndefined();
    await expect(restrictToOwner(file, 0o600)).resolves.toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('previous contents');
  });
});
