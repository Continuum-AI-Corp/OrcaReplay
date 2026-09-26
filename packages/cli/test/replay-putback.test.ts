import { execFile } from 'node:child_process';
import { existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Output } from '../src/out.js';
import { FsCapture } from '@orcareplay/fs-capture';
import { assertOverwritable, removeIntroduced } from '../src/commands/replay.js';

const run = promisify(execFile);

/** The id git gives these bytes — asked of git, so the test does not share the code's arithmetic. */
async function gitBlobId(dir: string, content: string): Promise<string> {
  const probe = join(dir, '.probe');
  await writeFile(probe, content);
  const { stdout } = await run('git', ['hash-object', '--no-filters', probe]);
  await rm(probe);
  return stdout.trim();
}

/**
 * What a default replay takes away after putting the operator's tree back: files the recording
 * wrote where the operator had none. The list is made before the replayed agent runs and acted on
 * after it — minutes later, with a real harness, in a tree nothing else was told to keep out of —
 * and it names exactly the paths no copy holds. Taking whatever stood there then deleted the
 * operator's own new file, or a watcher's output, with nothing anywhere to bring it back.
 */
describe('taking away what a replay introduced', () => {
  let dir: string;
  let lines: string[];
  let out: Output;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-putback-'));
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('takes a file only while it still holds a version the recording wrote', async () => {
    const recorded = await gitBlobId(dir, 'RECORDED\n');
    await mkdir(join(dir, 'made'));
    await writeFile(join(dir, 'made', 'ours.txt'), 'RECORDED\n');
    await writeFile(join(dir, 'theirs.txt'), 'WRITTEN BY SOMEONE ELSE DURING THE REPLAY\n');
    await mkdir(join(dir, 'busy'));
    await writeFile(join(dir, 'busy', 'unlisted.txt'), 'not in the recording\n');

    await removeIntroduced(
      dir,
      {
        files: [
          { path: 'made/ours.txt', oids: new Set([recorded]) },
          { path: 'theirs.txt', oids: new Set([recorded]) },
          { path: 'never-written.txt', oids: new Set([recorded]) },
        ],
        dirs: ['made', 'busy'],
        walked: new Set(),
      },
      out,
    );

    expect(existsSync(join(dir, 'made')), 'its own file, and the directory made for it').toBe(
      false,
    );
    expect(
      await readFile(join(dir, 'theirs.txt'), 'utf8'),
      'a file the recording did not write, at a path it did',
    ).toBe('WRITTEN BY SOMEONE ELSE DURING THE REPLAY\n');
    expect(await readdir(join(dir, 'busy'))).toEqual(['unlisted.txt']);

    const warned = lines.find((l) => l.includes('replay.left_in_place')) ?? '';
    expect(warned, `nothing said what was left in:\n${lines.join('')}`).toContain('theirs.txt');
    expect(warned).not.toContain('ours.txt');
    expect((await readdir(dir)).filter((name) => name.includes('.orca-'))).toEqual([]);
  });

  /**
   * Hashing a path and then removing the path looks it up twice. A writer that replaced the file in
   * between had its bytes removed unjudged — the check passed on the old file, and `rm` took the new
   * one. The file is now set aside before it is judged, so what is judged is what goes.
   */
  it('judges the very file it removes, not whatever stands at the path by then', async () => {
    const recorded = await gitBlobId(dir, 'RECORDED\n');
    await writeFile(join(dir, 'raced.txt'), 'RECORDED\n');

    await removeIntroduced(
      dir,
      { files: [{ path: 'raced.txt', oids: new Set([recorded]) }], dirs: [], walked: new Set() },
      out,
      async (path) => {
        await writeFile(path, 'WRITTEN WHILE ORCA WAS LOOKING\n');
      },
    );

    expect(await readFile(join(dir, 'raced.txt'), 'utf8')).toBe('WRITTEN WHILE ORCA WAS LOOKING\n');
    expect((await readdir(dir)).filter((name) => name.includes('.orca-'))).toEqual([]);
  });

  /**
   * The removal may pass through real directories, and through links git walked into when it took
   * the copy. It had been handed every directory git walked into instead — so a real directory
   * swapped for a link after the copy was taken still counted, and the removal followed the link
   * out of the workspace to a file whose bytes happened to be the recording's.
   */
  it('does not follow a link that was a real directory when the copy was taken', async () => {
    const ws = join(dir, 'ws');
    const outside = join(dir, 'outside');
    await mkdir(join(ws, 'data'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(ws, 'data', 'a.csv'), 'A\n');

    // The recording had data/x.csv; the operator's tree does not.
    await writeFile(join(ws, 'data', 'x.csv'), 'RECORDED\n');
    const recording = await FsCapture.start({ runDir: join(dir, 'recording'), cwd: ws });
    const recordedTree = (await recording.snapshotTurn(0)).tree;
    await rm(join(ws, 'data', 'x.csv'));
    const copy = await FsCapture.start({ runDir: join(dir, 'copy'), cwd: ws });
    const held = (await copy.snapshotTurn(0)).tree;

    const introduced = await assertOverwritable(recording, [recordedTree], copy, held, ws);
    expect(introduced.files.map((f) => f.path)).toEqual(['data/x.csv']);

    // Then, during the replay, data becomes a link to a directory outside the workspace, holding a
    // file with the recording's bytes at the same name.
    await writeFile(join(outside, 'x.csv'), 'RECORDED\n');
    await rm(join(ws, 'data'), { recursive: true, force: true });
    symlinkSync(outside, join(ws, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await removeIntroduced(ws, introduced, out);
      expect(
        await readFile(join(outside, 'x.csv'), 'utf8'),
        'the removal followed a link out of the workspace',
      ).toBe('RECORDED\n');
    } finally {
      unlinkSync(join(ws, 'data'));
    }
  });
});
