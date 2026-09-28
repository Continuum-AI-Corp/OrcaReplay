import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { recordCommand } from '../src/commands/record.js';
import { replayCommand } from '../src/commands/replay.js';
import { Output } from '../src/out.js';

const run = promisify(execFile);

/**
 * What `indexrag` declares, for this file only. No bundled adapter declares a path deeper than one
 * segment — and a declared path inside a nested repository needs at least two, `data/cache` inside
 * `data` — so the shape is put on the one adapter that declares paths at all, and record and
 * replay then run their real code over it. Read when `defaultAdapters()` is called, so each test
 * sets its own before recording.
 */
const declared = vi.hoisted(() => ({ capture: [] as string[], reset: [] as string[] }));

vi.mock('@orcareplay/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcareplay/adapters')>();
  return {
    ...actual,
    defaultAdapters: () => {
      const base = actual.defaultAdapters();
      const registry = new actual.AdapterRegistry();
      for (const id of base.ids()) {
        const adapter = base.get(id);
        registry.register(
          id === 'indexrag'
            ? {
                ...adapter,
                artifacts: {
                  ...adapter.artifacts,
                  capture: declared.capture,
                  resetBeforeReplay: declared.reset,
                },
              }
            : adapter,
        );
      }
      return registry;
    },
  };
});

/**
 * A DECLARED ARTIFACT PATH INSIDE A NESTED REPOSITORY, END TO END.
 *
 * The operator's own project at `data`, committed, in a workspace that ignores `data/` — the case
 * where git said nothing at all: the forced add of `data/cache` exited 0 having staged nothing, and
 * a replay resetting `data/cache` deleted the operator's files under exit 0 after printing "your
 * files are restored when the replay ends". It is also the case where only the new set names the
 * repository: ignored, it is no gitlink, and committed, it is not `uncommittedNested`.
 */
describe('a replay over a declared path inside a nested repository', () => {
  const MINE = 'work of my own, in nobody’s snapshot';
  let workspace: string;
  let scratch: string;
  let lines: string[];
  let out: Output;
  let before: string[] = [];
  const saved: Record<string, string | undefined> = {};

  // The safety copy is made under the OS temp dir, so a temp dir of this file's own is the only way
  // to count what a replay leaves behind without counting every other run on the machine. One for
  // the whole file, not one per test: core keeps a scratch directory of its own for the life of
  // the process, made under whatever the temp dir was the first time it was needed, and a temp dir
  // removed after the first test took that one with it.
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'orca-inside-tmp-'));
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
      saved[key] = process.env[key];
      process.env[key] = scratch;
    }
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-inside-e2e-'));
    before = await safetyCopies();
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });

    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'README.md'), 'the outer project');
    await writeFile(join(workspace, '.gitignore'), 'data/\nvector_store/\n');
    await writeFile(join(workspace, 'a.mjs'), "process.stdout.write('HI');");
    await mkdir(join(workspace, 'vector_store'), { recursive: true });
    await writeFile(join(workspace, 'vector_store', 'index.bin'), 'built by the run');

    const data = join(workspace, 'data');
    await mkdir(join(data, 'cache'), { recursive: true });
    await run('git', ['init', '-q'], { cwd: data });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: data });
    await run('git', ['config', 'user.name', 'Test'], { cwd: data });
    await writeFile(join(data, 'cache', 'mine.bin'), 'upstream');
    await run('git', ['add', '-A'], { cwd: data });
    await run('git', ['commit', '-qm', 'theirs'], { cwd: data });
    await writeFile(join(data, 'cache', 'mine.bin'), MINE);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function recordThenReplay(): Promise<{
    recorded: string;
    replayed: string;
    threw: boolean;
  }> {
    await recordCommand(parseArgs(['record', 'indexrag', '--', 'node', 'a.mjs']), out, workspace);
    const recorded = lines.join('');
    lines.length = 0;
    const threw = await replayCommand(parseArgs(['replay', 'last']), out, workspace).then(
      () => false,
      (error: Error) => {
        lines.push(error.message);
        return true;
      },
    );
    return { recorded, replayed: lines.join(''), threw };
  }

  const mine = (): Promise<string | undefined> =>
    readFile(join(workspace, 'data', 'cache', 'mine.bin'), 'utf8').catch(() => undefined);
  const safetyCopies = async (): Promise<string[]> =>
    (await readdir(scratch)).filter((entry) => entry.startsWith('orca-safety-'));
  /** What this test's replay left, not what an earlier one did. */
  const leftBehind = async (): Promise<string[]> =>
    (await safetyCopies()).filter((entry) => !before.includes(entry));

  it('refuses a reset inside it, keeps the operator’s work, and leaves nothing behind', async () => {
    declared.capture = ['data/cache', 'vector_store'];
    declared.reset = ['data/cache', 'vector_store'];
    const { recorded, replayed, threw } = await recordThenReplay();

    expect(recorded).toContain('fs.artifact_inside_repository');
    expect(threw).toBe(true);
    expect(replayed).toContain('cannot put data back');
    expect(replayed).not.toContain('replay.artifacts_reset');
    expect(await mine()).toBe(MINE);
    expect(await leftBehind()).toEqual([]);
  }, 60_000);

  it('replays when the reset does not reach it, and names it before the agent runs', async () => {
    declared.capture = ['data/cache', 'vector_store'];
    declared.reset = ['vector_store'];
    const { replayed, threw } = await recordThenReplay();

    expect(threw).toBe(false);
    // Only the new set names it here: ignored, it is no gitlink in either tree, and committed,
    // it is not among the repositories with no commit.
    expect(replayed).toMatch(/replay\.nested_kept paths=data\b/);
    expect(replayed).toContain('except inside data');
    expect(await mine()).toBe(MINE);
    expect(await leftBehind()).toEqual([]);
  }, 60_000);
});
