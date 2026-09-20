import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@orcareplay/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@orcareplay/core')>();
  return {
    ...real,
    restrictToOwner: async (path: string, mode: 0o600 | 0o700) => {
      if (mode === 0o700) throw new Error('untrusted config directory owner');
      await real.restrictToOwner(path, mode);
    },
  };
});

const { writeConfig } = await import('../src/config.js');

describe.runIf(process.platform === 'win32')('config directory refusal', () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('keeps the old config and writes no credential when its parent cannot be secured', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-config-refusal-'));
    const dir = join(root, 'orca');
    await mkdir(dir);
    await writeFile(join(dir, 'config.json'), 'previous config');
    await expect(
      writeConfig(
        { gateway: { url: 'https://example.test', api_key: 'new-secret' } },
        {
          XDG_CONFIG_HOME: root,
        },
      ),
    ).rejects.toThrow(/untrusted config directory owner/);
    expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe('previous config');
    expect(await readdir(dir)).toEqual(['config.json']);
  });
});
