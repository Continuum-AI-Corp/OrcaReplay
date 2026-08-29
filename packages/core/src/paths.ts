import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUN_ID_PATTERN } from '@orcareplay/schema';

export interface RunRef {
  runId: string;
  /** RFC3339, from the manifest when it is readable, else the directory's mtime. */
  createdAt: string;
  dir: string;
  /** Set when this run was forked from another (spec §1). Absent on a plain recording. */
  parentRun?: string;
  forkPoint?: number;
}

export function orcaDir(cwd: string): string {
  return join(cwd, '.orca');
}

export function runsDir(cwd: string): string {
  return join(orcaDir(cwd), 'runs');
}

/**
 * Create `.orca/runs`, and make the store ignore itself.
 *
 * A recording is the conversation the model saw — which is your source — plus shell output, a
 * snapshot of the whole workspace, and an environment allowlist. SECURITY.md says to treat one as
 * roughly as sensitive as a shell history plus a heap dump. It was also landing in `git status` as
 * an untracked directory, one `git add -A` away from being committed and pushed, in the working
 * tree of the project it just recorded.
 *
 * `.orca/.gitignore` containing `*` is git's own idiom for a directory that excludes itself: no
 * edit to the user's `.gitignore`, nothing to remember, and it works in a repo orca has never seen
 * before. Written once at creation and never rewritten, so anyone who deliberately wants their
 * traces tracked can delete it and orca will not put it back.
 */
export async function ensureRunsDir(cwd: string): Promise<string> {
  const dir = runsDir(cwd);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ignore = join(orcaDir(cwd), '.gitignore');
  if (!(await stat(ignore).catch(() => null))) {
    await writeFile(
      ignore,
      '# Recordings hold source, shell output and workspace snapshots. Not for committing.\n*\n',
      { mode: 0o600, flag: 'wx' },
    ).catch(() => undefined);
  }
  return dir;
}

/** Run ids reach us from argv, so the pattern check is also the path-traversal guard. */
export function runDirFor(cwd: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`not a valid run id: ${JSON.stringify(runId)}`);
  return join(runsDir(cwd), runId);
}

/**
 * The manifest facts a listing needs, read in one pass.
 *
 * Everything here degrades rather than throws: a run whose manifest is missing or truncated is
 * still worth listing — that is exactly the crashed run someone is looking for.
 */
async function factsOf(dir: string): Promise<Omit<RunRef, 'runId' | 'dir'>> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      created_at?: unknown;
      parent_run?: unknown;
      fork_point?: unknown;
    };
    const at = raw.created_at;
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) {
      return {
        createdAt: at,
        ...(typeof raw.parent_run === 'string' ? { parentRun: raw.parent_run } : {}),
        ...(typeof raw.fork_point === 'number' ? { forkPoint: raw.fork_point } : {}),
      };
    }
  } catch {
    // Fall through to the directory's mtime.
  }
  return { createdAt: new Date((await stat(dir)).mtimeMs).toISOString() };
}

/** Every recorded run in the workspace, newest first. */
export async function listRuns(cwd: string): Promise<RunRef[]> {
  const root = runsDir(cwd);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const runs: RunRef[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !RUN_ID_PATTERN.test(e.name)) continue;
    const dir = join(root, e.name);
    runs.push({ runId: e.name, dir, ...(await factsOf(dir)) });
  }
  return runs.sort((a, b) =>
    a.createdAt === b.createdAt
      ? b.runId.localeCompare(a.runId)
      : b.createdAt.localeCompare(a.createdAt),
  );
}

/**
 * A run that describes another run rather than being one: an exact replay's own trace.
 *
 * It holds divergences and nothing else — no exchanges, no blobs, no filesystem store. A fork is
 * not one of these: it has a `fork_point`, real exchanges and a worktree, and is a thing you act
 * on.
 */
function isReplayTrace(run: RunRef): boolean {
  return run.parentRun !== undefined && run.forkPoint === undefined;
}

/**
 * Resolves the CLI's run argument: `last` for the newest run, anything else as a run id.
 *
 * `last` skips replay traces. Since exact replay started writing one, the newest run in a
 * directory is usually a report about the run before it, and every command defaults to `last` — so
 * that quietly redirected all of them. The sharpest case is the line in the README:
 * `orca scrub last --match my-hostname` scrubbed the empty trace, found nothing, and said "nothing
 * matched — the trace is unchanged", while the secret sat in the recording beside it. A security
 * tool reporting clean because it searched the wrong thing is worse than one that fails.
 *
 * Naming a replay trace explicitly still resolves it, and when a directory holds nothing else it
 * is still returned — a selector that refuses to resolve is not an improvement.
 */
export async function resolveRunSelector(cwd: string, selector: string): Promise<RunRef> {
  if (selector === 'last') {
    const runs = await listRuns(cwd);
    const newest = runs.find((r) => !isReplayTrace(r)) ?? runs[0];
    if (!newest) {
      throw new Error(
        `no runs recorded in ${runsDir(cwd)} — record one first: orca record -- <your agent>`,
      );
    }
    return newest;
  }
  const dir = runDirFor(cwd, selector);
  const found = (await listRuns(cwd)).find((r) => r.dir === dir);
  if (!found) throw new Error(`no run ${selector} in ${runsDir(cwd)} — list runs with: orca list`);
  return found;
}
