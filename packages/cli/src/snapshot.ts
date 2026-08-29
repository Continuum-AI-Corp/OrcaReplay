import type { FileChange } from '@orcareplay/fs-capture';

export interface SnapshotResult {
  tree: string;
  changes: FileChange[];
  firstSnapshot?: boolean;
}

/** The slice of FsCapture this helper needs, so it can be stubbed in tests. */
export interface SnapshotSource {
  snapshotTurn(turn: number): Promise<SnapshotResult>;
}

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
}

export interface RetryOutcome {
  ok: boolean;
  snapshot?: SnapshotResult;
  attempts: number;
  error?: string;
}

/**
 * Transient collisions between the recorder and the agent it is watching.
 *
 * We snapshot a *live* workspace, so git can catch a file mid-write ("short read while indexing")
 * or find the index momentarily locked. Both clear on their own within milliseconds, and neither
 * says anything is wrong with the run.
 */
const TRANSIENT = [/short read while indexing/i, /index\.lock/i, /unable to create.*\.lock/i];

function isTransient(message: string): boolean {
  return TRANSIENT.some((re) => re.test(message));
}

/**
 * Snapshot the workspace, retrying the races that come from watching a process that is still
 * writing.
 *
 * Never throws. A lost snapshot costs one checkpoint; an exception here would cost the user the
 * run they were actually trying to record, which is a far worse trade — and the run is the thing
 * that is hard to reproduce.
 */
export async function snapshotWithRetry(
  source: SnapshotSource,
  turn: number,
  options: RetryOptions = {},
): Promise<RetryOutcome> {
  const maxAttempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 25;

  let attempts = 0;
  let lastError = '';

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      return { ok: true, snapshot: await source.snapshotTurn(turn), attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // A permanent failure — no git, not a repository — will not fix itself, and retrying it
      // just makes the agent wait.
      if (!isTransient(lastError)) break;
      if (attempts < maxAttempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempts));
      }
    }
  }

  return { ok: false, attempts, error: lastError };
}
