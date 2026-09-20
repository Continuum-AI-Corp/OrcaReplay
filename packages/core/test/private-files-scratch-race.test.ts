import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const attack = vi.hoisted(() => ({ enabled: false, path: '', displaced: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (attack.enabled && String(args[0]).endsWith('in-use')) {
        attack.enabled = false;
        attack.path = dirname(String(args[0]));
        attack.displaced = `${attack.path}.displaced`;
        await fs.rename(attack.path, attack.displaced);
        await fs.mkdir(attack.path);
        // Same valid DACL, different directory: the ACL read-back cannot detect this swap.
        const run = promisify(execFile);
        const sys = join(process.env['SystemRoot']!, 'System32');
        const { stdout } = await run(join(sys, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
        const sid = /S-1-[\d-]+/.exec(stdout)![0];
        await run(join(sys, 'icacls.exe'), [
          attack.path,
          '/inheritance:r',
          '/grant:r',
          `*${sid}:(OI)(CI)(F)`,
          '*S-1-5-18:(OI)(CI)(F)',
          '*S-1-5-32-544:(OI)(CI)(F)',
          '/q',
        ]);
        await fs.writeFile(join(attack.path, 'keep'), 'replacement data');
      }
      return fs.writeFile(...args);
    },
  };
});

const { restrictToOwner } = await import('../src/private-files.js');

describe.runIf(process.platform === 'win32')('ACL scratch replacement', () => {
  let root: string;
  afterEach(async () => {
    attack.enabled = false;
    for (const path of [root, attack.path, attack.displaced]) {
      // Each is an exact directory created by this test; no untrusted recursive traversal.
      if (path) await rm(path, { recursive: true, force: true });
    }
  });

  it('rechecks identity after the sentinel write before trusting any saved descriptor', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-scratch-race-'));
    const file = join(root, 'secret');
    await writeFile(file, 'original contents');
    attack.enabled = true;
    await expect(restrictToOwner(file, 0o600)).rejects.toThrow(/was replaced/);
    expect(await readFile(file, 'utf8')).toBe('original contents');
    expect(await readFile(join(attack.path, 'keep'), 'utf8')).toBe('replacement data');
  });
});
