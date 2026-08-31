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
