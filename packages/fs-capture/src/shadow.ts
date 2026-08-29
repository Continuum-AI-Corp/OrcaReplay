import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { GitOptions } from './git.js';
import { gitAvailable, runGit, runGitRaw } from './git.js';

/** git's hardcoded id for a tree with no entries; always resolvable, even in a fresh store. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileChange {
  path: string;
  status: FileStatus;
  oldPath?: string;
  insertions: number;
  deletions: number;
}

export interface ShadowIndexOptions {
  gitDir: string;
  workTree: string;
}

export interface MaterializeOptions {
  /** Proceed even though part of the tree cannot be reproduced. See {@link ShadowIndex.materialize}. */
  allowIncomplete?: boolean;
}

export const GIT_MISSING_MESSAGE =
  'git is required for filesystem capture; install git or run with --no-fs';

/**
 * Paths never captured, in .gitignore syntax. Secrets first, then noise that would bloat every
 * snapshot, then `.orca/` so a run never records its own trace.
 */
export const SENSITIVE_PATTERNS = [
  '.env*',
  '.ssh/',
  '.aws/',
  '.netrc',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_ed25519*',
  '.orca/',
  'node_modules/',
  '.git/',
] as const;

/** Mode git gives a nested repository staged as a gitlink. */
const GITLINK_MODE = '160000';

/**
 * The same policy as a pathspec. A `.gitignore` in the workspace outranks `$GIT_DIR/info/exclude`,
 * so a single `!.env` line there would otherwise re-include a secret; pathspec exclusions are
 * applied by `git add` itself and no ignore file can override them.
 */
function toPathspecs(pattern: string): string[] {
  if (pattern.endsWith('/')) {
    const bare = pattern.slice(0, -1);
    return [`:(exclude,glob)**/${bare}`, `:(exclude,glob)**/${bare}/**`];
  }
  return [`:(exclude,glob)**/${pattern}`];
}

const SENSITIVE_PATHSPECS = SENSITIVE_PATTERNS.flatMap(toPathspecs);

function statusOf(letter: string): FileStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'added';
    default:
      return 'modified';
  }
}

/** numstat writes `-` for a binary file, which is zero lines, not an unknown count. */
function toCount(field: string | undefined): number {
  const parsed = Number.parseInt(field ?? '', 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

interface RawRecord {
  letter: string;
  path: string;
  oldPath?: string;
}

/**
 * A workspace snapshotted into a git object store that is not the workspace's own repository.
 *
 * Every operation names `--git-dir` and `--work-tree` explicitly, so nothing here can write to a
 * real `.git`, and the workspace never learns it is being recorded.
 */
export class ShadowIndex {
  private constructor(
    readonly gitDir: string,
    readonly workTree: string,
  ) {}

  static async isAvailable(): Promise<boolean> {
    return gitAvailable();
  }

  static async create(opts: ShadowIndexOptions): Promise<ShadowIndex> {
    if (!(await gitAvailable())) throw new Error(GIT_MISSING_MESSAGE);
    const { gitDir, workTree } = opts;
    await mkdir(gitDir, { recursive: true });
    const init = await runGit(['init', '--bare', '-q', gitDir]);
    if (init.code !== 0) {
      throw new Error(`failed to create shadow git dir at ${gitDir}: ${init.stderr.trim()}`);
    }
    // Byte fidelity on materialize, and no chance of git running a filesystem-monitor hook.
    for (const [key, value] of [
      ['core.autocrlf', 'false'],
      ['core.eol', 'lf'],
      ['core.fsmonitor', 'false'],
      ['gc.auto', '0'],
    ]) {
      await runGit(['config', key as string, value as string], { gitDir });
    }
    await mkdir(join(gitDir, 'info'), { recursive: true });
    await writeFile(join(gitDir, 'info', 'exclude'), `${SENSITIVE_PATTERNS.join('\n')}\n`, 'utf8');
    return new ShadowIndex(gitDir, workTree);
  }

  private opts(extra: GitOptions = {}): GitOptions {
    return {
      gitDir: this.gitDir,
      workTree: this.workTree,
      cwd: this.workTree,
      indexFile: join(this.gitDir, 'index'),
      ...extra,
    };
  }

  private async run(args: string[], extra?: GitOptions): Promise<string> {
    const res = await runGit(args, this.opts(extra));
    if (res.code !== 0) {
      throw new Error(`git ${args[0] ?? ''} failed (${res.code}): ${res.stderr.trim()}`);
    }
    return res.stdout;
  }

  /** Stages the whole work tree and returns the resulting tree id. No commit is created. */
  async snapshot(): Promise<string> {
    await this.run(['add', '-A', '--', '.', ...SENSITIVE_PATHSPECS]);
    return (await this.run(['write-tree'])).trim();
  }

  async diff(fromTree: string, toTree: string): Promise<FileChange[]> {
    // --raw and --numstat accumulate into one report; --name-status would *replace* --numstat,
    // which is why the status letters are read out of the raw block instead.
    const out = await this.run([
      'diff-tree',
      '-r',
      '-M',
      '-z',
      '--raw',
      '--numstat',
      fromTree,
      toTree,
    ]);
    const tokens = out.split('\0');
    let cursor = 0;
    const records: RawRecord[] = [];
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (token === undefined) break;
      if (token === '') {
        cursor += 1;
        continue;
      }
      if (!token.startsWith(':')) break;
      const fields = token.split(' ');
      const letter = (fields[fields.length - 1] ?? 'M').charAt(0);
      cursor += 1;
      const first = tokens[cursor++] ?? '';
      if (letter === 'R' || letter === 'C') {
        records.push({ letter, oldPath: first, path: tokens[cursor++] ?? '' });
      } else {
        records.push({ letter, path: first });
      }
    }

    const counts = new Map<string, { insertions: number; deletions: number }>();
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      cursor += 1;
      if (token === undefined) break;
      if (token === '') continue;
      const fields = token.split('\t');
      const insertions = toCount(fields[0]);
      const deletions = toCount(fields[1]);
      // A rename leaves the path field empty and follows with old and new paths as their own
      // records, because a NUL-separated numstat cannot hold two paths in one field.
      let path = fields[2] ?? '';
      if (path === '') {
        cursor += 1;
        path = tokens[cursor++] ?? '';
      }
      counts.set(path, { insertions, deletions });
    }

    return records.map((record) => {
      const count = counts.get(record.path) ?? { insertions: 0, deletions: 0 };
      const change: FileChange = {
        path: record.path,
        status: statusOf(record.letter),
        insertions: count.insertions,
        deletions: count.deletions,
      };
      if (record.oldPath !== undefined) change.oldPath = record.oldPath;
      return change;
    });
  }

  async patch(fromTree: string, toTree: string, path?: string): Promise<string> {
    const args = ['diff-tree', '-r', '-M', '-p', fromTree, toTree];
    if (path !== undefined) args.push('--', path);
    return this.run(args);
  }

  async readFileAt(tree: string, path: string): Promise<Uint8Array> {
    const res = await runGitRaw(['cat-file', 'blob', `${tree}:${path}`], this.opts());
    if (res.code !== 0) {
      throw new Error(`cannot read ${path} at tree ${tree}: ${res.stderr.trim()}`);
    }
    return new Uint8Array(res.stdout);
  }

  /**
   * Writes the whole tree into `destDir`. Fork replay debugs whatever this produces, so it refuses
   * a tree holding a nested repository: `git add` records those as a gitlink whose contents were
   * never stored, and checkout would silently leave an empty directory in their place.
   */
  async materialize(tree: string, destDir: string, opts: MaterializeOptions = {}): Promise<void> {
    await mkdir(destDir, { recursive: true });
    const indexFile = join(this.gitDir, `materialize-${randomBytes(8).toString('hex')}.index`);
    try {
      await this.run(['read-tree', tree], { indexFile });
      const staged = await this.run(['ls-files', '--stage', '-z'], { indexFile });
      const gitlinks = staged
        .split('\0')
        .filter((entry) => entry.startsWith(`${GITLINK_MODE} `))
        .map((entry) => entry.slice(entry.indexOf('\t') + 1));
      if (gitlinks.length > 0 && opts.allowIncomplete !== true) {
        throw new Error(
          `cannot materialize tree ${tree} byte for byte: it contains embedded git ` +
            `repositories whose contents were never captured (${gitlinks.join(', ')}). ` +
            'Ignore or remove them in the workspace, or pass allowIncomplete to accept the gap.',
        );
      }
      await this.run(['checkout-index', '-a', '-f'], {
        indexFile,
        workTree: destDir,
        cwd: destDir,
      });
    } finally {
      await rm(indexFile, { force: true });
    }
  }
}
