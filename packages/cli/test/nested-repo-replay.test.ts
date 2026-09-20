import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { TraceReader, deriveCheckpoints } from '@orcareplay/core';
import { FsCapture } from '@orcareplay/fs-capture';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { assertRestorable, replayCommand } from '../src/commands/replay.js';
import { recordCommand } from '../src/commands/record.js';
import { Output, type LogEntry } from '../src/out.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const FAKE_AGENT = join(here, 'fixtures', 'fake-agent.mjs');

/** A repository that can commit on a machine with no global git identity. */
async function initRepo(dir: string): Promise<void> {
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

/** A repository inside another one, which is what `git add` stores as a gitlink. */
async function nestRepo(parent: string, path: string): Promise<string> {
  const dir = join(parent, ...path.split('/'));
  await mkdir(dir, { recursive: true });
  await initRepo(dir);
  await writeFile(join(dir, 'inside.txt'), 'held by the nested repo');
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-qm', 'nested'], { cwd: dir });
  return dir;
}

/** An agent that leaves a mark on the workspace and exits, needing no model to do it. */
const QUIET_AGENT = [
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync(new URL('./output.txt', import.meta.url), 'written by the agent');",
  "process.stdout.write('HI');",
].join('\n');

/**
 * Which nested repositories stop a replay, and which are simply left where they are.
 *
 * A snapshot records a nested repository as a gitlink and never holds its contents, so a restore
 * cannot put one back. Whether that matters depends entirely on whether the replay took it away
 * first: `resetArtifacts` deletes the adapter's declared reset paths before restoring, and a
 * corpus cloned into `cache/` is gone for good — but where nothing is deleted, `materialize`
 * writes the tree's files and leaves everything else alone, so the repository is still sitting
 * there, untouched, when the restore finishes.
 *
 * Refusing both cases is issue #103: `claude`, like every adapter but `indexrag`, declares no
 * reset paths, so every recording it made in a workspace holding a submodule or a vendored
 * checkout could not be replayed at all.
 */
describe('assertRestorable', () => {
  const artifacts = (resetBeforeReplay: string[]) => ({ resetBeforeReplay });
  let dir: string;
  let capture: FsCapture;
  let tree: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-nested-guard-'));
    await initRepo(dir);
    // One where an adapter could be told to delete the directory around it, one where it could not.
    await nestRepo(dir, 'cache/corpus');
    await nestRepo(dir, 'tools/vendored');
    // A real capture, so the gitlinks are the ones `git add` decides to write rather than a shape
    // this test made up — the guard's whole input is what git chose to store.
    capture = await FsCapture.start({ runDir: join(dir, '.orca-run'), cwd: dir });
    tree = (await capture.snapshotTurn(0)).tree;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lets a replay that deletes nothing go ahead, and says what it is leaving alone', async () => {
    await expect(assertRestorable(capture, tree, dir, undefined)).resolves.toEqual([
      'cache/corpus',
      'tools/vendored',
    ]);
  });

  it('refuses when the replay would delete the repository it cannot then put back', async () => {
    await expect(assertRestorable(capture, tree, dir, artifacts(['cache']))).rejects.toThrow(
      /cannot put cache\/corpus back/,
    );
  });

  it('names the repositories at risk, and not the ones that are not', async () => {
    const message = await assertRestorable(capture, tree, dir, artifacts(['cache'])).then(
      () => 'it did not refuse',
      (error: Error) => error.message,
    );
    expect(message).toContain('cache/corpus');
    expect(message).not.toContain('tools/vendored');
  });

  it('refuses when the reset path is the repository itself', async () => {
    await expect(assertRestorable(capture, tree, dir, artifacts(['cache/corpus']))).rejects.toThrow(
      /cannot put cache\/corpus back/,
    );
  });

  it('compares whole path segments, so a shorter name is not read as a parent', async () => {
    // `'cache/corpus'.startsWith('cach')` is true and means nothing: `rm -rf <cwd>/cach` does not
    // touch `cache/`. A prefix test without the separator refuses replays that were never at risk,
    // which is the bug this whole function is a narrowing of.
    await expect(assertRestorable(capture, tree, dir, artifacts(['cach']))).resolves.toHaveLength(
      2,
    );
    await expect(assertRestorable(capture, tree, dir, artifacts(['too']))).resolves.toHaveLength(2);
  });

  it('has nothing to say about a workspace that holds no nested repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'orca-nested-plain-'));
    try {
      await initRepo(plain);
      await writeFile(join(plain, 'notes.md'), 'ordinary work');
      const ordinary = await FsCapture.start({ runDir: join(plain, '.orca-run'), cwd: plain });
      const snapshot = await ordinary.snapshotTurn(0);
      await expect(
        assertRestorable(ordinary, snapshot.tree, plain, artifacts(['cache'])),
      ).resolves.toEqual([]);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

/**
 * The same thing from outside, with an adapter that declares no artifacts — which is all of them
 * but `indexrag`, and so is the case the issue was filed from.
 *
 * Every assertion below failed before: the replay exited 1 without running the agent, and did it
 * from inside the safety net rather than before it, so it printed `replay.restore_failed` telling
 * the operator their files were "in that store and were not put back" — of a working tree nothing
 * had touched — and left a copy of the whole workspace behind in the temp directory.
 */
describe('orca replay, in a workspace holding a nested git repository', () => {
  const timeout = 120_000;
  const nested = ['tools', 'nested-repo'];
  let dir: string;
  let scratch: string;
  let env: NodeJS.ProcessEnv;
  let runId: string;

  beforeEach(async () => {
    // A temp dir of this test's own: the safety copy is made under it, so one left behind can be
    // counted rather than guessed at from a directory shared with every other run on the machine.
    scratch = await mkdtemp(join(tmpdir(), 'orca-nested-tmp-'));
    dir = await mkdtemp(join(tmpdir(), 'orca-nested-ws-'));
    env = { ...process.env, NO_COLOR: '1', TMPDIR: scratch, TMP: scratch, TEMP: scratch };

    await initRepo(dir);
    await nestRepo(dir, nested.join('/'));
    await writeFile(join(dir, 'output.txt'), 'as the recording started');
    await writeFile(join(dir, 'a.mjs'), QUIET_AGENT);
    await run(process.execPath, [cli, 'record', 'node', '--', 'node', 'a.mjs'], {
      cwd: dir,
      env,
      timeout: timeout / 2,
    });
    [runId] = (await readdir(join(dir, '.orca', 'runs'))) as [string];
    // What the operator has in front of them when they ask for the replay: their own work, on top
    // of what the recorded agent left behind.
    await writeFile(join(dir, 'output.txt'), 'my own uncommitted edit');
  }, timeout);

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  /** The exit code matters as much as the output, so a rejection is read rather than thrown on. */
  async function replay(...argv: string[]): Promise<{ code: number; out: string }> {
    const result = (await run(process.execPath, [cli, 'replay', runId, ...argv], {
      cwd: dir,
      env,
      timeout: timeout / 2,
    }).catch((error: unknown) => error)) as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  }

  const safetyCopies = async (): Promise<string[]> =>
    (await readdir(scratch)).filter((entry) => entry.startsWith('orca-safety-'));

  it(
    'replays it, keeps the repository, and puts the operator’s own tree back',
    async () => {
      const { code, out } = await replay();
      expect(code, out).toBe(0);
      expect(out).toContain('replay.nested_kept');
      expect(out).toContain('tools/nested-repo');
      expect(out).not.toContain('replay.restore_failed');

      expect(await readFile(join(dir, ...nested, 'inside.txt'), 'utf8')).toBe(
        'held by the nested repo',
      );
      await expect(readdir(join(dir, ...nested, '.git'))).resolves.not.toHaveLength(0);
      // The safety net's whole promise, and the one the false refusal broke: what the operator had
      // when they ran the command is what they have when it finishes.
      expect(await readFile(join(dir, 'output.txt'), 'utf8')).toBe('my own uncommitted edit');
      expect(await safetyCopies()).toEqual([]);
    },
    timeout,
  );

  it(
    'copies what it can into a --worktree replay instead of dying inside git',
    async () => {
      const { code, out } = await replay('--worktree');
      expect(code, out).toBe(0);
      // A different sentence from the in-place case, because a fresh directory is not a working
      // tree the repository is already sitting in: there, it is simply not there.
      expect(out).toContain('replay.nested_kept');
      expect(out).toContain('absent from a fresh worktree');
      expect(await safetyCopies()).toEqual([]);
    },
    timeout,
  );
});

/**
 * `orca replay --from` — and so `orca compare`, which forks — restores a checkpoint into a
 * directory it makes itself, and used to die inside git while doing it.
 *
 * Nothing in that path deletes anything, so the tolerance is unconditional; what it owes the
 * operator is a word about the one thing the fresh worktree will not contain. The failure it
 * replaces named a tree hash and an internal parameter and no course of action.
 */
describe('a fork taken in a workspace holding a nested git repository', () => {
  const timeout = 120_000;
  let dir: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let log: LogEntry[];
  let out: Output;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-nested-fork-'));
    model = await startFakeModel();
    log = [];
    out = new Output({ write: () => {}, isTTY: false, sink: (entry) => log.push(entry) });
    await initRepo(dir);
    await nestRepo(dir, 'tools/vendored');
    await writeFile(join(dir, 'auth.ts'), 'export const fixed = false;\n');
    process.env.FAKE_AGENT_TURNS = '3';
    process.env.FAKE_AGENT_CWD = dir;
  });

  afterEach(async () => {
    await model.close();
    delete process.env.FAKE_AGENT_TURNS;
    delete process.env.FAKE_AGENT_CWD;
    await rm(dir, { recursive: true, force: true });
  });

  it(
    'restores what the checkpoint holds, and says what a fresh worktree will not have',
    async () => {
      const parent = await recordCommand(
        parseArgs([
          'record',
          'generic-openai',
          '--upstream-anthropic',
          model.url,
          '--',
          'node',
          FAKE_AGENT,
        ]),
        out,
        dir,
      );
      const events = await (await TraceReader.open(parent.runDir)).events();
      const from = deriveCheckpoints(events)[0]!.seq;
      log.length = 0;

      await replayCommand(
        parseArgs([
          'replay',
          parent.runId,
          '--from',
          String(from),
          '--upstream-anthropic',
          model.url,
        ]),
        out,
        dir,
      );

      const kept = log.find((entry) => entry.event === 'replay.nested_kept');
      expect(kept?.fields.paths).toBe('tools/vendored');
      expect(String(kept?.fields.effect)).toContain('absent from a fresh worktree');
    },
    timeout,
  );
});

/**
 * The half that still refuses, and the reason the guard runs before anything has been copied.
 *
 * `indexrag` declares `resetBeforeReplay: ['cache', 'vector_store']`, so the replay really does
 * `rm -rf cache` before restoring — and a nested repository inside it is one the restore cannot
 * refill. A recording made today cannot hold that gitlink, because the forced add drops it
 * (`ShadowIndex.dropForcedGitlinks`); the recordings that can are the ones already on disk, made
 * before it did, which is exactly who a guard is here for. So the tree is edited into the shape
 * one of those has, which is the only way to reach this from outside.
 */
describe('a recording whose snapshot holds a nested repository inside a reset path', () => {
  const timeout = 120_000;
  let dir: string;
  let scratch: string;
  let env: NodeJS.ProcessEnv;
  let runId: string;
  let runDir: string;

  /** Put a gitlink into the recorded tree, the way a pre-`dropForcedGitlinks` recording holds one. */
  async function forgeGitlink(path: string): Promise<void> {
    const store = join(runDir, 'fs');
    const eventsPath = join(runDir, 'events.jsonl');
    const lines = (await readFile(eventsPath, 'utf8')).split('\n');
    const at = lines.findIndex((line) => line.includes('"fs.snapshot"'));
    const event = JSON.parse(lines[at]!) as { attrs: { tree: string } };
    const git = (...args: string[]) =>
      run('git', ['--git-dir', store, ...args], {
        env: { ...process.env, GIT_INDEX_FILE: join(runDir, 'forge.index') },
      });
    await git('read-tree', event.attrs.tree);
    // Any commit id will do: a gitlink is a reference to a history this store never held, which
    // is the entire reason a restore cannot write one out.
    await git('update-index', '--add', '--cacheinfo', `160000,${'0'.repeat(39)}1,${path}`);
    event.attrs.tree = (await git('write-tree')).stdout.trim();
    lines[at] = JSON.stringify(event);
    await writeFile(eventsPath, lines.join('\n'));
  }

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'orca-doomed-tmp-'));
    dir = await mkdtemp(join(tmpdir(), 'orca-doomed-ws-'));
    env = { ...process.env, NO_COLOR: '1', TMPDIR: scratch, TMP: scratch, TEMP: scratch };
    await initRepo(dir);
    await mkdir(join(dir, 'cache'), { recursive: true });
    await writeFile(join(dir, 'cache', 'index.bin'), 'an index the pipeline built');
    await nestRepo(dir, 'cache/corpus-repo');
    await writeFile(join(dir, 'a.mjs'), QUIET_AGENT);
    await run(process.execPath, [cli, 'record', 'indexrag', '--', 'node', 'a.mjs'], {
      cwd: dir,
      env,
      timeout: timeout / 2,
    });
    [runId] = (await readdir(join(dir, '.orca', 'runs'))) as [string];
    runDir = join(dir, '.orca', 'runs', runId!);
  }, timeout);

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  it(
    'refuses, deletes nothing, and has not copied anything to have to put back',
    async () => {
      await forgeGitlink('cache/corpus-repo');
      const result = (await run(process.execPath, [cli, 'replay', runId!], {
        cwd: dir,
        env,
        timeout: timeout / 2,
      }).catch((error: unknown) => error)) as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(result.code ?? 0, out).not.toBe(0);
      expect(out).toContain('cannot put cache/corpus-repo back');
      // The guard runs before the safety copy, so there is no copy to announce and no scratch
      // directory to leave behind. Announcing a restore for a replay that never started is how
      // the operator came to be told their files had been moved somewhere they had not.
      expect(out).not.toContain('replay.restored');
      expect(await readdir(scratch)).toEqual([]);

      expect(await readFile(join(dir, 'cache', 'index.bin'), 'utf8')).toBe(
        'an index the pipeline built',
      );
      expect(await readFile(join(dir, 'cache', 'corpus-repo', 'inside.txt'), 'utf8')).toBe(
        'held by the nested repo',
      );
    },
    timeout,
  );
});

/**
 * What the in-place path owes the operator, now that it no longer refuses.
 *
 * `orca replay` restores the recording's tree into the operator's own directory and runs the
 * recorded agent there, live — orca does not intercept tool execution, so a recorded build step,
 * generator or `rm` reaches inside a nested repository like any other path. The safety copy holds
 * that repository only as a gitlink, so nothing it does there is reversible.
 *
 * That hole cannot be closed by a snapshot: git stores a nested repository as a commit id and
 * never its contents. What can be closed is the operator being told the opposite — the note used
 * to say "they are left exactly as they are" and the line under it "your files are restored when
 * the replay ends", of the one region where neither was true.
 */
describe('a recording whose agent writes inside the nested repository', () => {
  const timeout = 120_000;
  const nested = ['tools', 'nested-repo'];
  let dir: string;
  let scratch: string;
  let env: NodeJS.ProcessEnv;
  let runId: string;

  /** The operator's own uncommitted work, inside a vendored checkout they are patching. */
  async function operatorsWork(): Promise<void> {
    await writeFile(join(dir, ...nested, 'vendored.txt'), 'my own uncommitted patch');
    await writeFile(join(dir, ...nested, 'notes.txt'), 'notes only I have');
  }

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'orca-inside-tmp-'));
    dir = await mkdtemp(join(tmpdir(), 'orca-inside-ws-'));
    env = { ...process.env, NO_COLOR: '1', TMPDIR: scratch, TMP: scratch, TEMP: scratch };
    await initRepo(dir);
    await nestRepo(dir, nested.join('/'));
    await writeFile(
      join(dir, 'a.mjs'),
      [
        "import { writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const inside = join(process.cwd(), 'tools', 'nested-repo');",
        'if (!existsSync(inside)) mkdirSync(inside, { recursive: true });',
        "writeFileSync(join(inside, 'vendored.txt'), 'written by the replayed agent');",
        "rmSync(join(inside, 'notes.txt'), { force: true });",
        "process.stdout.write('HI');",
      ].join('\n'),
    );
    await run(process.execPath, [cli, 'record', 'node', '--', 'node', 'a.mjs'], {
      cwd: dir,
      env,
      timeout: timeout / 2,
    });
    [runId] = (await readdir(join(dir, '.orca', 'runs'))) as [string];
    await operatorsWork();
  }, timeout);

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  it(
    'says so before the agent runs, rather than promising a restore it cannot perform',
    async () => {
      const { stdout, stderr } = await run(process.execPath, [cli, 'replay', runId!], {
        cwd: dir,
        env,
        timeout: timeout / 2,
      });
      const out = `${stdout}${stderr}`;
      // Not "they are left exactly as they are", which was only ever true of the restore.
      expect(out).toContain('orca holds no copy of what is inside them');
      expect(out).toContain('--worktree');
      // And the unqualified promise on the next line carries the same exception, since that is
      // the sentence the operator actually acts on.
      expect(out).toContain('restored when the replay ends, except inside tools/nested-repo');
    },
    timeout,
  );

  it(
    'and --worktree, which it points at, really does keep the agent out',
    async () => {
      const { stdout, stderr } = await run(
        process.execPath,
        [cli, 'replay', runId!, '--worktree'],
        { cwd: dir, env, timeout: timeout / 2 },
      );
      expect(`${stdout}${stderr}`).toContain('absent from a fresh worktree');
      // The advice has to hold, or it is worse than none: the same recording, run this way,
      // leaves the operator's copy alone entirely.
      expect(await readFile(join(dir, ...nested, 'vendored.txt'), 'utf8')).toBe(
        'my own uncommitted patch',
      );
      expect(await readFile(join(dir, ...nested, 'notes.txt'), 'utf8')).toBe('notes only I have');
    },
    timeout,
  );
});
