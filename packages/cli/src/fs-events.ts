import type { TraceWriter } from '@orcareplay/core';
import type { FsCapture } from '@orcareplay/fs-capture';
import type { Output } from './out.js';
import { snapshotWithRetry } from './snapshot.js';

/**
 * Snapshot the workspace and write what changed.
 *
 * Shared by `orca record` and by a fork, which had none of this: a fork ran a live agent in a
 * worktree and recorded only the conversation, so its trace carried no `fs.snapshot` at all — and a
 * checkpoint is *derived* from a snapshot (spec §3). A run with no checkpoints cannot be forked, so
 * you could not fork a fork, and `orca compare last` straight after a fork failed with "this run
 * has no checkpoints" because `last` had resolved to the fork.
 *
 * Degrade, never abort: losing a snapshot costs one checkpoint, whereas throwing here would cost
 * the user the run they were in the middle of.
 */
export async function appendSnapshot(
  fs: FsCapture,
  writer: TraceWriter,
  out: Output,
  turn: number,
  options: { initial?: boolean } = {},
): Promise<void> {
  const outcome = await snapshotWithRetry(fs, turn);
  if (!outcome.ok || !outcome.snapshot) {
    out.warn('fs.snapshot_failed', { turn, attempts: outcome.attempts, error: outcome.error });
    await writer.append({
      type: 'note',
      actor: 'orca',
      turn,
      attrs: { rule: 'fs_snapshot_skipped', attempts: outcome.attempts, error: outcome.error },
    });
    return;
  }

  const snap = outcome.snapshot;
  // A declared artifact path that is a git checkout of its own — a cloned corpus under `dataset/`
  // — cannot be stored here, and is dropped so the rest of the tree stays restorable. Said once
  // per path: the whole reason `artifacts.capture` exists is that a recording missing its inputs
  // looks exactly like a recording that has them until someone replays it somewhere else.
  if (snap.skippedGitlinks !== undefined && snap.skippedGitlinks.length > 0) {
    out.warn('fs.artifact_not_captured', {
      paths: snap.skippedGitlinks.join(','),
      why:
        'these are git repositories of their own, and git stores them as a reference rather ' +
        'than as their contents',
      next:
        'a replay elsewhere will not find them; remove the nested .git, or keep them outside ' +
        'the declared artifact paths',
    });
  }
  // A nested repository with no commit of its own is not in this snapshot and cannot be: git
  // records an embedded repository by the id of its HEAD commit, and it has none. Said here for
  // the reason the line above is said — a recording that quietly omits part of the workspace looks
  // exactly like one that has all of it, right up until someone replays it. Once per path.
  if (snap.uncommittedNested !== undefined && snap.uncommittedNested.length > 0) {
    out.warn('fs.nested_not_captured', {
      paths: snap.uncommittedNested.join(','),
      why: 'these are git repositories of their own with no commit yet, so git has no id to record them by and this snapshot holds nothing of what is inside them',
      next: 'commit inside them, or move them outside the workspace, if a replay needs their contents',
    });
  }

  // A declared artifact path inside a nested repository is not in this snapshot and cannot be: git
  // stages nothing inside another repository. Before this was said, the forced add either killed
  // the snapshot — every turn, so the run held none — or quietly staged nothing, and the recording
  // looked like it held the artifacts right up until a replay needed them. Once per path.
  if (snap.forcedInsideNested !== undefined && snap.forcedInsideNested.length > 0) {
    out.warn('fs.artifact_inside_repository', {
      paths: snap.forcedInsideNested.map((entry) => entry.path).join(','),
      inside: [...new Set(snap.forcedInsideNested.map((entry) => entry.repository))].join(','),
      why: 'these declared artifact paths sit inside a git repository of their own, and git stages nothing inside another repository, so this snapshot holds none of them',
      next: 'a replay cannot put them back and will refuse to reset them; keep the artifacts outside that repository',
    });
  }

  await writer.append({
    type: 'fs.snapshot',
    actor: 'orca',
    turn,
    attrs: {
      tree: snap.tree,
      changes: snap.changes.length,
      ...(options.initial === true ? { initial: true } : {}),
    },
  });
  for (const change of snap.changes) {
    await writer.append({
      type: 'fs.change',
      actor: 'orca',
      turn,
      attrs: {
        path: change.path,
        status: change.status,
        insertions: change.insertions,
        deletions: change.deletions,
        // Only when true, so a trace is not littered with a false on every unremarkable change.
        ...(change.eolOnly === true ? { eol_only: true } : {}),
      },
    });
  }
}
