import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Output } from '../src/out.js';
import { removeIntroduced } from '../src/commands/replay.js';

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
  });
});
