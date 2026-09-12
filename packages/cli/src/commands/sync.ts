import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { ensureRunsDir, resolveRunSelector, runDirFor } from '@orcareplay/core';
import type { ParsedArgs } from '../args.js';
import type { Output } from '../out.js';
import {
  readConfig,
  gatewayHeaders,
  namedPushDestination,
  sameOrigin,
  type OrcaConfig,
  fetchPinned,
} from '../config.js';
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
 * The gateway a sync command talks to: flag, then environment, then a configured gateway THE USER
 * NAMED.
 *
 * The same precedence `resolveUpstream` uses for model traffic, and for the same reason — the more
 * specific and more recent the instruction, the more it wins. The last step is where the two part
 * company, and the comment that used to stand here ("there is deliberately NO default") described
 * an intention the code did not implement: it read `config.gateway?.url`, and `orca setup` writes
 * ORCAROUTER_URL into that field when nobody names anything. So `orca setup` followed by
 * `orca push last` sent the run — source, shell output, workspace snapshots — to a host the user
 * never typed, which is exactly what README's "Never a default destination" promises cannot
 * happen.
 *
 * `namedPushDestination` is that promise as one function, so both sync commands and anything added
 * later ask the same question instead of each re-deriving it.
 */
async function resolveGateway(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): Promise<{ url: string; headers: Record<string, string> }> {
  const config: OrcaConfig = await readConfig(env);
  const named = namedPushDestination(config);
  const url = args.str('gateway') ?? env.ORCA_GATEWAY_URL ?? named;
  if (!url) {
    // Two different situations, and telling them apart is the whole value of the message: nothing
    // configured at all, versus a gateway that IS configured but only as setup's own default for
    // model traffic. The second reads as a bug unless it says so.
    throw new Error(
      config.gateway?.url !== undefined
        ? `the configured gateway (${config.gateway.url}) is orca setup's default for MODEL ` +
            'traffic, not a destination you named for your runs, and a run carries source, shell ' +
            'output and workspace snapshots. Name it explicitly: pass --gateway <url>, set ' +
            'ORCA_GATEWAY_URL, or re-run `orca setup --gateway <url>`.'
        : 'no gateway configured. Run `orca setup --gateway <url>`, or pass --gateway, ' +
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
  //   env key    -> ORCA_GATEWAY_URL
  //
  // and a key is only sent when the destination matches its home.
  //
  // AN ENV KEY WITH NO HOME IS NOT HOMED AT THE CONFIGURED GATEWAY (orcacode-review). This read
  // `env.ORCA_GATEWAY_URL ?? configured`, which substituted a home the key had never been
  // associated with — and the README's CI recipe exports the KEY ALONE, so the substitution fired
  // on the common case rather than an exotic one. A key exported for host A then travelled to the
  // configured host B, in place of B's OWN stored key, because the stored branch is this branch's
  // `else`. That is the fail-open shape the whole gate exists to prevent, and it contradicted both
  // the README ("an exported key's [home] is ORCA_GATEWAY_URL") and the sentence two lines above
  // it: the exemption is for a key whose only destination is the one THIS INVOCATION named, and
  // here nothing in the invocation named it — the config did.
  //
  // So a homeless env key travels only when `--gateway` named the destination on this command
  // line. That is exactly the CI shape the env key exists for, and nothing else.
  const envKey = env.ORCA_GATEWAY_KEY?.trim();
  const configured = config.gateway?.url;
  const envHome = env.ORCA_GATEWAY_URL?.trim() || undefined;
  const invocationNamedTheHost = args.str('gateway') !== undefined;
  const envKeyApplies =
    envKey !== undefined &&
    envKey !== '' &&
    (envHome === undefined ? invocationNamedTheHost : sameOrigin(url, envHome));

  let headers: Record<string, string> = {};
  if (envKeyApplies) {
    // gatewayHeaders() returns {} rather than an empty bearer when it has no key — see its own
    // note — so an env key is folded in here rather than relying on that.
    headers = { authorization: `Bearer ${envKey}`, 'x-api-key': envKey };
  } else if (configured !== undefined && sameOrigin(url, configured)) {
    // Falling THROUGH rather than refusing: an env key that does not apply here is not a reason to
    // withhold the credential the user configured for this very host.
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

/**
 * The run directory's top-level entries that a push SHIPS. Everything else stays on the machine.
 *
 * AN ALLOWLIST, AND IT USED TO BE A DENYLIST OF ONE (`tls/`). That is the whole fix
 * (orcacode-review, `orca push` packing unredacted capture scaffolding): a denylist ships every
 * file nobody has thought about yet, and a run directory accumulates files that are not trace
 * content — `mcp-config.json` (MCP server `env` blocks, preserved verbatim by `rewriteMcpConfig`,
 * which is where an MCP server's API token lives), `shell-frames.jsonl` (raw argv of every command
 * the agent ran), `mcp-frames.jsonl` (raw JSON-RPC bodies), `shims/` (generated launchers holding
 * this machine's paths), `tls/` (the run's own interception CA private key). Each of those was
 * being POSTed to the gateway, stored there, and served to everyone who pulls the run.
 *
 * The reason a denylist cannot be made complete here is `orca scrub`. Scrub rewrites
 * `manifest.json`, `events.jsonl` and `blobs/` and nothing else, so a user who scrubs a secret and
 * then pushes was shipping an unscrubbed copy of it in the raw frame logs — the scrub reported
 * success and the secret went out anyway. `push` is the sharing path; shipping a file scrub cannot
 * reach defeats the command whose entire job is to make sharing safe.
 *
 * Why each entry is here:
 *
 *   manifest.json / events.jsonl / blobs  the trace, and what scrub covers.
 *   redactions.json                       the scrub ledger — by rule and COUNT, never by value —
 *                                         so the recipient can see the run was scrubbed.
 *   fs                                    the workspace snapshots. Scrub cannot rewrite them
 *                                         either (it warns `fs_store_not_scrubbed` and offers
 *                                         `--drop-fs`), but unlike the frame logs they are content
 *                                         the user recorded ON PURPOSE, and README says a run
 *                                         carries them.
 *
 * ONE THING IS DELIBERATELY LOST, and it is worth stating rather than discovering: `orca replay`
 * mocks MCP servers from `mcp-frames.jsonl`, so replaying a PULLED run no longer has those frames.
 * That is a degraded secondary feature against a credential disclosure, and the unblock is the
 * project rule this file already lives under — redaction belongs in the write path
 * (CONTRIBUTING.md). Once the MCP tee redacts as it writes, `mcp-frames.jsonl` joins this list.
 *
 * Nested copies are untouched: a `tls/` or `shims/` INSIDE a recorded workspace snapshot is
 * something the user recorded, and the filter applies at the top level only.
 */
const PUSHED_TOP_LEVEL = new Set(['manifest.json', 'events.jsonl', 'redactions.json', 'blobs']);

/**
 * The workspace snapshots, which ship only when the user asks for them with `--fs`.
 *
 * THIS WAS ON THE ALLOWLIST AND SHOULD NOT HAVE BEEN (orcacode-review). I kept `fs/` on the
 * grounds that it is "content the user recorded ON PURPOSE, and README says a run carries them",
 * and that does not distinguish it from anything else here: the user ran the shell commands on
 * purpose too, and `shell-frames.jsonl` came off this list all the same.
 *
 * What actually decides it is the rule the rest of the allowlist is built on — push must not ship
 * a file `orca scrub` cannot reach. The shadow git store is the largest such file by far. Scrub
 * says so itself: it cannot rewrite the store (the objects are zlib-deflated and addressed by the
 * hash of their contents, so editing one rewrites every id that reaches it), so it SEARCHES and
 * REPORTS instead and offers `--drop-fs`. SECURITY.md states the same in the same words: after a
 * scrub, "objects still hold the material".
 *
 * So the sequence was: scrub finds a secret in the workspace, tells the user it is still in the
 * store, the user pushes, and the whole workspace — including whatever the fixed pattern list
 * misses, which SECURITY.md names `id_ecdsa` as an example of — goes to a shared gateway and is
 * served to everyone who pulls it. The gateway's own scan does not see it either: the objects are
 * deflated, so a plaintext scan of the archive reads nothing.
 *
 * `--fs` keeps the capability for the case it exists for (a teammate who needs the tree to
 * reproduce), as a decision the pusher makes rather than a default they inherit, and push says out
 * loud what it is about to send. `orca scrub --drop-fs` remains the way to make the run safe
 * rather than merely quiet.
 */
const FS_SNAPSHOT_DIR = 'fs';

/** Every pushable file under a run directory, as archive entries named `<run_id>/<path>`. */
async function runEntries(
  runDir: string,
  runId: string,
  includeFs: boolean,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      // Top level only — see PUSHED_TOP_LEVEL.
      if (dir === runDir) {
        const allowed =
          PUSHED_TOP_LEVEL.has(item.name) || (includeFs && item.name === FS_SNAPSHOT_DIR);
        if (!allowed) continue;
      }
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
 * How often a held lock's mtime is refreshed. A third of the stale window, so two beats can be lost
 * — a suspended laptop, a stalled disk — before the lock looks abandoned.
 *
 * Exported so the heartbeat test names this value instead of re-deriving the arithmetic, which is
 * the sort of duplicate that keeps passing after the real one changes.
 */
export const LOCK_HEARTBEAT_MS = Math.max(1_000, Math.floor(STALE_LOCK_MS / 3));

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
  // CLAIM, THEN VERIFY — read-then-unlink was never a compare-and-swap (orcacode-review).
  //
  // The old body read the bytes at the path and unlinked THE PATH two awaits later, so a
  // stale-break landing in between made the comparison describe a lock that no longer existed and
  // the unlink destroy the one that had replaced it. The comment here called that "a narrowing
  // rather than a proof", which accurately described a hole and was not a reason to leave it: the
  // one line in this file that can delete another holder's lock is exactly that unlink.
  // DO NOT OPEN THE WINDOW WE ALREADY KNOW WE WILL LOSE (orcacode-review).
  //
  // The claim below is a rename: for the instant between it and `restoreLockFile` the path is FREE,
  // and a third pull waiting on it can create a lock there. Harmless when the lock really is ours —
  // it is ours precisely because nobody else is waiting on it — but the case that put this comment
  // here is the deterministic one: a pull whose lock was stale-broken mid-staging aborts, and its
  // `finally` then runs this on a lock it demonstrably does not own, EVERY time. The reader below
  // hands it straight back, but only after the path has stood empty, and the pull that now owns the
  // run sees its own `stillHeld()` fail.
  //
  // So ask first. A plain read is not a compare-and-swap and does not pretend to be one — the claim
  // still verifies — but a read that says "not ours" is never wrong in the direction that matters,
  // and skipping on it removes the window from the case that happens by schedule rather than by
  // interleaving. Fail-closed toward NOT TOUCHING: if the lock is unreadable we leave it, and the
  // stale-break reclaims it.
  if (!(await lockStillHeld(lock, token))) return;
  const aside = await claimLockFile(lock, 'releasing');
  if (aside === undefined) return;
  const holder = await readFile(aside, 'utf8').catch(() => undefined);
  if (holder === token) {
    await rm(aside, { force: true }).catch(() => undefined);
    return;
  }
  // Not ours — or unreadable, which is not evidence that it IS ours. Either way it belongs to
  // somebody else now, so it goes back rather than away.
  await restoreLockFile(aside, lock);
}

/**
 * Take exclusive possession of whatever file is at `lock`, or of nothing.
 *
 * `rename` moves an INODE: exactly one racer can take it and the rest get ENOENT, so afterwards the
 * caller holds something no other process can reach and can examine it without it changing
 * underneath. That is what makes the checks in releaseRunLock and breakStaleRunLock actual
 * compare-and-swaps, rather than two independent reads of a path that agree with each other about
 * nothing.
 */
async function claimLockFile(lock: string, why: string): Promise<string | undefined> {
  const aside = `${lock}.${why}.${process.pid}.${randomUUID()}`;
  try {
    await rename(lock, aside);
    return aside;
  } catch {
    // Someone else claimed it first, or it is already gone.
    return undefined;
  }
}

/**
 * Put a claimed lock file back, and destroy the claim ONLY once that has succeeded.
 *
 * `link` fails EEXIST rather than clobbering, so it cannot overwrite a lock another waiter took
 * while this one was held aside.
 *
 * WHEN IT CANNOT BE RETURNED, THE FILE STAYS (orcacode-review). The previous version removed the
 * aside unconditionally after a swallowed `link` failure — deleting the only copy of a live
 * holder's lock, which is the precise outcome the break exists to prevent, reached through its own
 * cleanup. A left-behind `.releasing.*` / `.breaking.*` file holds no lock and matches no
 * RUN_ID_PATTERN, so every command ignores it; that is strictly better than a live holder whose
 * lock has evaporated while it is mid-swap.
 */
export async function restoreLockFile(aside: string, lock: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await link(aside, lock);
      await rm(aside, { force: true }).catch(() => undefined);
      return true;
    } catch {
      // EEXIST: another waiter holds the path right now. Brief retries cover the case where it is
      // about to release; past that, leaving the file is the safe answer.
      await new Promise((ok) => setTimeout(ok, 20));
    }
  }
  return false;
}

/**
 * Break a lock judged stale, without ever removing a LIVE one.
 *
 * Two waiters can judge one abandoned lock stale. The first breaks it and acquires; the second must
 * not then delete the FRESH lock that replaced it. So the break claims the file atomically and
 * re-checks the age on the copy it now exclusively owns — winning the claim is not the same as the
 * file having been stale, because the path can be re-acquired between the verdict and the claim.
 *
 * A crash between the claim and the unlink leaves a `.breaking.*` file beside the run. It matches
 * no RUN_ID_PATTERN, so every command ignores it, and it holds no lock.
 *
 * Exported for the test that drives the interleaving directly: the window between the `stat` and
 * the break is inside `withRunLock`'s retry loop, and no caller can reach into it.
 */
export async function breakStaleRunLock(lock: string): Promise<void> {
  const aside = await claimLockFile(lock, 'breaking');
  if (aside === undefined) return;
  const age = await stat(aside)
    .then((st) => Date.now() - st.mtimeMs)
    .catch(() => undefined);
  if (age !== undefined && age > STALE_LOCK_MS) {
    await rm(aside, { force: true }).catch(() => undefined);
    return;
  }
  // NOT STALE ON THE COPY WE NOW HOLD — a live holder's lock that arrived between the verdict and
  // the claim, and it goes back untouched.
  //
  // An unreadable stat lands here too, which REVERSES what this used to do. It treated that as
  // stale "rather than restoring a lock we cannot describe" — the same fail-open reasoning the
  // whole function is against. Failing to read a file is not evidence that its holder is dead.
  await restoreLockFile(aside, lock);
}

/**
 * withRunLock, exported for the test that observes the heartbeat.
 *
 * The heartbeat is an interval armed inside the lock's own scope, so nothing a caller can reach
 * observes it; the test needs the real thing on a real file, because the failures worth catching
 * are "never armed", "armed on the wrong path" and "cleared too early".
 */
export function withRunLockForTest<T>(
  dest: string,
  fn: (stillHeld: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  return withRunLock(dest, fn);
}

async function withRunLock<T>(
  dest: string,
  // The callback is handed a `stillHeld` probe rather than the lock's path and token, so the swap
  // can re-check ownership without any caller being able to forge or release it.
  fn: (stillHeld: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
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
        await breakStaleRunLock(lock);
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
  // A LIVE HOLDER MUST NEVER LOOK STALE (orcacode-review).
  //
  // The lock was written once and never touched again, so its mtime is its CREATION time and
  // "stale" meant "older than ten minutes", not "dead". The work under this lock is the staging
  // write — one mkdir/writeFile/chmod per archive entry, up to writeArchive's own bound of 65 534
  // — so a large `fs/` snapshot on a slow or network-backed store genuinely takes longer than
  // STALE_LOCK_MS. Its lock was then broken WHILE IT WAS WRITING, and the second pull entered the
  // same critical section over the same deterministic scratch names: the two interleave, and the
  // run that lands is a blend of both copies or is missing half its workspace snapshot, with
  // nothing reporting it.
  //
  // The heartbeat makes staleness mean what the break assumes it means. A process killed outright
  // stops beating and its lock ages out exactly as before, so the break still works on the case it
  // was written for.
  //
  // AND IT MUST ONLY BEAT ON OUR OWN LOCK. The beat refreshed whatever file sat at the path, which
  // after a stale-break is somebody else's lock — and refreshing it is not a harmless write. It is
  // the one write that decides whether a lock can ever be broken: a pull whose lock was taken from
  // it goes on holding the new holder's lock open, so if THAT pull dies its lock never ages out and
  // the run is wedged until a human deletes the file. The concept the break rests on is defeated by
  // a process that no longer has any claim on it.
  //
  // Read-then-utimes is a narrowing, not a compare-and-swap; the same shape and the same reason as
  // releaseRunLock's own pre-check, and it removes the case that happens by schedule.
  //
  // unref'd, or the interval would hold the CLI open after the pull finishes.
  const beat = setInterval(() => {
    void (async () => {
      if (!(await lockStillHeld(lock, token))) return;
      const now = new Date();
      await utimes(lock, now, now).catch(() => undefined);
    })();
  }, LOCK_HEARTBEAT_MS);
  beat.unref?.();
  try {
    return await fn(() => lockStillHeld(lock, token));
  } finally {
    clearInterval(beat);
    await releaseRunLock(lock, token);
  }
}

/**
 * Whether `lock` still holds our token — checked immediately before the swap's destructive renames.
 *
 * Belt and braces behind the heartbeat, for the one case the heartbeat cannot cover: a process
 * stopped long enough (SIGSTOP, a suspended laptop) that its beats did not land, whose lock was
 * then legitimately broken and re-taken. Resuming into the two renames from there is what deletes
 * both copies of the run, so the swap asks once more rather than trusting a claim made minutes ago.
 */
async function lockStillHeld(lock: string, token: string): Promise<boolean> {
  return (await readFile(lock, 'utf8').catch(() => undefined)) === token;
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
 * Undo a staging attempt that threw, putting the original run back — but only while this pull still
 * owns the lock.
 *
 * Put the original back before reporting the failure: the caller is about to be told the pull did
 * not happen, and that has to be true of the store as well as of the message. If even this fails,
 * the deterministic scratch names mean the next pull recovers it rather than the copy being lost —
 * which is exactly why the revert may swallow its own error and the version before it may not have.
 *
 * THE REVERT IS LOCK-PROTECTED WORK LIKE THE STAGING IT UNDOES. Both scratch paths are deterministic
 * per destination, so once the lock has moved they name ANOTHER pull's in-flight state: the `rm`
 * below would delete the staging directory the new holder is writing into, and the rename would put
 * a run back over the one it had moved aside. That is the destructive resume the ownership re-check
 * before the swap exists to prevent, performed by the check's own abort path.
 *
 * Gated on ownership rather than on which error was thrown, because the error does not identify the
 * case: an ENOENT raised by the new holder's own recovery arrives here indistinguishable from a
 * corrupt archive. Fail-closed toward NOT TOUCHING: an unreadable lock leaves litter, which
 * `recoverInterruptedSwap` reclaims under the lock at the head of every pull, while the other
 * direction destroys a copy that is nobody's to destroy.
 */
export async function revertStagedSwap(
  stillHeld: () => Promise<boolean>,
  paths: { dest: string; staging: string; retired: string; existing: boolean },
): Promise<void> {
  const { dest, staging, retired, existing } = paths;
  if (!(await stillHeld())) return;
  if (existing) await rename(retired, dest).catch(() => undefined);
  await rm(staging, { recursive: true, force: true });
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

  const includeFs = args.bool('fs');
  const entries = await runEntries(ref.dir, runId, includeFs);
  const archive = await writeArchive(entries);
  out.phase('push.packed', {
    run: runId,
    files: entries.length,
    bytes: archive.length,
    // Said on the way out, beside the count, because it is the one part of the payload scrub
    // cannot have cleaned — see FS_SNAPSHOT_DIR.
    fs: includeFs ? 'included' : 'withheld',
  });
  if (includeFs) {
    out.warn('push.fs_included', {
      note:
        'workspace file contents travel raw: `orca scrub` cannot rewrite the snapshot store, ' +
        'so anything it reported as still present is going with this push',
    });
  }

  // `force` is the gateway's own flag for "store this even though the scan found something". It is
  // opt-in on purpose: the default refusal is what stops a secret reaching a shared server.
  const target = `${url}${UPLOAD_PATH}${args.bool('force') ? '?force=1' : ''}`;
  const { body, contentType } = multipart('file', `${runId}.orca.zip`, archive);
  const res = await fetchPinned(target, {
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

function lostTheLock(): Error {
  return new Error(
    'another orca pull took this run\u2019s lock while this one was staging; nothing was ' +
      'installed. Re-run the pull.',
  );
}

/**
 * Write an archive's entries into the staging directory, STOPPING THE MOMENT THE LOCK IS NOT OURS.
 *
 * THE FOURTH SITE OF "nothing that lost the lock may touch what the lock protects", and the half
 * the previous commit missed (orcacode-review). Gating the REVERT stopped an evicted pull from
 * DELETING the new holder's staging; it said nothing about the evicted pull's WRITES. The only
 * ownership probe sat after this whole loop, so a pull stopped long enough to be stale-broken
 * resumed and went on writing entries into `<dest>.incoming` — which, the scratch name being
 * deterministic, is by then the directory the NEW holder is staging into. The new holder renames
 * the blend into place and prints `pull.done`.
 *
 * Two archives of one run key differ in ordinary operation — a re-push, a scrub between fetches, or
 * the truncated export the `x-orca-run-truncated` header warns about — so the result is a run whose
 * manifest integrity root covers one copy while some of its blobs are the other's. That is verbatim
 * the outcome withRunLock's own comment says the lock exists to rule out: "the run that lands is a
 * blend of both copies … with nothing reporting it."
 *
 * Every 256 entries, so the syscall is noise next to the writes between them (one small read
 * against thousands of file writes) while the unowned window stays bounded by a fixed count rather
 * than by the archive's size. Probed BEFORE the first write too, so an already-evicted pull writes
 * nothing at all — including the mkdir of a directory that is no longer its own.
 *
 * Aborting leaves the partial staging as litter, which is correct: `recoverInterruptedSwap` runs
 * under the lock at the head of every pull and reclaims it. Exported for the test, because the
 * window is a SIGSTOP wide and a test that tries to hit it by timing is a coin flip.
 */
export async function stageRunEntries(
  entries: { name: string; bytes: Uint8Array }[],
  runId: string,
  staging: string,
  stillHeld: () => Promise<boolean>,
): Promise<void> {
  if (!(await stillHeld())) throw lostTheLock();
  await mkdir(staging, { recursive: true, mode: DIR_MODE });
  await chmod(staging, DIR_MODE).catch(() => undefined);
  for (const [index, entry] of entries.entries()) {
    if (index > 0 && (index & 0xff) === 0 && !(await stillHeld())) throw lostTheLock();
    const rel = entry.name.slice(entry.name.indexOf('/') + 1);
    if (rel === '' || entry.name.indexOf('/') < 0) continue;
    const path = join(staging, ...rel.split('/'));
    // A TRAILING SLASH NAMES A DIRECTORY (orcacode-review). `runEntries` walks files and skips
    // directories, so nothing this CLI writes produces such an entry — but pull is documented
    // to read archives from the gateway's Go writer and from whatever produced them before
    // that, and every general-purpose zip writer emits them (`zip -r`, shutil.make_archive, a
    // filepath.Walk that appends "/" for a dir).
    //
    // Written as a file, the empty payload lands AS the directory: the next entry under it
    // dies with ENOTDIR and the whole pull rolls back, or — when the archive has no file under
    // it — the pull SUCCEEDS and installs a run whose `blobs` is a zero-byte file. That last
    // one is the silent-wrong-store outcome the rest of this function exists to avoid.
    if (entry.name.endsWith('/')) {
      await mkdir(path, { recursive: true, mode: DIR_MODE });
      await chmod(path, DIR_MODE).catch(() => undefined);
      continue;
    }
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    await writeFile(path, entry.bytes, { mode: FILE_MODE });
    await chmod(path, FILE_MODE).catch(() => undefined);
  }
}

/**
 * Move the staged copy into place, undoing the move-aside on EVERY failure — a lost lock,
 * a rename the filesystem refused, anything.
 *
 * Returns whether the old run was moved aside. That is only a SUCCESS signal, telling the
 * caller whether a `retired` directory is left to remove; a throw has already restored the
 * old run here. It cannot be otherwise: a function that throws returns nothing, so the
 * caller's `movedAside` is still `false` and its revert would put nothing back.
 *
 * Exported for the test: the window is the gap between two renames, and this file already
 * learned that a test aiming at such a window by timing is a coin flip.
 */
export async function swapStagedRun(
  paths: { dest: string; staging: string; retired: string; existing: boolean },
  stillHeld: () => Promise<boolean>,
): Promise<boolean> {
  const { dest, staging, retired, existing } = paths;
  let movedAside = false;
  // PROBED ON BOTH SIDES OF THE MOVE-ASIDE, AND THE MOVE IS UNDONE (orcacode-review).
  //
  // One probe before the two renames was not enough, and the previous comment here —
  // "this one is what stops the DESTRUCTIVE half" — overstated it in exactly the case it
  // was written for. A pull stopped between the probe and `rename(dest, retired)` resumes
  // after its lock has been broken and a whole other pull has completed: the move-aside
  // then succeeds and carries away the run THAT pull just installed. The second rename
  // fails (the shared staging is gone), `revertStagedSwap` correctly refuses to put
  // anything back because the lock is not ours — and the result is a store where `<run>`
  // does not exist and the only copy sits at `<run>.replaced`, which matches no
  // RUN_ID_PATTERN and is therefore invisible to list, show, scrub, gc, export and push.
  // The "run that no command can reach again" this file's comments exist to rule out,
  // reached through the very guard added to prevent it.
  //
  // So: probe as late as possible before each destructive step, and UNDO the move-aside
  // when the second probe refuses. Still a narrowing rather than a proof — the same
  // standard the other three sites document — but the window shrinks from "the whole
  // swap" to "one rename", and the failure mode changes from a vanished run to litter
  // that `recoverInterruptedSwap` reclaims.
  //
  // THE ROLLBACK IS GATED ON HAVING DONE THE MOVE, not on `existing`. `<run>.replaced`
  // can also be another pull's move-aside, and renaming THAT over `dest` is the same
  // class of fault this whole sequence is about: only the process that moved a thing may
  // move it back.
  //
  // AND IT IS OWNED BY ONE `catch`, NOT BY THE PROBE (orcacode-review, second report on
  // this function). The probe's own restore covered the case it was written for — the
  // lock being broken between the renames — and nothing else. `rename(staging, dest)`
  // has a whole other family of failures: EACCES/EPERM/EIO on a store that just went
  // read-only or is being indexed, a Windows handle on the directory we have only this
  // moment finished writing, ENOTEMPTY if `dest` reappeared. On any of those the lock is
  // still perfectly ours, so `abortUnlessOurs` never runs, and `swapStagedRun` throws.
  //
  // The caller could not cover it either, and that is the part worth stating plainly:
  // `movedAside` is a local, so `movedAside = await swapStagedRun(...)` does not assign
  // on a throw. The caller's copy is still `false`, `revertStagedSwap` is told
  // `existing: false`, and it dutifully puts nothing back. On-disk result: `<run>` gone,
  // the user's only copy at `<run>.replaced` — invisible to list, show, events,
  // checkpoints, export, scrub, gc and push, because it matches no RUN_ID_PATTERN — and
  // the freshly staged replacement deleted. Exactly the vanished run this sequence's
  // comments exist to rule out, and exactly what `revertStagedSwap`'s own comment
  // promises cannot happen ("the caller is about to be told the pull did not happen, and
  // that has to be true of the store as well as of the message").
  //
  // A function cannot both return a value and throw, so the doc's promise — "returns
  // whether the old run was moved aside, so the caller's revert knows whether it is
  // entitled to move anything back" — is unkeepable on the failure path BY
  // CONSTRUCTION. So the failure path stops depending on the caller: every exit from
  // here that is not the completed swap restores the move-aside itself, and the return
  // value now only tells a SUCCESSFUL caller whether there is a `retired` directory left
  // to remove. One place undoes the move, and it covers every throw rather than the one
  // that was reported.
  const abortUnlessOurs = async (): Promise<void> => {
    if (await stillHeld()) return;
    throw lostTheLock();
  };

  await abortUnlessOurs();
  if (existing) {
    await rename(dest, retired);
    movedAside = true;
  }
  try {
    await abortUnlessOurs();
    await rename(staging, dest);
  } catch (err) {
    // Best-effort by necessity: if the rename failed because `dest` came back, this
    // fails too and `<run>.replaced` stays for `recoverInterruptedSwap` to reclaim.
    // Litter that a later `orca pull` puts right, not a run nothing can reach.
    if (movedAside) await rename(retired, dest).catch(() => undefined);
    throw err;
  }
  return movedAside;
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

  const res = await fetchPinned(`${url}${exportPath(runKey)}`, { headers });
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
  await withRunLock(dest, async (stillHeld) => {
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
    // Declared out here so the catch can read it: whether WE moved the old run
    // aside decides whether the revert may move anything back.
    let movedAside = false;

    try {
      await stageRunEntries(entries, runId, staging, stillHeld);

      movedAside = await swapStagedRun({ dest, staging, retired, existing: !!existing }, stillHeld);
    } catch (err) {
      await revertStagedSwap(stillHeld, { dest, staging, retired, existing: movedAside });
      throw err;
    }
    await rm(retired, { recursive: true, force: true });
  });

  out.phase('pull.done', { run: runId, files: entries.length, dir: dest });
}
