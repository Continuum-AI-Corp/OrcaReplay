import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureRunsDir,
  listRuns,
  orcaDir,
  resolveRunSelector,
  runDirFor,
  runsDir,
} from '../src/paths.js';
import { TraceWriter } from '../src/writer.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'orca-paths-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function seedRun(runId: string, createdAt?: string): Promise<string> {
  const dir = runDirFor(cwd, runId);
  await mkdir(dir, { recursive: true });
  if (createdAt !== undefined) {
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ run_id: runId, created_at: createdAt }),
    );
  }
  return dir;
}

describe('"last" after a replay', () => {
  /**
   * Since exact replay writes its own run, the newest run in a directory is usually a replay
   * trace — which holds divergences and nothing else: no exchanges, no blobs, no filesystem store.
   * Every command defaults to `last`, so that quietly redirected all of them.
   *
   * The sharpest case is `orca scrub last --match my-hostname`, which is the line in the README:
   * it scrubbed the empty trace, found nothing, and printed "nothing matched — the trace is
   * unchanged". A security tool telling you a trace is clean while the secret sits in the
   * recording next to it.
   *
   * A fork stays eligible — it has exchanges and a worktree and is a thing you act on. A replay
   * trace is a report about another run, so `last` skips it.
   */
  async function writeRun(dir: string, opts: { parentRun?: string; forkPoint?: number } = {}) {
    const writer = await TraceWriter.create(join(dir, '.orca', 'runs'), {
      adapter: { id: 'claude-code', version: '0.0.0' },
      argv: ['claude-code'],
      cwd: dir,
      orcaVersion: '0.0.0',
      ...(opts.parentRun === undefined ? {} : { parentRun: opts.parentRun }),
      ...(opts.forkPoint === undefined ? {} : { forkPoint: opts.forkPoint }),
    });
    await writer.close(0);
    // `created_at` has second-ish resolution in the sort; make the order unambiguous.
    await new Promise((r) => setTimeout(r, 5));
    return writer.runId;
  }

  it('skips a replay trace and resolves the recording it describes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-last-'));
    try {
      const recording = await writeRun(dir);
      const replay = await writeRun(dir, { parentRun: recording });
      expect((await listRuns(dir))[0]!.runId, 'the replay is newest').toBe(replay);

      expect((await resolveRunSelector(dir, 'last')).runId).toBe(recording);
      // Naming it explicitly still works — it is a real run, just not the default one.
      expect((await resolveRunSelector(dir, replay)).runId).toBe(replay);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still resolves a fork, which is a run you act on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-last-'));
    try {
      const recording = await writeRun(dir);
      const fork = await writeRun(dir, { parentRun: recording, forkPoint: 4 });
      expect((await resolveRunSelector(dir, 'last')).runId).toBe(fork);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to a replay trace rather than failing when it is all there is', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-last-'));
    try {
      const only = await writeRun(dir, { parentRun: 'run_000000000000' });
      expect((await resolveRunSelector(dir, 'last')).runId).toBe(only);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('path helpers', () => {
  it('puts everything under .orca', () => {
    expect(orcaDir('/w')).toBe(join('/w', '.orca'));
    expect(runsDir('/w')).toBe(join('/w', '.orca', 'runs'));
    expect(runDirFor('/w', 'run_9f2c14')).toBe(join('/w', '.orca', 'runs', 'run_9f2c14'));
  });

  it('refuses a run id that does not match the spec pattern', () => {
    expect(() => runDirFor('/w', '../../etc')).toThrow(/run id/i);
    expect(() => runDirFor('/w', 'RUN_9F2C14')).toThrow(/run id/i);
  });
});

describe('listRuns', () => {
  it('returns nothing for a workspace that has never recorded', async () => {
    expect(await listRuns(cwd)).toEqual([]);
  });

  it('lists runs newest first', async () => {
    await seedRun('run_aaaaaa', '2026-08-01T00:00:00.000Z');
    await seedRun('run_cccccc', '2026-08-29T00:00:00.000Z');
    await seedRun('run_bbbbbb', '2026-08-15T00:00:00.000Z');
    expect((await listRuns(cwd)).map((r) => r.runId)).toEqual([
      'run_cccccc',
      'run_bbbbbb',
      'run_aaaaaa',
    ]);
  });

  it('reports the directory alongside the id', async () => {
    const dir = await seedRun('run_abc123', '2026-08-01T00:00:00.000Z');
    const [run] = await listRuns(cwd);
    expect(run?.dir).toBe(dir);
    expect(run?.createdAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('ignores strays that are not runs', async () => {
    await seedRun('run_abc123', '2026-08-01T00:00:00.000Z');
    await mkdir(join(runsDir(cwd), 'not-a-run'), { recursive: true });
    await writeFile(join(runsDir(cwd), 'README'), 'hi');
    expect((await listRuns(cwd)).map((r) => r.runId)).toEqual(['run_abc123']);
  });

  it('falls back to the directory time when the manifest is missing or unreadable', async () => {
    const dir = await seedRun('run_abc123');
    await utimes(dir, new Date('2026-07-04T00:00:00.000Z'), new Date('2026-07-04T00:00:00.000Z'));
    await seedRun('run_def456', 'not-a-date-at-all');
    const runs = await listRuns(cwd);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.runId === 'run_abc123')?.createdAt).toBe('2026-07-04T00:00:00.000Z');
  });
});

describe('resolveRunSelector', () => {
  it('resolves "last" to the newest run', async () => {
    await seedRun('run_aaaaaa', '2026-08-01T00:00:00.000Z');
    const newest = await seedRun('run_bbbbbb', '2026-08-29T00:00:00.000Z');
    const run = await resolveRunSelector(cwd, 'last');
    expect(run.runId).toBe('run_bbbbbb');
    expect(run.dir).toBe(newest);
  });

  it('resolves anything else as a run id', async () => {
    const dir = await seedRun('run_aaaaaa', '2026-08-01T00:00:00.000Z');
    await seedRun('run_bbbbbb', '2026-08-29T00:00:00.000Z');
    const run = await resolveRunSelector(cwd, 'run_aaaaaa');
    expect(run.runId).toBe('run_aaaaaa');
    expect(run.dir).toBe(dir);
    expect(run.createdAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('names the command to run when the workspace has no runs', async () => {
    await expect(resolveRunSelector(cwd, 'last')).rejects.toThrow(/orca record/);
  });

  it('names the missing run and how to list runs', async () => {
    await seedRun('run_aaaaaa', '2026-08-01T00:00:00.000Z');
    await expect(resolveRunSelector(cwd, 'run_beef99')).rejects.toThrow(/run_beef99/);
    await expect(resolveRunSelector(cwd, 'run_beef99')).rejects.toThrow(/orca list/);
  });

  it('rejects a selector that is not a run id at all', async () => {
    await seedRun('run_aaaaaa', '2026-08-01T00:00:00.000Z');
    await expect(resolveRunSelector(cwd, '../../etc/passwd')).rejects.toThrow(/run id/i);
  });
});

describe('ensureRunsDir', () => {
  it('makes the trace store ignore itself, so a recording cannot be committed by accident', async () => {
    // A trace is the conversation the model saw — your source — plus shell output, a snapshot of
    // the whole workspace and an environment allowlist. It was landing in `git status` as an
    // untracked directory, one `git add -A` away from being pushed, in the repo it just recorded.
    const cwd = await mkdtemp(join(tmpdir(), 'orca-ignore-'));
    try {
      const dir = await ensureRunsDir(cwd);
      expect(dir).toBe(join(cwd, '.orca', 'runs'));
      const ignore = await readFile(join(cwd, '.orca', '.gitignore'), 'utf8');
      // `*` is git's own idiom for a directory that excludes itself: no edit to the user's
      // .gitignore, and it works in a repo orca has never seen before.
      expect(ignore.split('\n')).toContain('*');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('never rewrites one the user changed, so opting back in sticks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-ignore-'));
    try {
      await ensureRunsDir(cwd);
      // Someone who deliberately wants their traces tracked empties this. Orca must not undo that
      // on the next recording.
      await writeFile(join(cwd, '.orca', '.gitignore'), '', { mode: 0o600 });
      await ensureRunsDir(cwd);
      expect(await readFile(join(cwd, '.orca', '.gitignore'), 'utf8')).toBe('');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('is safe to call repeatedly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-ignore-'));
    try {
      await expect(ensureRunsDir(cwd)).resolves.toBeDefined();
      await expect(ensureRunsDir(cwd)).resolves.toBeDefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
