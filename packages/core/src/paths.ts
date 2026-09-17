import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUN_ID_PATTERN } from '@orcareplay/schema';
import { restrictToOwner } from './private-files.js';

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
  const orca = orcaDir(cwd);

  if (process.platform === 'win32') {
    // The container first, narrowed before the store under it exists.
    //
    // The order used to be create-both, check-both, narrow `runs`, narrow `.orca` — which leaves
    // the one thing that decides whether `runs` can be swapped open for the whole of it.
    // `restrictToOwner` costs about 27ms a path here (a `whoami` spawn, an `icacls /save` read, the
    // write, and a second `/save` to verify it), so the gap between checking `runs` and owning it
    // ran past 50ms with `.orca` still granting the workspace's Modify — and Modify on the parent
    // is enough to delete a child whatever the child's own DACL says. Another account can `rmdir`
    // and `mklink /J` in a loop; whenever a swap lands inside that gap the check has already
    // passed, the narrowing goes onto the link entry, and the entire run is written through it.
    //
    // Closing `.orca` first ends that: nothing else can delete or replace what is under it, so the
    // check on `runs` cannot be raced afterwards.
    await mkdir(orca, { recursive: true, mode: 0o700 });
    const orcaWas = await vouchFor(orca);
    await restrictToOwner(orca, 0o700);
    await stillTheSame(orca, orcaWas);

    await mkdir(dir, { recursive: true, mode: 0o700 });
    // And `.orca` again, because it was itself open between its own check and its own narrowing.
    //
    // By identity, not just by "is it a link". A *real* directory another account put there is
    // neither a link nor ours: it passes a link check and is then narrowed as though it were
    // orca's, and its creator owns it, so it can re-grant itself afterwards. `dev`+`ino` is the
    // volume serial and the NTFS file index, which a substitute cannot share — measured: it
    // changes when a directory of the same name is deleted and remade.
    //
    // This does not close the window — that needs the DACL applied to an open handle rather than
    // to a path, which node cannot do — but it does mean such a swap ends in a refusal rather than
    // in a recording written somewhere else.
    await stillTheSame(orca, orcaWas);
    const dirWas = await vouchFor(dir);
    await restrictToOwner(dir, 0o700);
    await stillTheSame(dir, dirWas);
  } else {
    // POSIX, unchanged: only when this call created it, which is what passing `mode` to mkdir
    // already meant. Every file beneath gets its own 0600 from the writer regardless, so the
    // directory's mode is not load-bearing, and one the user has deliberately opened up is theirs
    // to have opened up. `chmod` follows a symlink here, and pointing a store at another disk is
    // an ordinary thing to do, so there is no link check either.
    const created = (await mkdir(dir, { recursive: true, mode: 0o700 })) !== undefined;
    if (created) await restrictToOwner(dir, 0o700);
  }

  const ignore = join(orca, '.gitignore');
  if (!(await stat(ignore).catch(() => null))) {
    await writeFile(
      ignore,
      '# Recordings hold source, shell output and workspace snapshots. Not for committing.\n*\n',
      { mode: 0o600, flag: 'wx' },
    ).catch(() => undefined);
  }
  return dir;
}

/**
 * Refuse a path that is a link, on the way to writing a trace store into it.
 *
 * `icacls` does not follow a reparse point, so the narrowing would land on the link entry while
 * every trace went *through* it into whatever it points at, under that directory's ACL — and
 * `restrictToOwner` would report success. A junction needs no privilege to create, and
 * `mkdir(…, { recursive: true })` accepts one as an existing directory.
 *
 * Refused rather than followed: orca creates these directories, so a link standing where one
 * should be was not put there by orca, and a store it cannot vouch for is not one it should
 * quietly write a recording into.
 *
 * `lstat` on the entry, not `realpath` on the chain. Two reasons, both measured.
 *
 * `realpath` answers a different question — *where does this path end up* — and a drive that is
 * not a link ends up somewhere else all the same. A `subst` drive is the ordinary case: it maps a
 * letter onto a real directory, so every path under it resolves into that directory instead, the
 * two differ, and the check refused to record at all on a perfectly normal workspace. A mapped
 * network drive does the same. `lstat` on that directory reports no link, because there is none.
 *
 * And a resolution that *cannot* be made must not read as "no link here". `realpath` fails for
 * more than absence — EACCES, ELOOP, and EINVAL/UNKNOWN on filesystems that cannot answer
 * GetFinalPathNameByHandle — and swallowing those let the check skip itself silently in exactly
 * the conditions it exists for. `lstat` asks about the entry that is right here, so a failure is a
 * real failure, and it is refused like any other.
 */
async function vouchFor(path: string): Promise<Identity> {
  const entry = await lstat(path).catch((err: unknown) => {
    throw new Error(
      `${path} could not be examined (${(err as NodeJS.ErrnoException).code ?? String(err)}), ` +
        'and orca will not write a trace store into a path it cannot vouch for.',
    );
  });
  if (entry.isSymbolicLink()) {
    throw new Error(
      `${path} is a link, and orca will not write a trace store through one — the permissions ` +
        'it sets would land on the link while the recording landed wherever it points. ' +
        'Remove it, or record in a workspace where it is a real directory.',
    );
  }
  return { dev: entry.dev, ino: entry.ino };
}

/** What tells one directory from another that has taken its name. */
interface Identity {
  dev: number;
  ino: number;
}

/**
 * Refuse a path that is no longer the entry it was a moment ago.
 *
 * `vouchFor` answers "is this a reparse point", and a *real* directory another account put there
 * is neither a link nor ours — it passes, is narrowed as though it were orca's, and its creator
 * owns it, so it can re-grant itself whenever it likes.
 *
 * Only a genuine difference refuses. A filesystem that cannot give a file index answers zero for
 * both, and zero equals zero, so the check lapses rather than refusing a network share out of
 * hand. That is the opposite of what `vouchFor` does with a failure, and deliberately: there the
 * failure means "we could not look", here it means "there is nothing to compare".
 */
async function stillTheSame(path: string, was: Identity): Promise<void> {
  const now = await vouchFor(path);
  if (now.dev !== was.dev || now.ino !== was.ino) {
    throw new Error(
      `${path} was replaced while orca was securing it — the permissions it set landed on a ` +
        'directory that is no longer there. Nothing has been recorded; try again, and if it ' +
        'keeps happening, something else on this machine is writing into your workspace.',
    );
  }
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
