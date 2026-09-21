import { describe, expect, it } from 'vitest';
import { resetRoots } from '../src/commands/replay.js';

/**
 * What `orca replay` is about to `rm -rf` before it restores the recording's initial tree.
 *
 * This is the most destructive thing orca does to a directory it did not create, so what it
 * resolves to matters more than most path handling in the codebase: the rule it operates under is
 * that orca deletes only what it took a copy of first, and the copy is taken from the adapter's
 * declared paths. A deletion wider than the declaration is a deletion wider than the copy.
 */
const dir = process.cwd();
const artifacts = (resetBeforeReplay: string[]) => ({ resetBeforeReplay });

describe('resetRoots', () => {
  it('takes the declared path itself, not its first segment', () => {
    // The regression: `'data/cache'.split(/[\\/]/)[0]` is `'data'`, so a replay ran
    // `rm -rf <cwd>/data` — taking `data/raw-inputs/` with it, which nothing had a copy of,
    // while reporting that the files come back when the replay ends.
    expect(resetRoots(dir, artifacts(['data/cache']))).toEqual(['data/cache']);
    expect(resetRoots(dir, artifacts(['a/b/c']))).toEqual(['a/b/c']);
  });

  it('strips a trailing glob, which is the only part of a pattern it can act on', () => {
    expect(resetRoots(dir, artifacts(['cache/**']))).toEqual(['cache']);
    expect(resetRoots(dir, artifacts(['data/cache/*']))).toEqual(['data/cache']);
    expect(resetRoots(dir, artifacts(['cache/']))).toEqual(['cache']);
  });

  it('keeps the ordinary declaration ordinary', () => {
    expect(resetRoots(dir, artifacts(['cache', 'vector_store']))).toEqual([
      'cache',
      'vector_store',
    ]);
    expect(resetRoots(dir, undefined)).toEqual([]);
    expect(resetRoots(dir, artifacts([]))).toEqual([]);
  });

  it('refuses a declaration that names no path, or a glob it cannot resolve to one', () => {
    expect(resetRoots(dir, artifacts(['', '.', '..', '*', 'test_results_*.json']))).toEqual([]);
  });

  it('refuses to leave the workspace, whatever an adapter declares', () => {
    expect(resetRoots(dir, artifacts(['../elsewhere', '../../etc', 'ok/../../out']))).toEqual([]);
  });

  it('reports each path once, however many patterns name it', () => {
    expect(resetRoots(dir, artifacts(['cache', 'cache/**', 'cache/']))).toEqual(['cache']);
  });

  it('answers with the path the deletion acts on, not the spelling it was declared in', () => {
    // `resetArtifacts` removes `resolve(dir, root)` and the guard before it compares these
    // strings, so a declaration that resolves to `cache` has to leave here as `cache`. It did
    // not: `./cache` and `data//cache` came back unchanged, the guard's prefix test then missed
    // a nested repository under them, and the `rm` took it anyway.
    expect(resetRoots(dir, artifacts(['./cache']))).toEqual(['cache']);
    expect(resetRoots(dir, artifacts(['data//cache']))).toEqual(['data/cache']);
    expect(resetRoots(dir, artifacts(['data/./cache']))).toEqual(['data/cache']);
    expect(resetRoots(dir, artifacts(['tools/../cache']))).toEqual(['cache']);
    // And one that resolves to the workspace itself names no path to delete.
    expect(resetRoots(dir, artifacts(['cache/..']))).toEqual([]);
  });

  it('answers in the spelling both `resolve` and a git pathspec accept', () => {
    expect(resetRoots(dir, artifacts(['data\\cache']))).toEqual(['data/cache']);
  });
});
