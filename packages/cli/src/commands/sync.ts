import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { ensureRunsDir, resolveRunSelector, runDirFor } from '@orcareplay/core';
import type { ParsedArgs } from '../args.js';
import type { Output } from '../out.js';
import { readConfig, gatewayHeaders, sameOrigin, type OrcaConfig } from '../config.js';
import { readArchive, writeArchive, type ArchiveEntry } from '../archive.js';

/**
 * Moving a run between this machine and an OrcaRouter gateway.
 *
 * The gateway records what a local `orca record` cannot see — every key, every colleague, every CI
 * job, and the routing decision behind each call — while the local recorder sees the shell, the
 * filesystem and MCP. Both write the same `orca-trace v0`, so the interesting direction is neither
 * one alone: pull a run a colleague's CI produced and `orca show` it, or push a local reproduction
 * to where the rest of the team can read it.
 *
 * THE REDACTOR IS UPSTREAM OF THIS SINK, BY CONSTRUCTION. CONTRIBUTING requires a new sink to go
 * through the redactor, and push is one — it is the first command that sends trace bytes to a host
 * over the network. It does not re-run redaction, and it must not: `TraceWriter` puts every event
 * through "spill, redact, validate, append" on its way to disk, precisely so no caller can bypass
 * it, so the bytes push reads are already redacted. Re-scrubbing them here would either be a no-op
 * or would rewrite bytes the manifest's integrity root already covers — which is the one thing
 * that makes an archive unpushable.
 *
 * What push adds instead is a second, independent line: the gateway scans the archive on arrival
 * and REFUSES it if it finds plaintext secrets, which is why `--force` exists and why it is opt-in.
 *
 * WHAT A PUSH ACTUALLY DISCLOSES. A run holds source, shell output and workspace snapshots (the
 * snapshots as content-addressed blobs, so they travel with it). SECURITY.md says to treat a
 * recording as sensitive, and sending one to a gateway is a disclosure to whoever can read that
 * workspace — so the destination is never defaulted, and `push.packed` reports the file count and
 * byte size before the request goes out rather than after.
 *
 * WHAT IS DELIBERATELY NOT HERE. Neither command converts, re-orders or re-serialises anything.
 * The gateway recomputes the integrity root over `events.jsonl` and refuses a push whose root does
 * not match its manifest, so the only correct thing to send is the bytes already on disk. Push
 * reads files and zips them; pull unzips and writes them. Any cleverness in between would be a bug
 * that reports success locally and is rejected — or worse, accepted with a root that no longer
 * describes the events.
 */

/**
 * The store's file modes, the same constants core/src/writer.ts and core/src/blobs.ts use.
 *
 * SECURITY.md states them as a promise — "Trace files and blobs are written mode 0600, run
 * directories 0700" — and a pulled run is exactly as sensitive as a recorded one: it is the
 * gateway's copy of the same source, shell output and workspace snapshots. Passing the mode to
 * mkdir/writeFile is not sufficient on its own, because the process umask masks bits out of a
 * creation mode; the explicit chmod after the fact is what actually makes the promise true.
 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** The endpoint paths this speaks, kept together because they are the whole API surface. */
const UPLOAD_PATH = '/api/replay/runs';
const exportPath = (runKey: string): string =>
  `/api/replay/runs/${encodeURIComponent(runKey)}/export`;

/**
 * The gateway a sync command talks to: flag, then environment, then the configured gateway.
 *
 * The same precedence `resolveUpstream` uses for model traffic, and for the same reason — the more
 * specific and more recent the instruction, the more it wins. There is deliberately NO default
 * here, unlike model traffic: pushing a recording of someone's source code to a host they did not
 * name is not a fallback, it is a disclosure.
 */
async function resolveGateway(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): Promise<{ url: string; headers: Record<string, string> }> {
  const config: OrcaConfig = await readConfig(env);
  const url = args.str('gateway') ?? env.ORCA_GATEWAY_URL ?? config.gateway?.url;
  if (!url) {
    throw new Error(
      'no gateway configured. Run `orca setup --gateway <url>`, or pass --gateway, ' +
        'or set ORCA_GATEWAY_URL.',
    );
  }

  // NO CREDENTIAL TRAVELS ANYWHERE BUT THE ORIGIN IT WAS SET UP FOR — from EITHER source.
  //
  // The first version of this gate applied the origin check to the stored key only, and I argued
  // on the thread that an env key alongside an override was "a deliberate pairing made in one
  // invocation". Review pointed at the README in this same PR, which tells you to
  // `read -rs ORCA_GATEWAY_KEY && export ORCA_GATEWAY_KEY` — and an export PERSISTS. So the
  // pairing was an assumption nothing enforced: a user who exported the key for their real gateway
  // and later runs `orca push --gateway <other-host>` (a typo, a stale alias, a URL someone sent
  // them) attaches that key and the whole recording to the other host — the exact request that is
  // REFUSED when the same key sits in config. An asymmetry that depends on where a credential is
  // stored rather than on where it is going is not a security boundary.
  //
  // Each key therefore has a HOME: the origin it was configured for.
  //
  //   stored key -> config.gateway.url
  //   env key    -> ORCA_GATEWAY_URL, or the configured gateway when that is unset
  //
  // and a key is only sent when the destination matches its home. An env key with NO home is the
  // one case left through: nothing but this invocation named a URL at all, so `--gateway` and the
  // key arrived together and there is no earlier association to contradict. That is the CI shape
  // the env key exists for.
  const envKey = env.ORCA_GATEWAY_KEY?.trim();
  const configured = config.gateway?.url;
  const envHome = env.ORCA_GATEWAY_URL ?? configured;

  let headers: Record<string, string> = {};
  if (envKey) {
    if (envHome === undefined || sameOrigin(url, envHome)) {
      // gatewayHeaders() returns {} rather than an empty bearer when it has no key — see its own
      // note — so an env key is folded in here rather than relying on that.
      headers = { authorization: `Bearer ${envKey}`, 'x-api-key': envKey };
    }
  } else if (configured !== undefined && sameOrigin(url, configured)) {
    headers = gatewayHeaders(config, env);
  }

  if (!headers.authorization) {
    // REFUSED, NOT ATTEMPTED ANONYMOUSLY. A push with no credential does not fail cleanly at the
    // gateway — an unauthenticated POST is exactly what a misconfigured public endpoint accepts —
    // and the user would learn their run went somewhere with no owner from a 200.
    throw new Error(
      'no API key for this gateway. A push needs a key carrying the `replay` scope: ' +
        'set ORCA_GATEWAY_KEY, or run `orca setup --gateway <url> --key-env <VAR>`.',
    );
  }
  return { url: url.replace(/\/+$/, ''), headers };
}

/**
 * The message a failed request should produce.
 *
 * The gateway answers `{success:false, message}` for everything it refuses, and that message is the
 * only part a person can act on — "archive contains 2 plaintext secrets" versus "request failed
 * with status 422". Falls back to the status when the body is not the shape we expect, because a
 * proxy in between may answer instead of the gateway.
 */
function refusal(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message !== '') return parsed.message;
  } catch {
    // Not JSON — fall through to the status line.
  }
  const trimmed = body.trim().slice(0, 200);
  return trimmed === '' ? `gateway answered ${status}` : `gateway answered ${status}: ${trimmed}`;
}

/** Every file under a run directory, as archive entries named `<run_id>/<path>`. */
async function runEntries(runDir: string, runId: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!item.isFile()) continue;
      // Zip names are '/'-separated whatever the host uses.
      const rel = relative(runDir, full).split(sep).join('/');
      entries.push({ name: `${runId}/${rel}`, bytes: new Uint8Array(await readFile(full)) });
    }
  };
  await walk(runDir);
  // Sorted so the same run produces the same archive twice — a push that differs byte for byte
  // between two invocations makes every digest comparison downstream meaningless.
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Build a multipart body by hand: the CLI takes no new runtime dependencies. */
function multipart(
  fieldName: string,
  fileName: string,
  bytes: Uint8Array,
): { body: Uint8Array; contentType: string } {
  const boundary = `----orca${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const head = new TextEncoder().encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
      'Content-Type: application/zip\r\n\r\n',
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Serialise everything that touches one run's directory.
 *
 * The deterministic scratch names that made a half-done swap RECOVERABLE also made it shared: two
 * pulls of the same run now aim at the same `.incoming` and `.replaced`. I argued when I introduced
 * them that this was a fair trade because "a race is recoverable, a disappearance is not" — and
 * review showed the race produces exactly the disappearance I claimed it could not. Interleave a
 * recovery's cleanup with another pull's two renames and both copies go: the recovery stats `dest`,
 * finds the old run, and removes what it believes is litter while the pull is mid-swap, so the
 * staged new copy and the retired old one are both deleted and the rollback finds nothing to
 * restore.
 *
 * Verifying siblings "immediately before" each removal does not fix it — that is the same
 * check-then-act one instruction later. Exclusion is the fix, and this is the smallest form of it:
 * an O_EXCL lock file beside the run, held across recovery, staging and the swap together.
 *
 * A lock file needs an answer for the process that dies holding one, or the first crash makes the
 * run permanently unpullable — which would be a worse failure than the one being fixed. So a lock
 * older than STALE_LOCK_MS is broken and taken. That is a heuristic, and it is sound here for a
 * reason worth stating: the work under the lock is bounded by the pull's own archive write, and a
 * pull still running after ten minutes has a bigger problem than a stolen lock.
 */
const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * Release a run lock — but ONLY the one this process is holding.
 *
 * The unconditional `rm` this replaces was unsafe because of the stale-break above, not in spite of
 * it. A pull that overruns STALE_LOCK_MS has its lock broken by a second pull, which then holds a
 * FRESH lock of its own; the first pull's `finally` removed the PATH rather than its own lock, so
 * it deleted the second pull's. A third pull then walks in beside the second, and the two of them
 * are exactly the concurrent recovery-and-swap this lock exists to prevent — where both copies of
 * the run can go.
 *
 * The token is a pid AND a uuid. A pid alone is not an identity across a ten-minute stale window on
 * a busy machine: pids wrap, and the process that inherits ours would be granted our lock.
 *
 * Read-then-unlink is not atomic, so this is a narrowing rather than a proof — which is the right
 * shape for an advisory lock whose worst case is already bounded by the stale-break. What it
 * removes is the case that happens deterministically rather than by interleaving.
 *
 * Exported for the test that pins the rule: the release runs inside a `finally`, and no caller can
 * interpose on that window through pullCommand.
 */
export async function releaseRunLock(lock: string, token: string): Promise<void> {
  let holder: string;
  try {
    holder = await readFile(lock, 'utf8');
  } catch {
    // Gone already (a stale-break, a tidy-up) — nothing to release. Any other error means we
    // cannot PROVE the lock is ours, and removing one we do not own is the failure being fixed, so
    // leave it: the stale-break reclaims it within STALE_LOCK_MS.
    return;
  }
  if (holder !== token) return;
  await rm(lock, { force: true }).catch(() => undefined);
}

async function withRunLock<T>(dest: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${dest}.lock`;
  // See releaseRunLock for why this is a token and not just a pid.
  const token = `${process.pid} ${randomUUID()}\n`;
  let held = false;
  for (let attempt = 0; attempt < 60 && !held; attempt++) {
    try {
      await writeFile(lock, token, { flag: 'wx', mode: FILE_MODE });
      held = true;
    } catch (err) {
      // ONLY EEXIST MEANS "someone else holds it". Anything else — a missing parent, a read-only
      // store, no space — is a real failure, and spinning on it burns the whole retry budget before
      // reporting an error that was never going to change. The first version caught everything and
      // took six seconds to fail on a workspace whose .orca/runs did not exist yet, which is the
      // ordinary first-pull case.
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      const stale = await stat(lock)
        .then((st) => Date.now() - st.mtimeMs)
        .catch(() => 0);
      if (stale > STALE_LOCK_MS) {
        // BREAK THE LOCK WE JUDGED STALE, not whatever is at that path now. Two waiters can both
        // read the same abandoned lock as stale; without this, the first breaks it and acquires,
        // and the second then deletes that fresh lock and acquires alongside it — the same
        // own-only rule as releaseRunLock, at the other end of the lock's life.
        const abandoned = await readFile(lock, 'utf8').catch(() => undefined);
        if (abandoned !== undefined) await releaseRunLock(lock, abandoned);
        continue;
      }
      await new Promise((ok) => setTimeout(ok, 100));
    }
  }
  if (!held) {
    throw new Error(
      `another orca pull is working on this run (${lock} is held). Wait for it to finish, or ` +
        `remove that file if no pull is running.`,
    );
  }
  try {
    return await fn();
  } finally {
    await releaseRunLock(lock, token);
  }
}

/**
 * Complete or roll back a swap that a previous pull did not finish. Call under withRunLock.
 *
 * The swap moves the old run aside and the new one into place — two renames with a gap. A process
 * killed inside that gap leaves `<run>` absent, the finished new copy at `<run>.incoming` and the
 * old one at `<run>.replaced`; neither sibling matches RUN_ID_PATTERN, so every command ignores
 * both and the run is simply gone.
 *
 * `.replaced` IS THE EVIDENCE THAT `.incoming` IS COMPLETE, and the first version of this function
 * missed that. It promoted `.incoming` whenever `dest` was absent, on the reasoning that "the
 * interrupted pull had already written every byte and was one rename from done". True of a REPLACE,
 * where staging is finished before `dest` is moved aside — so a replace crash always leaves BOTH
 * siblings. Not true of a first pull, which writes entries straight into `.incoming` and renames it
 * once at the end: a crash there leaves a PARTIAL `.incoming` and no `.replaced` at all. Promoting
 * that installed a truncated recording as the run, which `list`, `show`, `scrub` and `push` would
 * then treat as whole — and the next pull, the one that would have fetched the good copy, refused
 * with "already exists locally" and a flag the user has no reason to reach for.
 *
 * So the rule is not "newest wins", it is "only a copy something PROVES complete wins":
 *
 *   - `dest` missing, both siblings present — a replace crashed between the renames. `.incoming` is
 *     whole. Finish the swap.
 *   - `dest` missing, only `.replaced` — the move-aside happened, the new copy never landed. Put
 *     the old run back.
 *   - `dest` missing, only `.incoming` — a FIRST pull died mid-write. Partial, unprovable, and the
 *     archive is still on the gateway. Remove it and let this pull fetch again.
 *   - `dest` present — the swap completed; the siblings are litter.
 *
 * Best-effort throughout: a store we cannot tidy is not a reason to refuse a pull that would fix it
 * anyway.
 */
async function recoverInterruptedSwap(dest: string): Promise<void> {
  const staging = `${dest}.incoming`;
  const retired = `${dest}.replaced`;
  const present = async (p: string): Promise<boolean> => !!(await stat(p).catch(() => undefined));
  const drop = async (p: string): Promise<void> =>
    void (await rm(p, { recursive: true, force: true }).catch(() => undefined));

  const [hasDest, hasStaging, hasRetired] = await Promise.all([
    present(dest),
    present(staging),
    present(retired),
  ]);

  if (hasDest) {
    await drop(staging);
    await drop(retired);
    return;
  }
  if (hasStaging && hasRetired) {
    await rename(staging, dest).catch(() => undefined);
    if (await present(dest)) await drop(retired);
    return;
  }
  if (hasRetired) {
    await rename(retired, dest).catch(() => undefined);
    return;
  }
  if (hasStaging) {
    // Partial by construction — see the note above. The gateway still has the archive.
    await drop(staging);
  }
}

/**
 * push — send a local run to the gateway.
 *
 * `orca push [run] [--gateway URL] [--force]`
 */
export async function pushCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { url, headers } = await resolveGateway(args, env);
  const ref = await resolveRunSelector(cwd, args.positionals[0] ?? 'last');
  const manifest = JSON.parse(await readFile(join(ref.dir, 'manifest.json'), 'utf8')) as {
    run_id?: unknown;
  };
  const runId = typeof manifest.run_id === 'string' ? manifest.run_id : '';
  if (runId === '') throw new Error(`${ref.dir}/manifest.json has no run_id`);

  const entries = await runEntries(ref.dir, runId);
  const archive = await writeArchive(entries);
  out.phase('push.packed', { run: runId, files: entries.length, bytes: archive.length });

  // `force` is the gateway's own flag for "store this even though the scan found something". It is
  // opt-in on purpose: the default refusal is what stops a secret reaching a shared server.
  const target = `${url}${UPLOAD_PATH}${args.bool('force') ? '?force=1' : ''}`;
  const { body, contentType } = multipart('file', `${runId}.orca.zip`, archive);
  const res = await fetch(target, {
    method: 'POST',
    headers: { ...headers, 'content-type': contentType },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(refusal(res.status, text));

  let replaced = false;
  try {
    const parsed = JSON.parse(text) as { data?: { replaced?: unknown } };
    replaced = parsed.data?.replaced === true;
  } catch {
    // A 200 whose body we cannot read is still a successful push; the run key is what matters and
    // we already know it.
  }
  out.phase('push.done', { run: runId, replaced, gateway: url });
}

/**
 * pull — fetch a gateway run into the local store.
 *
 * `orca pull <run> [--gateway URL] [--force]`
 */
export async function pullCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { url, headers } = await resolveGateway(args, env);
  const runKey = args.positionals[0];
  if (!runKey) {
    throw new Error('pull needs the run to fetch: `orca pull <run-id>`');
  }

  // RECOVER BEFORE THE NETWORK, NOT AFTER IT.
  //
  // The archive names its own run, so the authoritative recovery is the one below, keyed on the id
  // that came back. But a store left half-swapped by a killed process must not stay that way just
  // because THIS pull fails — an unreachable gateway, a 404, an empty archive — and the run in that
  // state is invisible to every other command, so nothing else would ever reclaim it. When the
  // selector is itself a run id (the common case: you pull the run you just failed to pull), this
  // heals it first and costs one stat. runDirFor rejects anything that is not a run id, which is
  // the path-traversal guard, so a selector that is not one simply skips this.
  // The store has to exist before anything can take a lock file inside it, so this runs ahead of
  // the early recovery rather than beside the staging code it also protects.
  await ensureRunsDir(cwd);

  try {
    const early = runDirFor(cwd, runKey);
    await withRunLock(early, () => recoverInterruptedSwap(early));
  } catch {
    // Not a run id — the post-fetch recovery below is the one that matters anyway.
  }

  const res = await fetch(`${url}${exportPath(runKey)}`, { headers });
  if (!res.ok) throw new Error(refusal(res.status, await res.text()));

  // The gateway sets this when it could not store the recording whole. Pulling one is allowed —
  // half a trace still debugs — but every command downstream will read the result as if it were
  // complete, so the warning is not optional.
  if (res.headers.get('x-orca-run-truncated') === 'true') {
    out.warn('pull.truncated', {
      run: runKey,
      detail: 'the gateway stored this recording incompletely; events may be missing',
    });
  }

  const entries = await readArchive(new Uint8Array(await res.arrayBuffer()));
  if (entries.length === 0) throw new Error(`the gateway returned an empty archive for ${runKey}`);

  // The archive names its own run, and that name is what the local store keys on — not the
  // selector typed on the command line, which may be an abbreviation or the gateway's own key for
  // a run whose manifest calls it something else.
  const runId = entries[0]!.name.split('/')[0] ?? runKey;
  // runDirFor, not a join: its run-id pattern check IS the path-traversal guard (see its note in
  // packages/core/src/paths.ts), and the id here came off the wire. readArchive already refuses an
  // entry name that would escape, so this is the second of two independent checks on a value the
  // gateway chose — which is the right number for one that becomes a filesystem path.
  // (ensureRunsDir ran above, before the first lock.) THE STORE ON THE STORE'S OWN TERMS (codex round 3 P1).
  //
  // record, attach and replay all create `.orca/runs` through ensureRunsDir; pull wrote into it
  // with a bare recursive mkdir and inherited none of what that function is for. Two things were
  // lost, and both matter most in the case pull exists for — a fresh clone with no recording yet,
  // where pull is what creates the store:
  //
  //   - the 0700 directory and 0600 files SECURITY.md promises. A default umask gives 0755/0644,
  //     so a pulled trace — the gateway's copy of source, shell output and workspace snapshots —
  //     was world-readable on a shared machine.
  //   - `.orca/.gitignore` containing `*`, git's own idiom for a directory that excludes itself.
  //     Without it the whole store lands in `git status` as untracked, one `git add -A` from being
  //     committed and pushed. That is the accident ensureRunsDir was written to prevent.
  const dest = runDirFor(cwd, runId);

  // Finish or roll back whatever a previous, interrupted pull of this run left behind, BEFORE
  // deciding whether the run exists — otherwise a run stranded by a crash reads as absent and the
  // stranded copy is never reclaimed.
  // ONE LOCK OVER RECOVERY, STAGING AND THE SWAP.
  //
  // These three steps are one critical section: recovery decides what exists, staging writes the
  // new copy under a name another pull would also use, and the swap moves both. Locking only the
  // swap would leave recovery free to delete what staging just wrote.
  await withRunLock(dest, async () => {
    await recoverInterruptedSwap(dest);

    const existing = await stat(dest).catch(() => undefined);
    if (existing && !args.bool('force')) {
      throw new Error(
        `${runId} already exists locally. Pass --force to replace it, or move it aside first.`,
      );
    }

    // STAGE, THEN SWAP — AND MAKE THE SWAP RECOVERABLE, not merely exception-safe.
    //
    // Deleting the old run and writing the new one in its place means anything that fails in between
    // leaves the run neither the old one nor the new one. The recording is the artifact, and it may
    // be the only copy of a crash someone spent a day reproducing; `--force` asks to REPLACE it,
    // which is not a licence to destroy it and then fail.
    //
    // Staging alone does not finish the job, because POSIX will not rename a directory over a
    // non-empty one: the old run must be moved aside first, so there is a window of two syscalls in
    // which `dest` does not exist. try/catch covers a thrown error and NOTHING ELSE — SIGKILL, ^C
    // and power loss all land in that window, and the earlier version of this code claimed otherwise.
    // Worse, the names were randomised, and neither matches RUN_ID_PATTERN (`run_[0-9a-f]{6,32}`
    // admits no `.`), so `list`, `show`, `gc`, `scrub` and `resolveRunSelector` all skip them: the
    // run had not moved, it had VANISHED, with a possibly secret-bearing copy stranded out of
    // scrub's reach and nothing that would ever sweep it.
    //
    // So the scratch names are DETERMINISTIC per destination, which is what makes the half-done
    // state recoverable rather than merely invisible, and `recoverInterruptedSwap` below runs before
    // every pull to finish or roll back whatever the last one left. Determinism costs one thing —
    // two concurrent pulls of the same run share the scratch names — and buys back the case the
    // reviewer named: a run that no command can reach again. Those two pulls already raced over
    // `dest` itself; a race is recoverable, a disappearance is not.
    const staging = `${dest}.incoming`;
    const retired = `${dest}.replaced`;

    try {
      await mkdir(staging, { recursive: true, mode: DIR_MODE });
      await chmod(staging, DIR_MODE).catch(() => undefined);
      for (const entry of entries) {
        const rel = entry.name.slice(entry.name.indexOf('/') + 1);
        if (rel === '' || entry.name.indexOf('/') < 0) continue;
        const path = join(staging, ...rel.split('/'));
        await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
        await writeFile(path, entry.bytes, { mode: FILE_MODE });
        await chmod(path, FILE_MODE).catch(() => undefined);
      }

      // INSIDE the try: if another process recreated `dest` between the stat above and here, this
      // move is what fails, and leaving it outside stranded the staging directory while reporting
      // an error.
      if (existing) await rename(dest, retired);
      await rename(staging, dest);
    } catch (err) {
      // Put the original back before reporting the failure: the caller is about to be told the pull
      // did not happen, and that has to be true of the store as well as of the message. If even this
      // fails, the deterministic names above mean the next pull recovers it rather than the copy
      // being lost — which is exactly why the revert may swallow its own error here and the previous
      // version may not have.
      if (existing) await rename(retired, dest).catch(() => undefined);
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
    await rm(retired, { recursive: true, force: true });
  });

  out.phase('pull.done', { run: runId, files: entries.length, dir: dest });
}
