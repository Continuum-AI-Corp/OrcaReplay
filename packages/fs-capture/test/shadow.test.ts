import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FileChange } from '../src/index.js';
import { EMPTY_TREE, ShadowIndex, gitAvailable, runGit } from '../src/index.js';
import { cleanupTempDirs, listFilesRecursive, makeTempDir } from './helpers.js';

const hasGit = await gitAvailable();
const itGit = it.skipIf(!hasGit);

afterAll(cleanupTempDirs);

interface Fixture {
  root: string;
  workTree: string;
  gitDir: string;
  shadow: ShadowIndex;
}

async function fixture(): Promise<Fixture> {
  const root = await makeTempDir();
  const workTree = join(root, 'ws');
  const gitDir = join(root, 'run', 'fs');
  await mkdir(workTree, { recursive: true });
  const shadow = await ShadowIndex.create({ gitDir, workTree });
  return { root, workTree, gitDir, shadow };
}

async function write(dir: string, rel: string, content: string | Uint8Array): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

function byPath(changes: FileChange[], path: string): FileChange {
  const found = changes.find((change) => change.path === path);
  if (!found) throw new Error(`no change for ${path} in ${JSON.stringify(changes)}`);
  return found;
}

async function filesIn(shadow: ShadowIndex, tree: string): Promise<string[]> {
  const changes = await shadow.diff(EMPTY_TREE, tree);
  return changes.map((change) => change.path).sort();
}

describe('ShadowIndex.create', () => {
  itGit('initialises a shadow git dir without creating a .git in the workspace', async () => {
    const { workTree, gitDir } = await fixture();
    expect((await stat(join(gitDir, 'objects'))).isDirectory()).toBe(true);
    expect((await stat(join(gitDir, 'info', 'exclude'))).isFile()).toBe(true);
    expect(await listFilesRecursive(workTree)).toEqual([]);
  });

  itGit('is idempotent over an existing shadow dir', async () => {
    const { workTree, gitDir } = await fixture();
    await write(workTree, 'a.txt', 'one\n');
    const first = await (await ShadowIndex.create({ gitDir, workTree })).snapshot();
    const second = await (await ShadowIndex.create({ gitDir, workTree })).snapshot();
    expect(second).toBe(first);
  });

  itGit('throws an actionable error when git is missing', async () => {
    const root = await makeTempDir();
    const saved = process.env.PATH;
    process.env.PATH = join(root, 'empty');
    try {
      await expect(
        ShadowIndex.create({ gitDir: join(root, 'fs'), workTree: root }),
      ).rejects.toThrow(/git is required for filesystem capture.*--no-fs/s);
    } finally {
      process.env.PATH = saved;
    }
  });

  itGit('reports availability', async () => {
    expect(await ShadowIndex.isAvailable()).toBe(true);
  });
});

describe('snapshot', () => {
  itGit('snapshots an empty directory as the empty tree', async () => {
    const { shadow } = await fixture();
    expect(await shadow.snapshot()).toBe(EMPTY_TREE);
  });

  itGit('is content addressed: no changes yields the same tree sha', async () => {
    const { workTree, shadow } = await fixture();
    await write(workTree, 'a.txt', 'stable\n');
    await write(workTree, 'nested/b.txt', 'also stable\n');
    const first = await shadow.snapshot();
    const second = await shadow.snapshot();
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(second).toBe(first);
  });

  itGit('leaves the workspace and its real git repo untouched', async () => {
    const { workTree, shadow } = await fixture();
    await runGit(['init', '-q'], { cwd: workTree });
    await write(workTree, 'tracked.txt', 'hi\n');
    const before = await runGit(['status', '--porcelain'], { cwd: workTree });
    await shadow.snapshot();
    const after = await runGit(['status', '--porcelain'], { cwd: workTree });
    expect(after.stdout).toBe(before.stdout);
    // The shadow index must never become the real repo's index.
    const staged = await runGit(['diff', '--cached', '--name-only'], { cwd: workTree });
    expect(staged.stdout).toBe('');
  });
});

describe('diff', () => {
  itGit('reports an added file with its insertion count', async () => {
    const { workTree, shadow } = await fixture();
    const before = await shadow.snapshot();
    await write(workTree, 'added.txt', 'one\ntwo\nthree\n');
    const after = await shadow.snapshot();
    const changes = await shadow.diff(before, after);
    expect(changes).toHaveLength(1);
    expect(byPath(changes, 'added.txt')).toEqual({
      path: 'added.txt',
      status: 'added',
      insertions: 3,
      deletions: 0,
    });
  });

  itGit('reports a modified file with insertions and deletions', async () => {
    const { workTree, shadow } = await fixture();
    await write(workTree, 'keep.txt', 'l1\nl2\nl3\n');
    const before = await shadow.snapshot();
    await write(workTree, 'keep.txt', 'l1\nCHANGED\nl3\nl4\n');
    const after = await shadow.snapshot();
    const change = byPath(await shadow.diff(before, after), 'keep.txt');
    expect(change.status).toBe('modified');
    expect(change.insertions).toBe(2);
    expect(change.deletions).toBe(1);
  });

  itGit('reports a deleted file', async () => {
    const { workTree, shadow } = await fixture();
    await write(workTree, 'gone.txt', 'bye\n');
    const before = await shadow.snapshot();
    await rm(join(workTree, 'gone.txt'));
    const after = await shadow.snapshot();
    const change = byPath(await shadow.diff(before, after), 'gone.txt');
    expect(change.status).toBe('deleted');
    expect(change.deletions).toBe(1);
  });

  itGit('reports a rename with the old path', async () => {
    const { workTree, shadow } = await fixture();
    await write(workTree, 'old.txt', 'a\nb\nc\nd\ne\nf\ng\nh\n');
    const before = await shadow.snapshot();
    await rename(join(workTree, 'old.txt'), join(workTree, 'new.txt'));
    const after = await shadow.snapshot();
    const changes = await shadow.diff(before, after);
    expect(changes).toHaveLength(1);
    expect(byPath(changes, 'new.txt')).toEqual({
      path: 'new.txt',
      status: 'renamed',
      oldPath: 'old.txt',
      insertions: 0,
      deletions: 0,
    });
  });

  itGit('reports several changes at once and counts binary files as zero lines', async () => {
    const { workTree, shadow } = await fixture();
    await write(workTree, 'bin.dat', new Uint8Array([0, 1, 2, 3]));
    await write(workTree, 'text.txt', 'one\n');
    const before = await shadow.snapshot();
    await write(workTree, 'bin.dat', new Uint8Array([9, 9, 9, 9, 9]));
    await write(workTree, 'text.txt', 'one\ntwo\n');
    await write(workTree, 'deep/nested/new.txt', 'x\n');
    const changes = await shadow.diff(before, await shadow.snapshot());
    expect(changes.map((change) => change.path).sort()).toEqual([
      'bin.dat',
      'deep/nested/new.txt',
      'text.txt',
    ]);
    expect(byPath(changes, 'bin.dat')).toMatchObject({ insertions: 0, deletions: 0 });
    expect(byPath(changes, 'deep/nested/new.txt').status).toBe('added');
  });

  itGit('returns an empty list for identical trees', async () => {
    const { workTree, shadow } = await fixture();
    await write(workTree, 'a.txt', 'same\n');
    const tree = await shadow.snapshot();
    expect(await shadow.diff(tree, tree)).toEqual([]);
  });

  itGit('handles paths with spaces and unicode', async () => {
    const { workTree, shadow } = await fixture();
    const before = await shadow.snapshot();
    await write(workTree, 'a dir/héllo wörld ✓.txt', 'unicode\n');
    const changes = await shadow.diff(before, await shadow.snapshot());
    expect(changes.map((change) => change.path)).toEqual(['a dir/héllo wörld ✓.txt']);
  });
});

describe('exclusions', () => {
  itGit("honours the workspace's own .gitignore", async () => {
    const { workTree, shadow } = await fixture();
    await write(workTree, '.gitignore', 'ignored.log\nbuild/\n');
    await write(workTree, 'ignored.log', 'noise\n');
    await write(workTree, 'build/out.js', 'noise\n');
    await write(workTree, 'kept.txt', 'signal\n');
    expect(await filesIn(shadow, await shadow.snapshot())).toEqual(['.gitignore', 'kept.txt']);
  });

  itGit('never captures secrets, with no .gitignore present', async () => {
    const { workTree, shadow } = await fixture();
    await write(workTree, '.env', 'API_KEY=sk-live-secret\n');
    await write(workTree, '.env.local', 'API_KEY=sk-live-secret\n');
    await write(workTree, 'id_rsa', 'PRIVATE KEY\n');
    await write(workTree, 'id_ed25519', 'PRIVATE KEY\n');
    await write(workTree, '.netrc', 'machine example.com password hunter2\n');
    await write(workTree, 'certs/server.pem', 'CERT\n');
    await write(workTree, 'certs/server.key', 'KEY\n');
    await write(workTree, '.ssh/known_hosts', 'host\n');
    await write(workTree, 'home/.aws/credentials', 'aws_secret_access_key=x\n');
    await write(workTree, 'node_modules/pkg/index.js', 'noise\n');
    await write(workTree, '.orca/runs/run_a/events.jsonl', '{}\n');
    await write(workTree, 'src/app.ts', 'export const ok = 1;\n');
    expect(await filesIn(shadow, await shadow.snapshot())).toEqual(['src/app.ts']);
  });

  // Security property: gitignore negation outranks $GIT_DIR/info/exclude, so the exclusions must
  // not rest on info/exclude alone.
  itGit('never captures secrets even when .gitignore tries to un-ignore them', async () => {
    const { workTree, shadow } = await fixture();
    await write(workTree, '.gitignore', '!.env\n!id_rsa\n!.ssh/\n!*.key\n!.orca/\n');
    await write(workTree, '.env', 'API_KEY=sk-live-secret\n');
    await write(workTree, 'id_rsa', 'PRIVATE KEY\n');
    await write(workTree, '.ssh/id_ed25519', 'PRIVATE KEY\n');
    await write(workTree, 'deep/nested/secret.key', 'KEY\n');
    await write(workTree, '.orca/runs/run_a/events.jsonl', '{}\n');
    await write(workTree, 'ok.txt', 'fine\n');
    expect(await filesIn(shadow, await shadow.snapshot())).toEqual(['.gitignore', 'ok.txt']);
  });
});

describe('readFileAt', () => {
  itGit('returns the exact bytes stored in a tree', async () => {
    const { workTree, shadow } = await fixture();
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x0a, 0x7f]);
    await write(workTree, 'nested/bin.dat', bytes);
    await write(workTree, 'nested/u.txt', 'héllo ünicode ✓\n漢字\n');
    const tree = await shadow.snapshot();
    expect(await shadow.readFileAt(tree, 'nested/bin.dat')).toEqual(bytes);
    expect(Buffer.from(await shadow.readFileAt(tree, 'nested/u.txt')).toString('utf8')).toBe(
      'héllo ünicode ✓\n漢字\n',
    );
  });

  itGit('throws for a path that is not in the tree', async () => {
    const { workTree, shadow } = await fixture();
    await write(workTree, 'a.txt', 'x\n');
    const tree = await shadow.snapshot();
    await expect(shadow.readFileAt(tree, 'missing.txt')).rejects.toThrow(/missing\.txt/);
  });
});

describe('patch', () => {
  itGit('produces a unified diff for the whole tree', async () => {
    const { workTree, shadow } = await fixture();
    await write(workTree, 'a.txt', 'l1\nl2\n');
    const before = await shadow.snapshot();
    await write(workTree, 'a.txt', 'l1\nl2\nl3\n');
    await write(workTree, 'b.txt', 'new\n');
    const patch = await shadow.patch(before, await shadow.snapshot());
    expect(patch).toContain('diff --git a/a.txt b/a.txt');
    expect(patch).toContain('+l3');
    expect(patch).toContain('b.txt');
  });

  itGit('narrows to a single path when asked', async () => {
    const { workTree, shadow } = await fixture();
    await write(workTree, 'a.txt', 'l1\n');
    await write(workTree, 'b.txt', 'l1\n');
    const before = await shadow.snapshot();
    await write(workTree, 'a.txt', 'l1\nl2\n');
    await write(workTree, 'b.txt', 'l1\nl2\n');
    const patch = await shadow.patch(before, await shadow.snapshot(), 'a.txt');
    expect(patch).toContain('a.txt');
    expect(patch).not.toContain('b.txt');
  });
});

describe('materialize', () => {
  itGit('round-trips a nested tree byte for byte', async () => {
    const { root, workTree, shadow } = await fixture();
    const unicode = 'héllo ünicode ✓\n漢字とカナ\nlast line without newline';
    const binary = new Uint8Array([0, 1, 2, 253, 254, 255, 10, 13]);
    await write(workTree, 'top.txt', 'top\n');
    await write(workTree, 'nested/deep/u.txt', unicode);
    await write(workTree, 'nested/deep/deeper/bin.dat', binary);
    await write(workTree, 'nested/crlf.txt', 'a\r\nb\r\n');
    await write(workTree, 'run.sh', '#!/bin/sh\necho hi\n');
    await chmod(join(workTree, 'run.sh'), 0o755);
    const tree = await shadow.snapshot();

    const dest = join(root, 'materialized');
    await shadow.materialize(tree, dest);

    expect(await listFilesRecursive(dest)).toEqual(await listFilesRecursive(workTree));
    for (const rel of await listFilesRecursive(workTree)) {
      const original = await readFile(join(workTree, rel));
      const restored = await readFile(join(dest, rel));
      expect(restored.equals(original), `bytes differ for ${rel}`).toBe(true);
    }
    expect((await stat(join(dest, 'run.sh'))).mode & 0o111).toBeGreaterThan(0);
  });

  itGit('creates the destination directory if it does not exist', async () => {
    const { root, workTree, shadow } = await fixture();
    await write(workTree, 'a.txt', 'x\n');
    const dest = join(root, 'does', 'not', 'exist');
    await shadow.materialize(await shadow.snapshot(), dest);
    expect(await readFile(join(dest, 'a.txt'), 'utf8')).toBe('x\n');
  });

  itGit('materializes the empty tree as an empty directory', async () => {
    const { root, shadow } = await fixture();
    const dest = join(root, 'empty-dest');
    await shadow.materialize(await shadow.snapshot(), dest);
    expect(await listFilesRecursive(dest)).toEqual([]);
  });

  // git add stores a nested repository as a gitlink whose contents live nowhere in the shadow
  // store, so checkout-index would silently produce an empty directory. Fork replay must not
  // debug a workspace that quietly lost a subtree.
  itGit('refuses to materialize a tree containing an embedded git repository', async () => {
    const { root, workTree, shadow } = await fixture();
    await write(workTree, 'a.txt', 'x\n');
    const inner = join(workTree, 'vendor', 'inner');
    await mkdir(inner, { recursive: true });
    await runGit(['init', '-q'], { cwd: inner });
    await write(inner, 'f.txt', 'inner\n');
    await runGit(['add', '-A'], { cwd: inner });
    await runGit(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'x'], {
      cwd: inner,
    });
    const tree = await shadow.snapshot();
    const dest = join(root, 'dest');
    await expect(shadow.materialize(tree, dest)).rejects.toThrow(/embedded git repositor/i);
    await expect(shadow.materialize(tree, dest, { allowIncomplete: true })).resolves.toBeUndefined();
    expect(await readFile(join(dest, 'a.txt'), 'utf8')).toBe('x\n');
  });
});
