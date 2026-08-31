import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionSupport } from '@orcareplay/plugin-api';

export type { SessionSupport };

/**
 * Capturing what the harness itself wrote about the session.
 *
 * Orca's own capture layers record the *effects* of a run — model calls, tool calls, file writes,
 * shell commands. None of them record the *stimulus*: what the person typed. A run started as
 * `orca record claude` and driven by hand therefore replays into an agent with nothing to make it
 * ask anything, which is why an interactive recording came back blank while an `-p` one replayed
 * perfectly.
 *
 * Both harnesses already write that missing half to disk themselves, in their own transcript, and
 * both can be pointed back at a session by id. So orca does not need to intercept a terminal: it
 * needs to notice which file the harness just wrote, keep a copy, and read the prompts back out.
 */

/** What a harness recorded about one session, in the two forms orca needs. */
export interface SessionCapture {
  /** Harness session id, where the harness has one. This is what `--resume` takes. */
  id?: string;
  /** Path of the transcript relative to the harness session directory. */
  relPath: string;
  /** The harness's own file, verbatim. Restoring it is what makes a native fork possible. */
  bytes: Uint8Array;
  /** The user's turns, in order — the stimulus orca could not otherwise reconstruct. */
  prompts: string[];
}

/** A directory listing keyed by path, so a second listing can be diffed against it. */
export type DirSnapshot = Map<string, number>;

/**
 * List every file under `dir` with its mtime.
 *
 * Never throws. A harness that has never run has no directory, a sandbox may deny it, and neither
 * is a reason to fail a recording that is otherwise fine.
 */
export async function snapshotDir(dir: string | undefined): Promise<DirSnapshot> {
  const seen: DirSnapshot = new Map();
  if (dir === undefined) return seen;
  async function walk(current: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        try {
          seen.set(rel, (await stat(full)).mtimeMs);
        } catch {
          // Vanished between listing and stat — a rotating transcript, and not ours to mind.
        }
      }
    }
  }
  await walk(dir, '');
  return seen;
}

/**
 * The transcript this run produced: the newest file that is new, or whose mtime moved.
 *
 * Newest rather than only-new because a harness resumed into an existing session appends to the
 * file it already had, and that session is still the one this run belongs to.
 */
export async function captureSession(
  support: SessionSupport,
  cwd: string,
  env: Record<string, string | undefined>,
  before: DirSnapshot,
): Promise<SessionCapture | undefined> {
  const dir = support.dir(cwd, env);
  if (dir === undefined) return undefined;
  const after = await snapshotDir(dir);

  let best: { relPath: string; mtime: number } | undefined;
  for (const [relPath, mtime] of after) {
    if (before.get(relPath) === mtime) continue;
    if (best === undefined || mtime > best.mtime) best = { relPath, mtime };
  }
  if (best === undefined) return undefined;

  let bytes: Uint8Array;
  try {
    bytes = await readFile(join(dir, best.relPath));
  } catch {
    return undefined;
  }

  let parsed: { id?: string; prompts: string[] } = { prompts: [] };
  try {
    parsed = support.parse(bytes);
  } catch {
    // A format orca does not recognise still has value as bytes a human can read; losing the
    // prompts is a degraded capture, not a failed one.
  }
  return { id: parsed.id, relPath: best.relPath, bytes, prompts: parsed.prompts };
}

/** Read a JSONL transcript into objects, skipping anything that does not parse. */
export function parseJsonl(bytes: Uint8Array): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of new TextDecoder().decode(bytes).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === 'object') out.push(value as Record<string, unknown>);
    } catch {
      // A half-written final line is normal for a transcript captured while the harness exits.
    }
  }
  return out;
}

/** Flatten the several shapes a harness uses for message content into plain text. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block !== null && typeof block === 'object' && 'text' in block) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}
