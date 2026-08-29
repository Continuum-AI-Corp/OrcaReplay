import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { GitInfo } from '@orcareplay/schema';
import { runGit } from './git.js';
import type { FileChange, MaterializeOptions } from './shadow.js';
import { ShadowIndex } from './shadow.js';

export interface FsCaptureOptions {
  runDir: string;
  cwd: string;
}

export interface TurnSnapshot {
  tree: string;
  changes: FileChange[];
  /** True when there was no previous tree to diff against, so `changes` is empty by definition. */
  firstSnapshot: boolean;
}

/**
 * Turn-level workspace capture for a run.
 *
 * One snapshot per model turn rather than a filesystem watcher: a watcher races the agent and
 * loses writes it never saw, while a snapshot is whatever the tree actually was at the point the
 * turn ended.
 */
export class FsCapture {
  private previousTree: string | undefined;
  private lastTurn = -1;

  private constructor(
    readonly runDir: string,
    readonly cwd: string,
    private readonly shadow: ShadowIndex,
  ) {}

  /** Spec §1: the shadow object store lives at `<run_dir>/fs`. */
  static async start(opts: FsCaptureOptions): Promise<FsCapture> {
    const shadow = await ShadowIndex.create({
      gitDir: join(opts.runDir, 'fs'),
      workTree: opts.cwd,
    });
    return new FsCapture(opts.runDir, opts.cwd, shadow);
  }

  static async isAvailable(): Promise<boolean> {
    return ShadowIndex.isAvailable();
  }

  async snapshotTurn(turn: number): Promise<TurnSnapshot> {
    if (!Number.isInteger(turn) || turn < 0) {
      throw new Error(`turn must be a non-negative integer, got ${turn}`);
    }
    if (turn < this.lastTurn) {
      throw new Error(`turn ${turn} is before the last snapshotted turn ${this.lastTurn}`);
    }
    const tree = await this.shadow.snapshot();
    const previous = this.previousTree;
    const changes = previous === undefined ? [] : await this.shadow.diff(previous, tree);
    this.previousTree = tree;
    this.lastTurn = turn;
    return { tree, changes, firstSnapshot: previous === undefined };
  }

  currentTree(): string | undefined {
    return this.previousTree;
  }

  async restore(tree: string, destDir: string, opts?: MaterializeOptions): Promise<void> {
    await this.shadow.materialize(tree, destDir, opts);
  }

  /**
   * Provenance for the manifest, read from the *user's* repository rather than the shadow store.
   * Returns `{}` for anything that is not a readable git repo; a missing head is not an error.
   */
  async gitInfo(cwd: string = this.cwd): Promise<GitInfo> {
    const inside = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd });
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return {};

    const info: GitInfo = {};
    const head = await runGit(['rev-parse', 'HEAD'], { cwd });
    if (head.code === 0 && head.stdout.trim() !== '') info.head = head.stdout.trim();
    // symbolic-ref, not `rev-parse --abbrev-ref`: it reports the branch of an unborn HEAD and
    // exits non-zero when detached, instead of printing the literal string "HEAD".
    const branch = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd });
    if (branch.code === 0 && branch.stdout.trim() !== '') info.branch = branch.stdout.trim();
    const status = await runGit(['status', '--porcelain', ...(await this.statusPathspec(cwd))], {
      cwd,
    });
    if (status.code === 0) info.dirty = status.stdout.trim() !== '';
    return info;
  }

  /**
   * The run dir usually sits inside the workspace, so without this every run in a clean checkout
   * would report `dirty: true` because of orca's own files.
   *
   * The whole `.orca` directory is excluded, not just this run's own directory inside it.
   * Excluding one run left every *earlier* run counting as an untracked change, so the second
   * recording in a workspace reported the user's tree dirty — the same failure this exists to
   * prevent, one run later, and almost nobody records only once.
   */
  private async statusPathspec(cwd: string): Promise<string[]> {
    const top = await runGit(['rev-parse', '--show-toplevel'], { cwd });
    if (top.code !== 0) return [];
    const root = await resolvePath(top.stdout.trim());
    const run = await resolvePath(this.runDir);
    const rel = relative(root, run);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return [];

    // Cut the path back to its `.orca` segment rather than assuming a depth, so this keeps working
    // if the layout under `.orca` ever changes. No such segment: exclude the run dir alone.
    const parts = rel.split(sep);
    const orcaAt = parts.indexOf('.orca');
    const exclude = (orcaAt === -1 ? parts : parts.slice(0, orcaAt + 1)).join('/');
    return ['--', ':/', `:(top,exclude,literal)${exclude}`];
  }
}

async function resolvePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
