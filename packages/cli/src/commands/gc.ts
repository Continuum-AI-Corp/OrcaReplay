import { createReadStream } from 'node:fs';
import { readFile, readdir, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { listRuns, runsDir } from '@orcareplay/core';
import type { ParsedArgs } from '../args.js';
import type { Output } from '../out.js';

export interface GcResult {
  runsRemoved: number;
  /** Scratch fork worktrees reclaimed alongside their runs. */
  worktreesRemoved: number;
  blobsRemoved: number;
  bytesReclaimed: number;
}

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const HEX64 = /^[0-9a-f]{64}$/;
/** Any digest mentioned anywhere in an event line counts as a reference. See {@link inspectRun}. */
const DIGEST_IN_LINE = /[0-9a-f]{64}/g;

/** Milliseconds for `7d`, `24h`, `30m`; null for anything it will not guess at. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(text.trim().toLowerCase());
  if (!match) return null;
  const unit = UNITS[match[2]!];
  if (unit === undefined) return null;
  return Number(match[1]) * unit;
}

interface OrphanBlob {
  path: string;
  shard: string;
  bytes: number;
}

interface RunFacts {
  runId: string;
  dir: string;
  createdAt: string;
  createdMs: number;
  /** The run this one was forked from, from the manifest or from its own `fork` event. */
  parentRun?: string;
  bytes: number;
  orphans: OrphanBlob[];
  /** Scratch worktree this run executed in, when it is one orca created for a fork. */
  worktree?: string;
  /** Why blobs were left alone, when they were. */
  skippedReason?: string;
}

/**
 * `orca gc` — reclaim the space a trace store grows into.
 *
 * A run is append-only and content-addressed, so nothing inside one grows unboundedly. What grows
 * is the number of runs, and the blobs left behind when a run died between writing a payload and
 * writing the event that referenced it. Removing runs is therefore opt-in: with no retention flag
 * this only sweeps that debris and reports what it would take if asked.
 */
export async function gcCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<GcResult> {
  const dryRun = args.bool('dry-run');
  const olderThanMs = readOlderThan(args);
  const keep = readKeep(args);

  const runs = await listRuns(cwd);
  if (runs.length === 0) {
    out.plain(`no runs in ${runsDir(cwd)} — nothing to reclaim`);
    return { runsRemoved: 0, worktreesRemoved: 0, blobsRemoved: 0, bytesReclaimed: 0 };
  }

  const facts: RunFacts[] = [];
  for (const run of runs) facts.push(await inspectRun(run.runId, run.dir, run.createdAt));

  // `facts` is newest first, so --keep is simply the first n entries.
  const cutoff = olderThanMs === undefined ? undefined : Date.now() - olderThanMs;
  const doomed = new Set<string>();
  facts.forEach((run, index) => {
    if (cutoff === undefined && keep === undefined) return;
    // Both flags are constraints, not alternatives: --keep is a floor under --older-than.
    if (cutoff !== undefined && run.createdMs >= cutoff) return;
    if (keep !== undefined && index < keep) return;
    doomed.add(run.runId);
  });

  // Forking is the point of this tool, and a fork's provenance is a pointer to a run that must
  // still be there. Rescuing a parent can expose a grandparent, so this runs to a fixed point.
  const rescued = new Map<string, string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const run of facts) {
      if (doomed.has(run.runId)) continue;
      const parent = run.parentRun;
      if (parent !== undefined && doomed.delete(parent)) {
        rescued.set(parent, run.runId);
        changed = true;
      }
    }
  }

  if (dryRun) out.plain('dry run — nothing will be removed');

  out.table(
    ['RUN', 'CREATED', 'SIZE', 'ACTION'],
    facts.map((run) => [
      run.runId,
      run.createdAt,
      formatBytes(run.bytes),
      doomed.has(run.runId)
        ? 'remove'
        : rescued.has(run.runId)
          ? `keep — parent of ${rescued.get(run.runId)}`
          : 'keep',
    ]),
  );

  for (const [parent, child] of rescued) {
    out.warn('gc.parent_kept', { run: parent, child, why: 'a surviving run forked from it' });
  }

  let runsRemoved = 0;
  let worktreesRemoved = 0;
  let blobsRemoved = 0;
  let bytesReclaimed = 0;

  for (const run of facts) {
    if (!doomed.has(run.runId)) continue;
    runsRemoved += 1;
    bytesReclaimed += run.bytes;
    if (!dryRun) await rm(run.dir, { recursive: true, force: true });
    // The fork's scratch worktree goes with its run. It is deliberately *not* removed when the
    // fork finishes — it holds what the model actually did, so deleting it then would destroy the
    // thing you forked in order to look at — but nothing reclaimed it either, so a single
    // `orca compare --models a,b,c,d` left four full copies of the workspace behind forever.
    if (run.worktree !== undefined) {
      worktreesRemoved += 1;
      bytesReclaimed += await runDirBytes(run.worktree);
      if (!dryRun) await rm(run.worktree, { recursive: true, force: true });
    }
  }

  for (const run of facts) {
    if (doomed.has(run.runId)) continue;
    if (run.skippedReason !== undefined) {
      out.warn('gc.blobs_skipped', { run: run.runId, why: run.skippedReason });
      continue;
    }
    if (run.orphans.length === 0) continue;
    const shards = new Set<string>();
    for (const orphan of run.orphans) {
      blobsRemoved += 1;
      bytesReclaimed += orphan.bytes;
      shards.add(orphan.shard);
      if (!dryRun) await unlink(orphan.path).catch(() => undefined);
    }
    out.info('gc.orphans', {
      run: run.runId,
      blobs: run.orphans.length,
      bytes: run.orphans.reduce((sum, o) => sum + o.bytes, 0),
    });
    // An empty shard directory is just clutter; a non-empty one refuses and that is fine.
    if (!dryRun) for (const shard of shards) await rmdir(shard).catch(() => undefined);
  }

  if (olderThanMs === undefined && keep === undefined) {
    out.plain('');
    out.plain('  no run was removed — say which ones you mean:');
    out.plain('    orca gc --older-than 7d      # by age');
    out.plain('    orca gc --keep 10            # by count');
    out.plain('    add --dry-run to see the plan first');
  }

  out.phase('gc', {
    runs: runsRemoved,
    worktrees: worktreesRemoved || undefined,
    blobs: blobsRemoved,
    bytes: bytesReclaimed,
    dry_run: dryRun || undefined,
  });

  return { runsRemoved, worktreesRemoved, blobsRemoved, bytesReclaimed };
}

/**
 * Does this path look like a directory orca made for a fork to run in?
 *
 * Deliberately narrow, and deliberately only half the test — the caller also requires the run to
 * carry a `fork_point`. Directly inside the OS temp directory, with the prefix `replayFork` uses.
 * Anything else is left alone, including a fork whose worktree someone moved somewhere they care
 * about: an unreclaimed directory costs disk, and the alternative costs somebody's work.
 *
 * So `orca replay --worktree` is out of reach here, because an exact replay's trace has no fork
 * point. That is the right way round: you asked for a scratch copy to look at, orca printed where
 * it put it, and a garbage collector that deletes the thing you asked to keep is worse than one
 * that leaves a directory behind. The pre-replay safety snapshot is not gc's problem either —
 * replay owns that one and removes it once your files are back.
 */
function isScratchWorktree(dir: string): boolean {
  return resolve(dirname(dir)) === resolve(tmpdir()) && basename(dir).startsWith('orca-');
}

function readOlderThan(args: ParsedArgs): number | undefined {
  if (!args.has('older-than')) return undefined;
  const raw = args.str('older-than');
  const ms = raw === undefined ? null : parseDuration(raw);
  if (ms === null) {
    throw new Error(
      `--older-than needs a duration like 7d, 24h or 30m${raw === undefined ? '' : ` — got ${JSON.stringify(raw)}`}\n` +
        'units are s, m, h, d, w; for example: orca gc --older-than 7d --dry-run',
    );
  }
  return ms;
}

function readKeep(args: ParsedArgs): number | undefined {
  if (!args.has('keep')) return undefined;
  const n = args.num('keep');
  if (n === undefined || !Number.isInteger(n) || n < 0) {
    throw new Error(
      '--keep needs a whole number of runs to keep, like --keep 10\n' +
        'it keeps the n most recent runs and removes the rest',
    );
  }
  return n;
}

async function inspectRun(runId: string, dir: string, createdAt: string): Promise<RunFacts> {
  const facts: RunFacts = {
    runId,
    dir,
    createdAt,
    createdMs: Date.parse(createdAt),
    bytes: await runDirBytes(dir),
    orphans: [],
  };
  if (Number.isNaN(facts.createdMs)) facts.createdMs = 0;

  let sealed = false;
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      parent_run?: unknown;
      fork_point?: unknown;
      ended_at?: unknown;
      cwd?: unknown;
    };
    if (typeof manifest.parent_run === 'string') facts.parentRun = manifest.parent_run;
    // Only a fork's cwd is ever ours to delete. A plain recording runs in the user's project, and
    // `gc` removing that would be the worst bug this tool could have — so the fork check is the
    // load-bearing half of the guard, and the path check is the belt.
    //
    // The fork check is `fork_point`, not `parent_run`. It used to be the latter, back when the
    // only run with a parent was a fork; an exact replay now writes a trace of its own findings
    // that also names a parent, and it ran in the user's *own* directory. A project that happens
    // to live at $TMPDIR/orca-something would have satisfied the belt on its own, and the run
    // holding the evidence of what happened there is the one gc would have used to delete it.
    if (
      typeof manifest.fork_point === 'number' &&
      typeof manifest.cwd === 'string' &&
      isScratchWorktree(manifest.cwd)
    ) {
      facts.worktree = manifest.cwd;
    }
    sealed = typeof manifest.ended_at === 'string';
  } catch {
    // A run whose manifest is unreadable is still a directory with a size; it just cannot be
    // proven finished, so the guards below leave its blobs alone.
  }

  const eventsPath = join(dir, 'events.jsonl');
  const referenced = new Set<string>();
  let readable = false;
  try {
    const lines = createInterface({
      input: createReadStream(eventsPath),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    try {
      for await (const line of lines) {
        // Match digests in the raw line rather than walking parsed payloads: a blob referenced
        // from somewhere this build does not know about must still count as referenced.
        for (const digest of line.match(DIGEST_IN_LINE) ?? []) referenced.add(digest);
        if (facts.parentRun === undefined && line.includes('"fork"')) {
          facts.parentRun = forkParentOf(line);
        }
      }
    } finally {
      lines.close();
    }
    readable = true;
  } catch {
    readable = false;
  }

  if (!sealed) {
    facts.skippedReason = 'run is not sealed — it may still be recording';
    return facts;
  }
  if (!readable) {
    facts.skippedReason = 'events.jsonl is unreadable, so every blob would look unreferenced';
    return facts;
  }

  facts.orphans = await orphanBlobs(join(dir, 'blobs'), referenced);
  return facts;
}

/** The parent a forked run names in its own `fork` event — where replay records provenance. */
function forkParentOf(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as { type?: unknown; attrs?: { parent_run?: unknown } };
    if (event.type !== 'fork') return undefined;
    const parent = event.attrs?.parent_run;
    return typeof parent === 'string' ? parent : undefined;
  } catch {
    return undefined;
  }
}

async function orphanBlobs(blobsRoot: string, referenced: Set<string>): Promise<OrphanBlob[]> {
  const orphans: OrphanBlob[] = [];
  for (const shard of await readdir(blobsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!shard.isDirectory()) continue;
    const shardDir = join(blobsRoot, shard.name);
    for (const name of await readdir(shardDir).catch(() => [])) {
      // Only files named as a digest: a half-written `.tmp` belongs to whoever is writing it.
      if (!HEX64.test(name) || referenced.has(name)) continue;
      const path = join(shardDir, name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) continue;
      orphans.push({ path, shard: shardDir, bytes: info.size });
    }
  }
  return orphans;
}

/** Every byte of file content under a run directory. Shared with `orca doctor`. */
export async function runDirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await runDirBytes(path);
      continue;
    }
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
