import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitAvailable, runGit, runGitRaw } from '../src/index.js';
import { cleanupTempDirs, makeTempDir } from './helpers.js';

const hasGit = await gitAvailable();
const itGit = it.skipIf(!hasGit);

afterAll(cleanupTempDirs);

describe('runGit', () => {
  itGit('returns stdout and a zero code for a successful command', async () => {
    const res = await runGit(['--version']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^git version /);
    expect(res.stderr).toBe('');
  });

  itGit('returns a non-zero code instead of throwing', async () => {
    const res = await runGit(['cat-file', '-p', 'deadbeef'], { cwd: await makeTempDir() });
    expect(res.code).not.toBe(0);
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  itGit('runs in the requested cwd', async () => {
    const dir = await makeTempDir();
    await runGit(['init', '-q'], { cwd: dir });
    const res = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('true');
  });

  itGit('feeds stdin when input is given', async () => {
    const dir = await makeTempDir();
    await runGit(['init', '-q'], { cwd: dir });
    const res = await runGit(['hash-object', '-w', '--stdin'], { cwd: dir, input: 'hello\n' });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  itGit('honours gitDir, workTree and indexFile', async () => {
    const root = await makeTempDir();
    const gitDir = join(root, 'shadow');
    const workTree = join(root, 'ws');
    await runGit(['init', '--bare', '-q', gitDir]);
    await runGit(['init', '-q', workTree]);
    await writeFile(join(workTree, 'a.txt'), 'x\n');
    const add = await runGit(['add', '-A'], {
      gitDir,
      workTree,
      cwd: workTree,
      indexFile: join(gitDir, 'index'),
    });
    expect(add.code).toBe(0);
    const tree = await runGit(['write-tree'], {
      gitDir,
      workTree,
      cwd: workTree,
      indexFile: join(gitDir, 'index'),
    });
    expect(tree.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  // A hook or a parent git process exports GIT_DIR; inheriting it would silently retarget every
  // command at the wrong repository.
  itGit('does not inherit GIT_DIR or GIT_INDEX_FILE from the ambient environment', async () => {
    const dir = await makeTempDir();
    await runGit(['init', '-q'], { cwd: dir });
    const saved = { d: process.env.GIT_DIR, i: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = join(dir, 'nope-does-not-exist');
    process.env.GIT_INDEX_FILE = join(dir, 'nope.index');
    try {
      const res = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
      expect(res.code).toBe(0);
      expect(res.stdout.trim()).toBe('true');
    } finally {
      if (saved.d === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.d;
      if (saved.i === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved.i;
    }
  });

  it.each(['--upload-pack=/bin/sh', '--receive-pack=touch pwned', '--upload-pack'])(
    'refuses the argument-injection vector %s',
    async (arg) => {
      await expect(runGit(['ls-remote', arg, '.'])).rejects.toThrow(/refus|unsafe|reject/i);
    },
  );

  itGit('returns raw bytes from runGitRaw', async () => {
    const dir = await makeTempDir();
    await runGit(['init', '-q'], { cwd: dir });
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x0a]);
    await writeFile(join(dir, 'bin'), bytes);
    const hashed = await runGit(['hash-object', '-w', 'bin'], { cwd: dir });
    const raw = await runGitRaw(['cat-file', 'blob', hashed.stdout.trim()], { cwd: dir });
    expect(raw.code).toBe(0);
    expect(new Uint8Array(raw.stdout)).toEqual(bytes);
  });
});

describe('gitAvailable', () => {
  itGit('reports true when git is on PATH', async () => {
    expect(await gitAvailable()).toBe(true);
  });

  itGit('reports false when git is not on PATH', async () => {
    const saved = process.env.PATH;
    process.env.PATH = join(await makeTempDir(), 'empty');
    try {
      expect(await gitAvailable()).toBe(false);
    } finally {
      process.env.PATH = saved;
    }
  });
});
