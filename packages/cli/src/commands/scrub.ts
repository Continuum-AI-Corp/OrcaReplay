import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { Redactor, resolveRunSelector } from '@orcareplay/core';
import { runGit, runGitRaw } from '@orcareplay/fs-capture';
import { validateEvent, validateManifest } from '@orcareplay/schema';
import type { ParsedArgs } from '../args.js';
import type { Output } from '../out.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const BLOB_PREFIX = 'sha256:';

/** What `BlobStore` treats as a blob. Anything else under `blobs/` is a partial write. */
const BLOB_NAME = /^[0-9a-f]{64}$/;

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
  /** True when `--dry-run` reported the plan and wrote nothing. */
  dryRun: boolean;
}

/** A file the scrub will replace, held back until every check on every file has passed. */
interface PendingWrite {
  path: string;
  contents: string;
  /** Where a moved blob is coming from, so the plan can say so rather than name a new file. */
  movedFrom?: string;
}

/** Where a scrubbed blob's content now lives, keyed by the digest it used to be filed under. */
interface MovedBlob {
  digest: string;
  bytes: number;
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
 * Nothing is written until every file has been scrubbed and checked, and each one then lands by
 * rename (see {@link commit}). `--dry-run` stops before that, and is the only way to find out what
 * the standard detectors will take out alongside your literal without having already lost it.
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
  // `orca gc` has had this since it shipped and scrub needed it more: gc removes runs you can
  // re-record, scrub removes material you cannot get back, and it fires the standard detectors as
  // well as your literal — so what it takes out is not fully knowable before it runs.
  const dryRun = args.bool('dry-run');

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

  const pending: PendingWrite[] = [];
  /** The redaction ledger, which is appended to rather than scrubbed — reported, never counted. */
  let ledger: string | undefined;

  /**
   * Blobs hold most of the volume, so most of what needs removing lives there — and they go before
   * events, because scrubbing a blob *moves* it.
   *
   * A blob's name is the sha256 of its contents (spec §2.2), which is not decoration: `put`
   * recognises content it already holds by that path existing and then does not write the file, and
   * that is what keeps a trace linear in new content rather than quadratic in turns. Rewriting a
   * blob under its old name left a store where the name no longer described the contents, so a
   * later `put` of the original material would conclude it was already stored and hand back a
   * reference to scrubbed content instead. `orca scrub` says this out loud already, about the
   * workspace snapshots it declines to rewrite: git objects are addressed by their own contents.
   * These are too.
   */
  const blobsRoot = join(runDir, 'blobs');
  const blobs = await walk(blobsRoot);
  const blobPaths = blobs.files;
  const moved = new Map<string, MovedBlob>();
  /** Old blob files, deleted only once every new one is in place. */
  const stale = new Set<string>();
  for (const path of blobPaths) {
    const buf = await readFile(path);
    // Skip binary. A NUL byte, or a UTF-8 round trip that loses bytes, means rewriting this file
    // as text would corrupt it — and a secret is not going to be hiding in a PNG anyway.
    const text = asText(buf);
    if (text === undefined) continue;
    const scrubbed = scrubText(text);
    if (scrubbed.value === text) continue;
    removals += scrubbed.removals;
    filesChanged += 1;
    // A file whose name is not a digest is a `put` that crashed between its write and its
    // rename. Nothing references it, and its name never claimed anything about its contents,
    // so it is rewritten where it lies -- moving it would mint a hex-named file no event
    // points at. It is still scrubbed: a scrubber that skips a file holding the material is
    // the one failure this command must not have.
    if (!BLOB_NAME.test(basename(path))) {
      pending.push({ path, contents: scrubbed.value });
      continue;
    }
    const digest = createHash('sha256').update(scrubbed.value, 'utf8').digest('hex');
    moved.set(basename(path), { digest, bytes: Buffer.byteLength(scrubbed.value, 'utf8') });
    pending.push({
      path: join(blobsRoot, digest.slice(0, 2), digest),
      contents: scrubbed.value,
      movedFrom: path,
    });
    stale.add(path);
  }
  // Never delete a path something is being written to. Two blobs can scrub to the same content, and
  // one blob can scrub to content another blob already holds; either way the file that survives is
  // the one being written, and the name it is written under may be some other blob's old name.
  for (const write of pending) stale.delete(write.path);

  // events.jsonl, line by line, so a truncated final line stays tolerable.
  const eventsPath = join(runDir, 'events.jsonl');
  const original = await readFile(eventsPath, 'utf8');
  const scrubbedLines: string[] = [];
  let lineNumber = 0;
  for (const line of original.split('\n')) {
    lineNumber += 1;
    if (line.trim() === '') continue;
    const scrubbed = scrubText(line);
    let kept = line;
    if (scrubbed.value !== line) {
      // Never write a line that would no longer parse or validate: a scrub that corrupts the trace
      // is worse than one that leaves something behind, because it destroys the evidence too. But
      // putting the original back means the match is still on disk, so it is reported rather than
      // swallowed — and it is not counted, or `removed=N` would name removals that never happened.
      const reason = rejectionReason(scrubbed.value);
      if (reason === undefined) {
        removals += scrubbed.removals;
        kept = scrubbed.value;
      } else {
        reverted += 1;
        const seq = seqOf(line);
        out.warn(
          'scrub_reverted',
          seq === undefined ? { line: lineNumber, reason } : { seq, reason },
        );
      }
    }
    // Applied to whichever text won, a reverted line included: the blob has moved either way, and
    // a reference left pointing at the old name is a reference to a file that is about to be gone.
    // It has no revert of its own because it cannot invalidate a line — a digest is replaced by a
    // digest of the same shape.
    scrubbedLines.push(moved.size === 0 ? kept : retargetLine(kept, moved));
  }
  if (reverted > 0) {
    out.plain(`  ${reverted} event(s) were put back unchanged — what they matched is STILL here`);
    out.plain('  next: widen the match, or delete the run outright');
  }

  const nextEvents = `${scrubbedLines.join('\n')}\n`;
  const eventsRewritten = nextEvents !== original;
  if (eventsRewritten) {
    pending.push({ path: eventsPath, contents: nextEvents });
    filesChanged += 1;
  }

  const matches = (text: string): boolean => scrubText(text).value !== text;
  const fs = await handleShadowStore(runDir, args.bool('drop-fs'), dryRun, matches);
  // The shadow store is reported as one number, so it keeps the single predicate. The run
  // directory is reported file by file, and there the distinction is the whole point: "the
  // hostname you named is still in this file" and "this file contains a base64 image" cannot
  // share a sentence, because only one of them is an answer to what was asked.
  const rest = await scanUnscrubbed(
    runDir,
    (text) => literals.some((literal) => text.includes(literal)),
    (text) => redactor.redactString(text, 'scrub').hits.length > 0,
  );

  const integrity = manifest.integrity;
  if (isRecord(integrity) && (eventsRewritten || moved.size > 0)) {
    // Refresh the digest so `verifyIntegrity` still passes over the scrubbed file. Only when the
    // file was actually rewritten: recomputing it unconditionally would quietly repair a digest
    // that never matched, which is exactly the tampering the digest exists to expose.
    //
    // Hashed from the bytes about to be written rather than re-read from disk, because under
    // `--dry-run` nothing is written — and a digest that depends on the write having happened is
    // a digest that silently means two different things.
    manifest.integrity = {
      ...integrity,
      ...(eventsRewritten
        ? { events_sha256: createHash('sha256').update(nextEvents, 'utf8').digest('hex') }
        : {}),
      // The store changes shape when a blob moves, and not only by renaming: two blobs whose one
      // difference was the material being removed scrub to the same content and become one file.
      // A count left describing the store as it was is the same false claim as a stale digest.
      ...(moved.size === 0 ? {} : { blob_count: blobCountAfter(blobPaths, stale, pending) }),
    };
  }
  const counts = manifest.counts;
  if (isRecord(counts) && moved.size > 0 && typeof counts['blobs'] === 'number') {
    // Written from the same number as `integrity.blob_count`, and read in its place by any viewer
    // opening a run sealed before that field existed. Leaving one refreshed and the other not
    // would make the same run report two different sizes depending on which reader opened it.
    manifest.counts = { ...counts, blobs: blobCountAfter(blobPaths, stale, pending) };
  }
  const manifestAfter = `${JSON.stringify(manifest, null, 2)}\n`;
  if (manifestAfter !== manifestBefore) {
    assertManifestSurvived(manifest, runDir);
    pending.push({ path: manifestPath, contents: manifestAfter });
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
    pending.push({ path: redactionsPath, contents: `${JSON.stringify(doc, null, 2)}\n` });
    ledger = redactionsPath;
  }

  if (dryRun) {
    out.phase('scrub.dry_run', { run: runDir, would_remove: removals, would_change: filesChanged });
    // The ledger is listed apart from the count. `files=N` has always meant files whose *contents*
    // were scrubbed, and `redactions.json` only gains a line saying how many removals happened —
    // folding it in would inflate the number, and listing it without saying so left a plan that
    // named three files under a heading that said two.
    for (const write of pending) {
      if (write.path === ledger) continue;
      out.plain(
        write.movedFrom === undefined
          ? `  would rewrite ${relative(runDir, write.path)}`
          : `  would rewrite ${relative(runDir, write.movedFrom)} and move it to ` +
              `${relative(runDir, write.path)}, which is what its scrubbed contents hash to`,
      );
    }
    if (ledger !== undefined)
      out.plain(`  would record the removals in ${relative(runDir, ledger)}`);
    if (fs.matches > 0) out.plain(`  ${fs.matches} shadow-store object(s) would still match`);
  } else {
    await commit(pending);
    // Last, and only once every new file is in place. Until then the old blobs are what the
    // references still reach, so a scrub interrupted before this leaves a run that is whole and
    // partly unscrubbed rather than one that is scrubbed and unreadable — and re-running the same
    // command finishes it, because the leftover file is found and scrubbed again to the digest it
    // already sits under.
    for (const path of stale) await rm(path, { force: true });
    out.phase('scrubbed', { run: runDir, removed: removals, files: filesChanged });
  }
  if (
    removals === 0 &&
    reverted === 0 &&
    fs.matches === 0 &&
    fs.unreadable === undefined &&
    rest.named.length === 0 &&
    rest.detected.length === 0 &&
    rest.unreadable.length === 0 &&
    blobs.unreadable.length === 0
  ) {
    out.plain('  nothing matched — the trace is unchanged');
  }
  reportShadowStore(out, runDir, fs);
  reportUnscrubbed(out, runDir, rest);
  if (blobs.unreadable.length > 0) {
    out.warn('blobs_not_searched', { path: blobsRoot, entries: blobs.unreadable.length });
    out.plain('  these blobs could NOT be read, so they were not searched or rewritten:');
    for (const entry of blobs.unreadable) out.plain(`    ${entry}`);
    out.plain('  next: close whatever holds them open, or run again with access to them');
  }

  return {
    runDir,
    filesChanged,
    removals,
    reverted,
    fsStoreMatches: fs.matches,
    fsStoreDropped: fs.dropped,
    dryRun,
  };
}

/**
 * Put every rewritten file in place, each one atomically.
 *
 * The old code wrote `events.jsonl` with a plain `writeFile`, which truncates first. A scrub
 * interrupted in that window — ^C, a full disk, an OOM kill — left the run with a truncated events
 * file and a manifest whose digest described the whole one. That is not a failed scrub, it is
 * destroyed evidence, and the material being scrubbed is by definition the material someone cannot
 * afford to lose along with it.
 *
 * Nothing is written until every check on every file has passed, and each file lands by rename, so
 * no reader ever sees a half-written one. A crash part-way through the loop leaves a run whose
 * files are individually intact and some of which are still unscrubbed — which re-running the same
 * command fixes, because the detectors are idempotent over already-scrubbed text.
 */
async function commit(pending: PendingWrite[]): Promise<void> {
  for (const write of pending) {
    // A moved blob's digest usually starts with two hex characters no other blob in this run does,
    // so its shard does not exist yet. Every other write here lands in a directory that does.
    await mkdir(dirname(write.path), { recursive: true, mode: DIR_MODE });
    const tmp = `${write.path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, write.contents, { mode: FILE_MODE });
      await rename(tmp, write.path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
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

/**
 * Point an event's payload at where its blob now lives.
 *
 * Walks the payload rather than substituting over the whole line, so a digest that appears inside
 * recorded text is left alone; and rewrites `bytes` along with the digest, because scrubbing
 * changes a body's length and a reference that reports the old one is the same kind of false claim
 * as the old digest was.
 */
function retargetLine(line: string, moved: Map<string, MovedBlob>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A truncated final line, which the text pass leaves alone for the same reason.
    return line;
  }
  if (!isRecord(parsed) || !retargetBlobs(parsed['payload'], moved)) return line;
  return JSON.stringify(parsed);
}

/**
 * Returns whether anything moved, so a line holding no moved reference is written back
 * byte-for-byte rather than re-serialised.
 *
 * Depth-bounded at the same six levels the viewer's own blob walk uses, so the two agree about
 * where a reference can be.
 */
function retargetBlobs(value: unknown, moved: Map<string, MovedBlob>, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    let hit = false;
    for (const item of value) hit = retargetBlobs(item, moved, depth + 1) || hit;
    return hit;
  }
  const record = value as Record<string, unknown>;
  const ref = record['$blob'];
  if (typeof ref === 'string') {
    const target = moved.get(ref.startsWith(BLOB_PREFIX) ? ref.slice(BLOB_PREFIX.length) : ref);
    if (target === undefined) return false;
    record['$blob'] = `${BLOB_PREFIX}${target.digest}`;
    record['bytes'] = target.bytes;
    return true;
  }
  let hit = false;
  for (const item of Object.values(record)) hit = retargetBlobs(item, moved, depth + 1) || hit;
  return hit;
}

/**
 * How many blobs the store will hold once the moves are committed.
 *
 * Counted the way `BlobStore.count()` counts, by digest-named files only, so the manifest
 * keeps reporting the same number the store itself would.
 */
function blobCountAfter(
  before: readonly string[],
  stale: ReadonlySet<string>,
  pending: readonly PendingWrite[],
): number {
  const after = new Set(before.filter((path) => !stale.has(path)));
  for (const write of pending) {
    if (write.movedFrom !== undefined) after.add(write.path);
  }
  return [...after].filter((path) => BLOB_NAME.test(basename(path))).length;
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

/**
 * What a run directory holds that scrub does not rewrite.
 *
 * The covered set is the trace as the spec defines it — `manifest.json`, `events.jsonl`,
 * `redactions.json`, `blobs/` and `fs/` — and a run directory holds more than that: the MCP
 * frames a replay answers from, the rewritten MCP config, the shim scripts, whatever a later
 * version adds. Scrub cannot rewrite most of it and must not rewrite some of it, but reporting
 * `nothing matched` over a file it never opened is the one thing SECURITY.md says a scrubber must
 * never do. So it is searched and named, like the shadow store.
 *
 * Defined from the spec rather than as a list of the sidecars that exist today, so a file added
 * later is reported by default instead of being silently uncovered until somebody remembers.
 */
const SCRUBBED_FILES = new Set(['manifest.json', 'events.jsonl', 'redactions.json']);
const SCRUBBED_DIRS = new Set(['blobs', 'fs']);

/** What a run directory holds that scrub did not rewrite, and what could not be looked at. */
interface UnscrubbedStatus {
  /** Paths, relative to the run directory, holding one of the literals the caller named. */
  named: string[];
  /** Paths holding something the standard detectors flag, but none of the caller's literals. */
  detected: string[];
  /** Paths that could not be read or listed at all, so nothing above says anything about them. */
  unreadable: string[];
}

/**
 * `mcp-frames.jsonl` is the reason this searches rather than rewrites.
 *
 * A replay answers the agent's MCP calls out of the recorded frames, keyed on the request. Rewrite
 * an inbound frame and the key changes, the exact-match lookup misses, and the mock falls through
 * to matching on method alone — so the replay is served *a different recorded response* with no
 * miss reported and no divergence event. A scrubber that silently corrupts a replay is worse than
 * one that admits it did not look.
 *
 * Three outcomes per file, not one. A file holding a literal the caller named is the thing they
 * asked about; a file the detectors flag is worth saying but is not an answer to their question —
 * a recorded screenshot trips the entropy sweep on every MCP run, and one sentence serving both
 * meanings would make the alarming case indistinguishable from the routine one. A file that could
 * not be opened is neither: it is the case where this function knows nothing, and saying nothing
 * there is how a scrubber reports a clean run it never searched.
 *
 * It does its own walking rather than calling {@link walk}, which answers `[]` for a directory it
 * cannot list. That is survivable where it is used for blobs — the blob pass fails loudly on the
 * read that follows — but here it would be the silence this function exists to remove.
 */
async function scanUnscrubbed(
  runDir: string,
  named: (text: string) => boolean,
  detected: (text: string) => boolean,
): Promise<UnscrubbedStatus> {
  const status: UnscrubbedStatus = { named: [], detected: [], unreadable: [] };
  const rel = (path: string) => path.slice(runDir.length + 1);

  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      status.unreadable.push(`${rel(dir)} (${String(err)})`);
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (
        dir === runDir &&
        (entry.isDirectory() ? SCRUBBED_DIRS : SCRUBBED_FILES).has(entry.name)
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        // Every reason this fails is a reason to say so: a file held open by another process, a
        // path this user cannot read, a file past the runtime's string limit. None of them is
        // evidence that the file is clean, and treating them as such is what made this report a
        // clean bill over a file nobody opened.
        status.unreadable.push(`${rel(path)} (${String(err)})`);
        continue;
      }
      // A binary reaches here too — `readFile(…, 'utf8')` does not fail on one, it replaces what it
      // cannot decode — and that is wanted: a credential written in ASCII inside a PNG is still a
      // credential, and the search finds it.
      if (named(text)) status.named.push(rel(path));
      else if (detected(text)) status.detected.push(rel(path));
    }
  };

  await visit(runDir);
  return status;
}

function reportUnscrubbed(out: Output, runDir: string, status: UnscrubbedStatus): void {
  if (status.named.length > 0) {
    out.warn('not_scrubbed', { path: runDir, files: status.named.length });
    out.plain('  these are in the run directory and still hold what you asked to remove; scrub');
    out.plain('  rewrites the trace, and a replay reads some of these back:');
    for (const file of status.named) out.plain(`    ${file}`);
    out.plain('  next: delete the run, or remove the file if nothing replays it');
  }
  if (status.detected.length > 0) {
    out.warn('not_scrubbed_detected', { path: runDir, files: status.detected.length });
    out.plain('  these hold something the detectors flag — a key shape, or a run of high-entropy');
    out.plain('  text, which a recorded image or token will trip on its own. Not what you asked');
    out.plain('  about, and scrub does not rewrite them:');
    for (const file of status.detected) out.plain(`    ${file}`);
  }
  if (status.unreadable.length > 0) {
    out.warn('not_searched', { path: runDir, files: status.unreadable.length });
    out.plain('  these could NOT be read, so nothing above says anything about them:');
    for (const file of status.unreadable) out.plain(`    ${file}`);
    out.plain('  next: close whatever holds them open, or run again with access to them');
  }
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
  dryRun: boolean,
  hasMatch: (text: string) => boolean,
): Promise<ShadowStoreStatus> {
  const gitDir = join(runDir, 'fs');
  if (!(await stat(gitDir).catch(() => null))) {
    return { matches: 0, dropped: false };
  }
  if (drop) {
    // `--dry-run --drop-fs` still scans, so the plan says how much would be lost. Deleting the
    // snapshots is the single most destructive thing this command does; a dry run that did it
    // anyway would be worse than having no dry run at all.
    if (dryRun) return { ...(await scanShadowStore(gitDir, hasMatch)), dropped: false };
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

/**
 * Every file under `dir`, and every reason one could not be found.
 *
 * Both halves were wrong, in opposite directions.
 *
 * A directory it could not list answered `[]`. Scrub's only caller is the blob pass, so a blob
 * directory this user cannot read made scrub scrub fewer blobs and *say a smaller number*, with no
 * warning and no error: on a run with one unreadable prefix directory,
 * `orca scrub --match … --dry-run` reported `would_remove=5 would_change=2` where it had reported
 * `would_remove=6 would_change=3` a moment earlier. Under-reporting is the failure SECURITY.md
 * names — "a scrubber that under-reports is disappointing; one that hands you a false all-clear is
 * worse than no scrubber" — and this one did it silently, which is the half that makes it a lie
 * rather than a limitation.
 *
 * An entry it could not `stat` threw instead. `readdir` reports a symlink with
 * `isDirectory() === false`, so a link whose target is gone reaches an unguarded `stat`, and the
 * rejection leaves `walk`, leaves the blob pass and ends the command — a scrub that was otherwise
 * fine, abandoned because one entry went stale. A file removed between the listing and the `stat`
 * does the same.
 *
 * So it reports both rather than swallowing one and throwing on the other, and the caller decides.
 */
async function walk(dir: string): Promise<{ files: string[]; unreadable: string[] }> {
  const files: string[] = [];
  const unreadable: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A directory that is not there held nothing, and nothing was missed by not reading it. A run
    // with no payload over the spill threshold has no `blobs/` at all, which is most small runs —
    // reporting those as unsearched put a warning on the ordinary case and took the all-clear with
    // it. Every other reason is a genuine "could not look".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { files, unreadable };
    return { files, unreadable: [`${dir} (${String(err)})`] };
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const under = await walk(path);
      files.push(...under.files);
      unreadable.push(...under.unreadable);
      continue;
    }
    try {
      if ((await stat(path)).isFile()) files.push(path);
    } catch (err) {
      unreadable.push(`${path} (${String(err)})`);
    }
  }
  return { files, unreadable };
}
