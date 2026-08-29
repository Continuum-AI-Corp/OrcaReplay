import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Redactor, resolveRunSelector } from '@orcareplay/core';
import { runGit, runGitRaw } from '@orcareplay/fs-capture';
import { validateEvent, validateManifest } from '@orcareplay/schema';
import type { ParsedArgs } from '../args.js';
import type { Output } from '../out.js';

const FILE_MODE = 0o600;

/** Bounds how much object content one `git cat-file --batch` holds in memory at a time. */
const BATCH_BYTES = 8 * 1024 * 1024;

export interface ScrubResult {
  runDir: string;
  filesChanged: number;
  removals: number;
  /** Lines put back unchanged because scrubbing them would have broken the trace. */
  reverted: number;
  /** Objects in the shadow filesystem store that still hold matched material. */
  fsStoreMatches: number;
  /** True when `--drop-fs` deleted the shadow store rather than leaving it behind. */
  fsStoreDropped: boolean;
}

/** What one pass of the detectors did to a piece of text. */
interface Scrubbed {
  value: string;
  removals: number;
}

/**
 * `orca scrub` — remove material from a trace after the fact.
 *
 * Write-path redaction (§7) is the first line of defence; this is the second, for the thing it
 * missed and for the internal hostname that is only sensitive in your organisation. It rewrites
 * `events.jsonl`, the manifest and every blob in place, then refreshes the integrity digest — a
 * scrubbed trace that fails its own integrity check would be unusable, which would make people
 * skip scrubbing.
 *
 * Everything it cannot remove it says out loud. A scrubber that under-reports is merely
 * disappointing; one that over-reports hands you a false all-clear, which is worse than no
 * scrubber at all.
 */
export async function scrubCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<ScrubResult> {
  const runDir = (await resolveRunSelector(cwd, args.positionals[0] ?? 'last')).dir;

  const literals = collectLiterals(args);
  const redactor = new Redactor();

  let removals = 0;
  let filesChanged = 0;
  let reverted = 0;

  /** Literal matches first, then the standard detectors over whatever is left. */
  const scrubText = (text: string): Scrubbed => {
    let next = text;
    let count = 0;
    for (const literal of literals) {
      const parts = next.split(literal);
      if (parts.length > 1) {
        count += parts.length - 1;
        // Same placeholder shape the write path uses, so a reader cannot tell which pass caught it.
        next = parts.join(placeholderFor(literal));
      }
    }
    const { value, hits } = redactor.redactString(next, 'scrub');
    return { value, removals: count + hits.length };
  };

  // The manifest names the operator: `cwd` and `argv` carry the checkout path, and
  // `env_allowlisted` carries HOME, PATH and USER verbatim. It goes through the same detectors as
  // everything else — and it goes first, because a scrub that would leave it invalid has to stop
  // before the trace is half-rewritten rather than after.
  const manifestPath = join(runDir, 'manifest.json');
  const manifestBefore = await readFile(manifestPath, 'utf8');
  const scrubbedManifest = scrubText(manifestBefore);
  const manifest = parseScrubbedManifest(scrubbedManifest.value, runDir);
  removals += scrubbedManifest.removals;

  // events.jsonl, line by line, so a truncated final line stays tolerable.
  const eventsPath = join(runDir, 'events.jsonl');
  const original = await readFile(eventsPath, 'utf8');
  const scrubbedLines: string[] = [];
  let lineNumber = 0;
  for (const line of original.split('\n')) {
    lineNumber += 1;
    if (line.trim() === '') continue;
    const scrubbed = scrubText(line);
    if (scrubbed.value === line) {
      scrubbedLines.push(line);
      continue;
    }
    // Never write a line that would no longer parse or validate: a scrub that corrupts the trace
    // is worse than one that leaves something behind, because it destroys the evidence too. But
    // putting the original back means the match is still on disk, so it is reported rather than
    // swallowed — and it is not counted, or `removed=N` would name removals that never happened.
    const reason = rejectionReason(scrubbed.value);
    if (reason !== undefined) {
      reverted += 1;
      const seq = seqOf(line);
      out.warn(
        'scrub_reverted',
        seq === undefined ? { line: lineNumber, reason } : { seq, reason },
      );
      scrubbedLines.push(line);
      continue;
    }
    removals += scrubbed.removals;
    scrubbedLines.push(scrubbed.value);
  }
  if (reverted > 0) {
    out.plain(`  ${reverted} event(s) were put back unchanged — what they matched is STILL here`);
    out.plain('  next: widen the match, or delete the run outright');
  }

  const nextEvents = `${scrubbedLines.join('\n')}\n`;
  const eventsRewritten = nextEvents !== original;
  if (eventsRewritten) {
    await writeFile(eventsPath, nextEvents, { mode: FILE_MODE });
    filesChanged += 1;
  }

  // Blobs hold most of the volume, so most of what needs removing lives there.
  const blobsRoot = join(runDir, 'blobs');
  for (const path of await walk(blobsRoot)) {
    const buf = await readFile(path);
    // Skip binary. A NUL byte, or a UTF-8 round trip that loses bytes, means rewriting this file
    // as text would corrupt it — and a secret is not going to be hiding in a PNG anyway.
    const text = asText(buf);
    if (text === undefined) continue;
    const scrubbed = scrubText(text);
    if (scrubbed.value !== text) {
      await writeFile(path, scrubbed.value, { mode: FILE_MODE });
      removals += scrubbed.removals;
      filesChanged += 1;
    }
  }

  const fs = await handleShadowStore(runDir, args.bool('drop-fs'), (text) => {
    return scrubText(text).value !== text;
  });

  if (eventsRewritten) {
    // Refresh the digest so `verifyIntegrity` still passes over the scrubbed file. Only when the
    // file was actually rewritten: recomputing it unconditionally would quietly repair a digest
    // that never matched, which is exactly the tampering the digest exists to expose.
    const integrity = manifest.integrity;
    if (isRecord(integrity)) {
      manifest.integrity = {
        ...integrity,
        events_sha256: createHash('sha256')
          .update(await readFile(eventsPath))
          .digest('hex'),
      };
    }
  }
  const manifestAfter = `${JSON.stringify(manifest, null, 2)}\n`;
  if (manifestAfter !== manifestBefore) {
    assertManifestSurvived(manifest, runDir);
    await writeFile(manifestPath, manifestAfter, { mode: FILE_MODE });
    filesChanged += 1;
  }

  if (removals > 0) {
    const redactionsPath = join(runDir, 'redactions.json');
    const existing = await readFile(redactionsPath, 'utf8').catch(() => '{"records":[]}');
    const doc = JSON.parse(existing) as { policy_version?: number; records?: unknown[] };
    doc.records = [
      ...(doc.records ?? []),
      // By rule and count, never by value — the whole point is that the value is gone.
      { rule: 'scrub', identifier: `manual:${literals.length} literal(s)`, count: removals },
    ];
    await writeFile(redactionsPath, `${JSON.stringify(doc, null, 2)}\n`, { mode: FILE_MODE });
  }

  out.phase('scrubbed', { run: runDir, removed: removals, files: filesChanged });
  if (removals === 0 && reverted === 0 && fs.matches === 0 && fs.unreadable === undefined) {
    out.plain('  nothing matched — the trace is unchanged');
  }
  reportShadowStore(out, runDir, fs);

  return {
    runDir,
    filesChanged,
    removals,
    reverted,
    fsStoreMatches: fs.matches,
    fsStoreDropped: fs.dropped,
  };
}

/**
 * `--match` with no value parses to boolean `true` and reads back as an empty list, so without
 * this the command would report "nothing matched" over a trace it never searched. A false
 * all-clear is the one failure mode a scrubber must not have, so this is an error, not a default.
 */
function collectLiterals(args: ParsedArgs): string[] {
  const literals: string[] = [];
  for (const name of ['match', 'matches']) {
    if (!args.has(name)) continue;
    const values = args.list(name);
    if (values.length === 0) {
      // One newline only: `main` renders the first line as what happened and the rest as why, and
      // indents just the first line of the rest.
      throw new Error(
        `--${name} was given with nothing to match\n` +
          'Scrubbing would then report a clean trace it never searched, which is worse than not ' +
          `scrubbing at all — try: orca scrub last --${name} my-hostname`,
      );
    }
    literals.push(...values);
  }
  return literals;
}

/** Why a scrubbed event line cannot be written, or undefined when it can. */
function rejectionReason(scrubbed: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scrubbed);
  } catch {
    return 'unparseable';
  }
  return validateEvent(parsed).valid ? undefined : 'schema';
}

/** The event's own seq, so a warning names the event rather than a byte offset. */
function seqOf(line: string): number | undefined {
  try {
    const seq = (JSON.parse(line) as { seq?: unknown }).seq;
    return typeof seq === 'number' ? seq : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScrubbedManifest(text: string, runDir: string): Record<string, unknown> {
  // A literal that spans a quote or a brace takes the JSON apart rather than editing a value, so
  // the parse is checked before the schema is: there would be nothing to validate.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `scrubbing manifest.json would leave it unparseable\n${manifestAdvice(runDir)}`,
    );
  }
  assertManifestSurvived(parsed, runDir);
  return parsed;
}

/**
 * A `--match` that lands on `run_`, on a timestamp or on the integrity digest removes a field the
 * schema pins, and every reader — `orca gc`, the viewer, the Python SDK — opens the manifest
 * first. Refusing loudly leaves a readable trace; writing it would leave an unopenable one.
 */
function assertManifestSurvived(manifest: Record<string, unknown>, runDir: string): void {
  const result = validateManifest(manifest);
  if (result.valid) return;
  throw new Error(
    `scrubbing manifest.json would leave it invalid: ${result.errors.join('; ')}\n` +
      manifestAdvice(runDir),
  );
}

/** The second half of both manifest errors: one line, because `main` indents only the first. */
function manifestAdvice(runDir: string): string {
  return (
    'Nothing was changed — the match covers a field the trace format requires, and a run whose ' +
    `manifest will not parse cannot be opened at all. Narrow the match, or: rm -rf ${runDir}`
  );
}

/** What the shadow filesystem store still holds, and what was done about it. */
interface ShadowStoreStatus {
  /** Objects still holding material the scrub would have removed. */
  matches: number;
  /** Set when the store could not be read, so `matches` proves nothing either way. */
  unreadable?: string;
  dropped: boolean;
}

/**
 * The shadow filesystem store (`<run>/fs`) holds the whole workspace at every turn, which is
 * usually the largest thing in a run.
 *
 * It cannot be scrubbed the way a blob can. Its objects are zlib-compressed and addressed by the
 * hash of their own contents, so editing one is not editing a file: the object's id changes, every
 * tree that names it has to be rewritten, and every `fs.snapshot` event that names those trees has
 * to be rewritten with them — a history rewrite whose failure mode is a run that no longer
 * restores. So the store is searched and reported instead, and `--drop-fs` removes it outright for
 * anyone who would rather lose the snapshots than keep the material.
 */
async function handleShadowStore(
  runDir: string,
  drop: boolean,
  hasMatch: (text: string) => boolean,
): Promise<ShadowStoreStatus> {
  const gitDir = join(runDir, 'fs');
  if (!(await stat(gitDir).catch(() => null))) {
    return { matches: 0, dropped: false };
  }
  if (drop) {
    await rm(gitDir, { recursive: true, force: true });
    return { matches: 0, dropped: true };
  }
  return { ...(await scanShadowStore(gitDir, hasMatch)), dropped: false };
}

async function scanShadowStore(
  gitDir: string,
  hasMatch: (text: string) => boolean,
): Promise<{ matches: number; unreadable?: string }> {
  // --batch-all-objects, because the store has no refs: `write-tree` leaves every object dangling,
  // so nothing here is reachable from a commit and `rev-list` would report an empty store.
  const listed = await runGit(
    ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    { gitDir },
  );
  if (listed.code !== 0) return { matches: 0, unreadable: gitFailure(listed.stderr, listed.code) };

  const wanted: { oid: string; size: number }[] = [];
  for (const line of listed.stdout.split('\n')) {
    const [oid, type, size] = line.trim().split(' ');
    if (oid === undefined || type === undefined) continue;
    // Trees are searched for their entry names: a hostname can be the filename, not the contents.
    if (type !== 'blob' && type !== 'tree') continue;
    wanted.push({ oid, size: Number(size) || 0 });
  }

  let matches = 0;
  for (const batch of chunkBySize(wanted, BATCH_BYTES)) {
    const read = await runGitRaw(['cat-file', '--batch'], {
      gitDir,
      input: `${batch.map((o) => o.oid).join('\n')}\n`,
    });
    if (read.code !== 0) return { matches, unreadable: gitFailure(read.stderr, read.code) };
    for (const object of batchObjects(read.stdout)) {
      const text = object.type === 'tree' ? treeNames(object.body) : asText(object.body);
      if (text !== undefined && hasMatch(text)) matches += 1;
    }
  }
  return { matches };
}

function reportShadowStore(out: Output, runDir: string, status: ShadowStoreStatus): void {
  if (status.dropped) {
    out.warn('fs_store_dropped', { path: join(runDir, 'fs') });
    out.plain('  the workspace snapshots are gone; this run can no longer restore or fork files');
    return;
  }
  if (status.unreadable !== undefined) {
    out.warn('fs_store_unverified', { path: join(runDir, 'fs'), reason: status.unreadable });
    out.plain('  the shadow filesystem store could not be read, so it was NOT checked');
    out.plain('  next: orca scrub --drop-fs to remove it, or delete the run');
    return;
  }
  if (status.matches === 0) return;
  out.warn('fs_store_not_scrubbed', { path: join(runDir, 'fs'), objects: status.matches });
  out.plain('  the workspace snapshots still contain what you asked to remove: git objects are');
  out.plain('  addressed by their own contents, so they cannot be rewritten in place');
  out.plain(`  next: orca scrub --drop-fs to delete the snapshots, or rm -rf ${runDir}`);
}

function gitFailure(stderr: string, code: number): string {
  return stderr.trim() || `git exited ${code}`;
}

/** Batches of object ids whose combined content stays under `limit`; never an empty batch. */
function chunkBySize<T extends { size: number }>(items: T[], limit: number): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const item of items) {
    if (batch.length > 0 && bytes + item.size > limit) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += item.size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** `git cat-file --batch` output: `<oid> <type> <size>\n<size bytes>\n`, repeated. */
function* batchObjects(buf: Buffer): Generator<{ type: string; body: Buffer }> {
  let at = 0;
  while (at < buf.length) {
    const eol = buf.indexOf(0x0a, at);
    if (eol === -1) return;
    const [, type, size] = buf.subarray(at, eol).toString('utf8').split(' ');
    const bytes = Number(size);
    if (type === undefined || !Number.isFinite(bytes)) return;
    const start = eol + 1;
    yield { type, body: buf.subarray(start, start + bytes) };
    at = start + bytes + 1;
  }
}

/** Entry names out of a tree object: `<mode> <name>\0<20 raw bytes>`, repeated. */
function treeNames(body: Buffer): string {
  const names: string[] = [];
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;
    // The name runs to a NUL, then 20 raw bytes of object id before the next entry's mode.
    const nul = body.indexOf(0, space + 1);
    if (nul === -1) break;
    names.push(body.subarray(space + 1, nul).toString('utf8'));
    at = nul + 1 + 20;
  }
  return names.join('\n');
}

/** The buffer as text, or undefined when it is binary and rewriting it would corrupt it. */
function asText(buf: Buffer): string | undefined {
  if (buf.includes(0)) return undefined;
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : undefined;
}

function placeholderFor(literal: string): string {
  const hash = createHash('sha256').update(literal).digest('hex').slice(0, 8);
  return `<redacted:scrub:${hash}>`;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if ((await stat(path)).isFile()) out.push(path);
  }
  return out;
}
