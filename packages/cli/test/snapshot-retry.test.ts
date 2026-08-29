import { describe, expect, it } from 'vitest';
import { snapshotWithRetry, type SnapshotSource } from '../src/snapshot.js';

function source(results: Array<Error | { tree: string; changes: unknown[] }>): SnapshotSource {
  let i = 0;
  return {
    async snapshotTurn() {
      const next = results[Math.min(i, results.length - 1)]!;
      i += 1;
      if (next instanceof Error) throw next;
      return next as never;
    },
  };
}

describe('snapshotWithRetry', () => {
  it('returns the snapshot when it works first time', async () => {
    const r = await snapshotWithRetry(source([{ tree: 'abc', changes: [] }]), 1, { delayMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.snapshot?.tree).toBe('abc');
    expect(r.attempts).toBe(1);
  });

  it('retries a transient git race and succeeds', async () => {
    // These are the two real ones: the agent writing a file while git indexes it, and two
    // snapshots overlapping on the index lock.
    const src = source([
      new Error('git add failed (128): error: short read while indexing auth.ts'),
      { tree: 'def', changes: [] },
    ]);
    const r = await snapshotWithRetry(src, 1, { delayMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.snapshot?.tree).toBe('def');
    expect(r.attempts).toBe(2);
  });

  it('gives up after the retry budget and reports why, without throwing', async () => {
    const err = new Error("git add failed (128): Unable to create 'index.lock': File exists.");
    const r = await snapshotWithRetry(source([err]), 1, { delayMs: 0, attempts: 3 });
    // Losing a snapshot degrades the trace. Aborting loses the run the user actually wanted.
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.error).toContain('index.lock');
  });

  it('does not retry an error that is not a transient race', async () => {
    const r = await snapshotWithRetry(source([new Error('fatal: not a git repository')]), 1, {
      delayMs: 0,
      attempts: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.attempts, 'retrying a permanent failure just delays the run').toBe(1);
  });
});
