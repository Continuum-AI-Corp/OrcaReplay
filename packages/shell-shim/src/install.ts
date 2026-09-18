import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EARLIEST_TS_MS, LATEST_TS_MS } from '@orcareplay/schema';
import type { ShellFrame } from './runner.js';
import {
  assertPrivatePathIdentity,
  privatePathIdentity,
  removePrivateDirectory,
  restrictToOwner,
} from '@orcareplay/core';

/**
 * Shells an agent actually reaches for. Shimming more binaries buys detail and costs blast radius.
 *
 * `zsh` is here because of how harnesses resolve their shell rather than despite it: OpenCode
 * reads `$SHELL` and execs that binary by absolute path, so a PATH shim in front of `bash` and
 * `sh` alone sat unused on every macOS run while the shell tool happily used `/bin/zsh`. The
 * adapter points `$SHELL` at the shim instead, which requires a shim named `zsh` to exist.
 */
export const DEFAULT_SHIMS = ['sh', 'bash', 'zsh'] as const;

export interface InstallOptions {
  runDir: string;
  /**
   * Defaults to a private temporary directory, not the run directory.
   *
   * The frames file is a transport: orca reads it once, turns each frame into a `shell.*` event,
   * and those reach disk through `TraceWriter`, which redacts. The file itself is written by the
   * shim running inside the agent's own shell invocations, so nothing orca owns can redact it on
   * the way in — and a frame carries `argv` and `cwd` verbatim, which is the most secret-dense
   * text in a run: `curl -H 'Authorization: Bearer …'`, `git clone https://user:token@host/…`,
   * an inline `AWS_SECRET_ACCESS_KEY=…`.
   *
   * While it sat in the run directory that made it a sink the write path never touched, `orca
   * scrub` never rewrote, and nobody deleted — so `orca scrub --match <secret>` answered "nothing
   * matched — the trace is unchanged" with the secret still beside the trace.
   */
  framesPath?: string;
  shims?: readonly string[];
}

export interface InstalledShim {
  /** Prepend this to PATH. */
  dir: string;
  framesPath: string;
  /**
   * The directory holding {@link framesPath}, for {@link discardShellFrames} — and **only** when
   * orca minted it.
   *
   * `undefined` when the caller supplied `framesPath`, because then the directory is theirs and
   * `discardShellFrames` is `rm -rf`. Returning `dirname(framesPath)` here made a caller who put
   * the frames in a directory they cared about one `discardShellFrames` away from losing all of it
   * — a run directory, if `record` ever wired the option through, which is exactly what the option
   * is for.
   */
  transportDir: string | undefined;
  shimmed: string[];
  /** Environment overlay the child needs for the shims to work. */
  env: Record<string, string>;
}

/**
 * Write a directory of shim executables to prepend to PATH.
 *
 * On POSIX, each shim is a small shell script whose shebang names an absolute interpreter, so it
 * never consults PATH to start — and PATH is exactly where our own shims live. Windows cannot
 * execute an extensionless script from PATH, so it gets a `.cmd` shim with the same argv contract.
 */
export async function installShellShim(options: InstallOptions): Promise<InstalledShim> {
  const dir = join(options.runDir, 'shims');
  const transportDir = options.framesPath
    ? undefined
    : await secureTransport(await mkdtemp(join(tmpdir(), 'orca-shell-')));
  const framesPath = options.framesPath ?? join(transportDir!, 'shell-frames.jsonl');
  const shims = options.shims ?? DEFAULT_SHIMS;

  await mkdir(dir, { recursive: true });

  const runner = await resolveRunnerBin();
  const node = process.execPath;
  const windows = process.platform === 'win32';

  for (const name of shims) {
    const script = windows
      ? [
          '@echo off',
          'rem Written by orca record. Runs the real binary and notes what happened.',
          `${quoteCmd(node)} ${quoteCmd(runner)} ${quoteCmd(name)} ${quoteCmd(dir)} ${quoteCmd(framesPath)} -- %*`,
          'exit /b %ERRORLEVEL%',
          '',
        ].join('\r\n')
      : [
          '#!/bin/sh',
          '# Written by orca record. Runs the real binary and notes what happened.',
          `exec ${quotePosix(node)} ${quotePosix(runner)} ${quotePosix(name)} ${quotePosix(dir)} ${quotePosix(framesPath)} -- "$@"`,
          '',
        ].join('\n');
    const path = join(dir, windows ? `${name}.cmd` : name);
    await writeFile(path, script, { mode: 0o755 });
    await chmod(path, 0o755);
  }

  if (transportDir !== undefined) {
    // Who to ask about later: orca's sweep decides an abandoned transport by whether the process
    // that minted it is still running, because the directory's own mtime stops moving the moment
    // it is created — every frame after that is an append to the file inside it.
    await writeFile(join(transportDir, 'owner.pid'), String(process.pid), { mode: 0o600 }).catch(
      () => undefined,
    );
  }

  await writeFile(framesPath, '', { flag: 'a', mode: 0o600 }).catch(() => {
    // An unwritable frames file must not stop the run; the shim swallows write errors too.
  });

  return {
    dir,
    framesPath,
    transportDir,
    shimmed: [...shims],
    env: { ORCA_SHIM_DIR: dir, ORCA_SHIM_FRAMES: framesPath },
  };
}

/**
 * Take the transport away once it has been read.
 *
 * The directory, not the file: nothing else was ever put in it, and removing the directory also
 * takes anything a shell that outlived the run wrote beside the file afterwards. Returns a message
 * rather than throwing — a run that produced a trace must not fail at teardown.
 */
export async function discardShellFrames(dir: string): Promise<string | undefined> {
  try {
    await rm(dir, { recursive: true, force: true });
    return undefined;
  } catch (err) {
    return String(err);
  }
}

/**
 * Read back what the shims observed. Tolerates a partial final line, like events.jsonl.
 *
 * Tolerating has to mean more than surviving `JSON.parse`. Every shim writes this file
 * concurrently, and the only consumer spreads `frame.argv` into an event — so a line that parsed
 * to `null`, or to an object whose `argv` is not an array, threw where the run was being sealed.
 * Two shims appending at once is enough to produce one: an interleaved write can leave a line that
 * is valid JSON and not a frame.
 *
 * What has to be checked is every field whose absence is *unsafe*, which is not the same as every
 * field that is read. `cwd`, `exitCode`, `signal` and the byte counts go into `attrs`, which the
 * schema types as a bare object — a missing one degrades a field and nothing more. Four are
 * different:
 *
 *   - `name` and `argv` are spread into an array, so a non-array `argv` throws
 *   - `startedAt` and `durationMs` are *added* — the consumer builds
 *     `new Date(Date.parse(startedAt) + durationMs)`, and a missing `durationMs` makes that an
 *     Invalid Date, which throws `RangeError: Invalid time value` inside `TraceWriter.append`
 *
 * The second pair is the one a narrower check missed. A frame torn between `startedAt` and
 * `durationMs`, closed by a brace from the neighbouring write, is valid JSON with a string `name`,
 * an array `argv` and a parseable `startedAt` — and it ended the run and left the trace unsealed.
 *
 * But that pair is a pair, and only together. `durationMs` is unsafe *where it is added to an
 * instant*, and when there is no instant the consumer never adds it — it guards both uses of the
 * timestamp with `Date.parse(startedAt)` being a number, and otherwise puts the duration in
 * `attrs` and stamps the events from the drain's own clock. Checking it unconditionally therefore
 * threw away the frame this reader exists to keep: the shim writes `startedAt` and `durationMs`
 * next to each other, in that order, so the tear that loses the timestamp loses the duration with
 * it, and the command lost both its events — the outcome the paragraph above says must not happen,
 * from the check written to prevent it.
 *
 * For those two, being the right *type* is not enough: what the consumer needs is an instant that
 * exists. A splice can leave the digits of one duration followed by the tail of the neighbour's
 * number, and `Number.isFinite` is happy with a sixteen-digit result. Measured from a 2026 stamp:
 *
 *     durationMs 2.5e14  →  9948-11-18T…              accepted
 *     durationMs 3e14    →  +011533-04-27T…           `ts must match format "date-time"`
 *     durationMs 9e15    →  RangeError: Invalid time value
 *
 * Both throw inside `TraceWriter.append`, where the trace is being sealed — the schema types `ts`
 * as `date-time`, which admits a four-digit year and nothing else. So the bound is the range the
 * format can express, not the range a `number` can hold.
 */

/**
 * Where every frame on a line begins.
 *
 * `record()` builds the object with `name` first and `JSON.stringify` keeps insertion order, so a
 * frame always starts here — and nothing else does, which is the property {@link framesOnLine}
 * needs. `shim.test.ts` pins the writer's half of it.
 */
const FRAME_START = '{"name":';

/**
 * Where the object starting at `from` ends, or -1 if it does not end on this line.
 *
 * Braces only: a `}` can appear in three places, and two of them are handled by counting. Inside a
 * string it is text, which is what the quote and escape tracking is for; inside a nested object it
 * is that object's, which is what the depth is for; the third is the one being looked for. Brackets
 * need no counting of their own, because a `}` inside an array belongs to an object opened in it.
 *
 * Only sound when `from` is outside any string, which is what anchoring the search on an opening
 * that cannot occur inside one buys. Started anywhere else, a fragment that stops mid-string leaves
 * every quote after it on the wrong side, and the walk confidently returns a boundary that is not
 * one — which is why what it returns is never taken on trust.
 */
function endOfObject(line: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = from; at < line.length; at += 1) {
    const ch = line[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return at + 1;
  }
  return -1;
}

/**
 * The frames on one line, which is nearly always one.
 *
 * A frame is written with a single write, and that is not a single `write` syscall: a short
 * write — a full disk, a quota, a process killed inside it — leaves part of one on disk with no
 * newline behind it, and the next writer's bytes land straight on the end. Skipping such a line
 * whole threw away whatever on it was *complete*, so work recorded in full went missing because a
 * different writer was interrupted. Losing the torn one is unavoidable; losing its neighbour is not.
 *
 * **The whole line first, then anchored, then verified.**
 *
 * A line that parses is one frame and needs none of what follows: that is every line of every
 * ordinary capture, and it is also the only thing that reads a frame whose fields are not in the
 * order this file expects. The rest is recovery, and recovery is where the care goes.
 *
 * Verified, because that is where the correctness is. The walk balances braces; only
 * `JSON.parse` knows a frame from a balanced run of bytes, and a piece that does not parse moves
 * the search to the *next candidate*, never past the piece. Advancing past a boundary the walk was
 * confident about and wrong about is how a complete frame was skipped without being read: a
 * fragment that stops inside a string leaves every quote after it on the wrong side, and the walk
 * then reports a boundary beyond the neighbour. Measured on one ordinary frame, that lost the
 * neighbour for 122 of its 166 possible cut points.
 *
 * Anchored, because the candidates have to come from somewhere and the opening is the one place on
 * a line that is certainly outside a string — JSON escapes the quotes in a value, so the sequence
 * cannot occur within one. Searching every `{` would also work, since the parse is what decides,
 * but it tries far more candidates and can hand back an object that was nested inside the fragment.
 *
 * A fragment on its own yields nothing, which is the partial final line this has always tolerated —
 * recovery must not invent a frame out of a prefix.
 */
function framesOnLine(line: string): Record<string, unknown>[] {
  // The ordinary line is one whole frame, whatever key it happens to begin with — one written
  // by a version that ordered its fields differently, or one that simply has no such field, is
  // still a frame and is still on a line of its own. Only a line that does not parse needs the
  // rest of this, and that is a line a short write left holding more than it should.
  try {
    const whole: unknown = JSON.parse(line);
    return whole !== null && typeof whole === 'object' && !Array.isArray(whole)
      ? [whole as Record<string, unknown>]
      : [];
  } catch {
    // Not one frame: a fragment, or a fragment with something whole stuck to it.
  }
  const found: Record<string, unknown>[] = [];
  let at = line.indexOf(FRAME_START);
  while (at !== -1) {
    const end = endOfObject(line, at);
    let next = at + 1;
    if (end !== -1) {
      try {
        // A slice that starts at `{` and ends at the `}` that closed it parses to an object or
        // not at all, which is what lets the callers below take the type on trust.
        found.push(JSON.parse(line.slice(at, end)) as Record<string, unknown>);
        next = end;
      } catch {
        // Balanced, and not a frame. The opening after it may still start one.
      }
    }
    at = line.indexOf(FRAME_START, next);
  }
  return found;
}
export async function readShellFrames(framesPath: string): Promise<ShellFrame[]> {
  const raw = await readFile(framesPath, 'utf8').catch(() => '');
  const frames: ShellFrame[] = [];
  // One line is one frame, except where a short write glued a fragment and a frame onto the same
  // one. What comes back has parsed; everything below is unchanged, because recovery decides what
  // to *look* at and never what is acceptable.
  for (const parsed of raw.split('\n').flatMap((line) => framesOnLine(line))) {
    const frame = parsed as unknown as ShellFrame;
    if (typeof frame.name !== 'string' || !Array.isArray(frame.argv)) continue;
    // Only when there is an instant to bound. A `startedAt` that is absent, or present and
    // unparseable, is already handled: the consumer drops `occurredAt` for it and stamps the event
    // with the drain's own clock, which is a degraded field rather than a failure — so rejecting
    // the frame here would lose a command that ran. `Date.parse` is NaN for both, which is why one
    // check covers them; requiring a *string* rejected the absent case, out of step with the MCP
    // reader written in the same change and with the sentence above it.
    const startedMs = Date.parse(frame.startedAt);
    if (!Number.isNaN(startedMs)) {
      // And the duration belongs inside the same branch, for the same reason: it is unsafe where
      // it is *added* to that instant, and nowhere else. Outside it, the consumer only copies the
      // duration into `attrs`, where an absent one omits a key. Checked unconditionally, it threw
      // away precisely the frame the sentence above is about — the shim writes `startedAt` and
      // `durationMs` adjacent and in that order, so a tear before the timestamp takes the duration
      // too, and the command lost both its events to the check meant to save them.
      if (!Number.isFinite(frame.durationMs)) continue;
      const endedMs = startedMs + frame.durationMs;
      if (startedMs < EARLIEST_TS_MS || startedMs > LATEST_TS_MS) continue;
      if (endedMs < EARLIEST_TS_MS || endedMs > LATEST_TS_MS) continue;
    }
    frames.push(frame);
  }
  return frames;
}

/**
 * Locate the compiled shim entry point.
 *
 * This module is loaded from `dist/` in a real install but from `src/` when the workspace aliases
 * packages to source, and only the compiled `.js` can actually be exec'd. Resolving by probing
 * rather than assuming means the shim works in both, and fails with a sentence instead of an
 * empty stdout when it works in neither.
 */
export async function resolveRunnerBin(): Promise<string> {
  const candidates = [
    new URL('./runner-bin.js', import.meta.url),
    new URL('../dist/runner-bin.js', import.meta.url),
  ].map((url) => fileURLToPath(url));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next layout
    }
  }
  throw new Error(
    `orca shell-shim: no compiled runner found (looked in ${candidates.join(', ')})\n` +
      '  run `npm run build` before recording with shell capture',
  );
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The transport, narrowed before a single byte goes into it.
 *
 * `mkdtemp` is documented as giving a directory only this user can enter, and on POSIX it does —
 * 0700. On Windows the mode is discarded and the directory takes whatever `%TEMP%` hands down,
 * which is not always the profile: measured on one machine it carried a local group and a second
 * account, both with Modify. What lands here is `shell-frames.jsonl`, and the doc comment on this
 * package already says what that is — argv and cwd verbatim, so a `curl -H "Authorization: …"` or
 * a `git clone https://user:token@host/…` is in it in full.
 *
 * Before anything is written, not after: `icacls` does not re-propagate to children that already
 * exist, so a directory narrowed after `owner.pid` and the frames file were created would leave
 * both of them holding the ACL they inherited.
 *
 * Failing here fails the install. The caller treats that as "this layer is unavailable" and the
 * run continues without shell capture — which is the right way round: not capturing beats writing
 * every command the agent runs into a file this cannot vouch for.
 */
async function secureTransport(dir: string): Promise<string> {
  // POSIX mkdtemp already creates 0700, including on filesystems that reject chmod.
  if (process.platform !== 'win32') return dir;
  const was = await privatePathIdentity(dir);
  try {
    await restrictToOwner(dir, 0o700);
    await assertPrivatePathIdentity(dir, was);
    // Keep it non-empty before returning to the installer, which may await other work before
    // writing frames. Failure to establish this guard must fail the capture layer.
    await writeFile(join(dir, 'owner.pid'), String(process.pid), { mode: 0o600, flag: 'wx' });
    await assertPrivatePathIdentity(dir, was);
    return dir;
  } catch (err) {
    await removePrivateDirectory(dir, was);
    throw err;
  }
}
