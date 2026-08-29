import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  TraceReader,
  deriveCheckpoints,
  resolveRunSelector,
  runsDir,
  snapToCheckpoint,
  TraceWriter,
} from '@orcareplay/core';
import { FsCapture } from '@orcareplay/fs-capture';
import { createProxy, defaultDialects, type RecordedExchange } from '@orcareplay/proxy';
import { defaultAdapters } from '@orcareplay/adapters';
import { serveViewer } from '@orcareplay/viewer';
import { isBlobRef, type TraceEvent } from '@orcareplay/schema';
import { ExchangeEventDeriver } from '../exchange-events.js';
import type { Output } from '../out.js';
import type { ParsedArgs } from '../args.js';
import { SerialQueue } from '../serial.js';
import { setupTlsCapture, trustRunCa } from '../tls-capture.js';
import { upstreamPlan } from '../upstream.js';
import { ORCA_VERSION } from '../version.js';

export interface ReplayResult {
  /** The run that was *read*: the recording being replayed or forked. */
  runId: string;
  mode: 'exact' | 'fork';
  matchedExact: number;
  divergences: number;
  liveCalls: number;
  exitCode: number;
  /**
   * The run this invocation *wrote*, whichever mode it ran in — a fork's continuation, or an exact
   * replay's record of its own findings. Absent only when `--no-trace` turned the latter off.
   *
   * `forkRunId` is kept as the fork-only name because callers use it to mean "there is a fork
   * here": `--ui` opens it in preference to the parent, and `compare` reads token usage out of it.
   * Neither is true of an exact replay's trace, which holds no exchanges at all.
   */
  traceRunId?: string;
  forkRunId?: string;
  /** Scratch worktree a fork ran in, so a verify command can be run against its result. */
  worktree?: string;
}

/**
 * Rebuild the recorded exchanges from a trace.
 *
 * The raw request and response bodies are the authoritative record — they are what makes exact
 * replay exact — so they come back verbatim from the blob store rather than being regenerated
 * from the canonical form.
 */
export async function loadExchanges(reader: TraceReader): Promise<RecordedExchange[]> {
  const events = await reader.events();
  const requests = events.filter((e) => e.type === 'model.request');
  const responses = events.filter((e) => e.type === 'model.response');

  const dialects = defaultDialects();
  const exchanges: RecordedExchange[] = [];
  for (const [i, req] of requests.entries()) {
    const res = responses[i];
    const rawRequest = await rawBodyOf(reader, req);
    const rawResponse = res ? await rawBodyOf(reader, res) : '{}';
    const dialectId = String(req.attrs?.dialect ?? 'anthropic');
    const dialect = dialects.find((d) => d.id === dialectId) ?? dialects[0]!;
    exchanges.push({
      seq: req.seq,
      dialect: dialectId,
      path: dialectId === 'anthropic' ? '/v1/messages' : '/v1/chat/completions',
      rawRequest,
      rawResponse,
      status: Number(res?.attrs?.status ?? 200),
      streamed: Boolean(res?.attrs?.streamed ?? false),
      // The stored body is the provider's wire format, not the canonical form. Canonicalizing it
      // with the same translator the proxy uses at replay time is what makes rung-1 matching
      // possible at all — parsing it directly makes every request look like a major divergence.
      canonicalRequest: dialect.toCanonicalRequest(JSON.parse(rawRequest)),
      durationMs: Number(res?.attrs?.duration_ms ?? 0),
    });
  }
  return exchanges;
}

/**
 * Read a recorded body back as the exact bytes that were sent.
 *
 * The subtlety is the spill boundary. The writer stores `JSON.stringify(payload)` in a blob once a
 * payload crosses `INLINE_PAYLOAD_LIMIT`, and every wire body is a *string* — so the same body is
 * kept as itself while it fits inline and as a quoted, backslash-escaped JSON string literal once
 * it spills. Reading the blob bytes straight back therefore returns an escaped copy: canonicalizing
 * it yields `model: ''` and `messages: []`, every request falls to rung 4, and replay against any
 * real harness matches nothing at all. Undoing the writer's encoding is what makes the two forms
 * identical again.
 *
 * Not `resolvePayload`, which would hand back a parsed object for a body that was recorded as one;
 * exact replay means the agent gets the same bytes, so anything that is not a JSON string is
 * returned verbatim.
 */
async function rawBodyOf(reader: TraceReader, event: TraceEvent): Promise<string> {
  const payload = event.payload;
  if (isBlobRef(payload)) {
    const text = new TextDecoder().decode(await reader.blob(payload));
    try {
      const decoded: unknown = JSON.parse(text);
      return typeof decoded === 'string' ? decoded : text;
    } catch {
      // Not JSON at all — a blob written by something else, or a future media type. The bytes are
      // still the best answer available.
      return text;
    }
  }
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload ?? {});
}

export async function replayCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<ReplayResult> {
  const selector = args.positionals[0] ?? 'last';
  const runDir = (await resolveRunSelector(cwd, selector)).dir;
  const reader = await TraceReader.open(runDir);
  const manifest = reader.manifest();
  const events = await reader.events();

  const integrity = await reader.verifyIntegrity();
  // Two different facts, and saying the wrong one costs trust in the right one. A recorder that was
  // killed leaves a run with no digest at all, and telling that person their trace "changed since
  // the run ended" is an accusation about a file nothing touched.
  if (integrity.state === 'mismatch') {
    out.warn('trace.integrity', {
      expected: integrity.expected,
      actual: integrity.actual,
      note: 'events.jsonl changed since the run ended',
    });
  } else if (integrity.state === 'unsealed') {
    out.warn('trace.unsealed', {
      actual: integrity.actual,
      note: 'the recorder never sealed this run, so there is nothing to verify it against',
    });
  }

  const exchanges = await loadExchanges(reader);
  const from = args.num('from');
  const model = args.str('model');
  const isFork = from !== undefined || model !== undefined;

  const result = isFork
    ? await replayFork(args, out, { manifest, events, exchanges, runDir, cwd, from, model })
    : await replayExact(args, out, { manifest, events, exchanges, runDir, cwd });

  if (args.bool('ui')) {
    // Show the run you just produced: after a fork that is the child, not the parent, because
    // the child is the one carrying the outcome you asked the question about.
    const target = result.forkRunId
      ? (await resolveRunSelector(cwd, result.forkRunId)).dir
      : runDir;
    await openViewer(target, args, out);
  }

  return result;
}

async function openViewer(runDir: string, args: ParsedArgs, out: Output): Promise<void> {
  const server = await serveViewer({ runDir, port: args.num('port') ?? 0 });
  out.phase('viewer', { url: server.url });
  out.plain('  ctrl-c to stop');
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => void server.close().then(resolve));
  });
}

interface Ctx {
  manifest: ReturnType<TraceReader['manifest']>;
  events: TraceEvent[];
  exchanges: RecordedExchange[];
  runDir: string;
  cwd: string;
}

/**
 * Exact replay. Every response comes from the trace and egress is blocked — if the agent reaches
 * for the network here, that is a bug we want to fail on, not paper over.
 *
 * It also restores the filesystem the run started from, and that is not a nicety. A harness reads
 * files into the conversation, so the bytes on disk end up inside the recorded request; the run
 * then edits those same files. Replaying in the directory you recorded in re-reads what the
 * recording itself changed, the trailing message differs, and the replay halts at rung 4 —
 * correctly, but uselessly, because nothing about the recording was wrong. Restoring first is
 * what makes "exact" mean anything, and it has the second virtue of leaving your checkout alone
 * rather than letting the agent edit it a second time.
 */
async function replayExact(args: ParsedArgs, out: Output, ctx: Ctx): Promise<ReplayResult> {
  const divergences: { level: string; detail: string; seq: number }[] = [];
  const unmatched: { seq: number; reason: string }[] = [];
  const workspace = await replayWorkspace(args, out, ctx);
  const trace = await openReplayTrace(args, ctx, workspace.dir);
  // Serial for the same reason the recorder's is: the callbacks fire from the proxy's request
  // handler, and two overlapping appends would interleave lines in events.jsonl.
  const writes = new SerialQueue();

  const plan = await upstreamPlan(args);

  const proxy = await createProxy({
    mode: 'replay',
    exchanges: ctx.exchanges,
    loose: args.bool('loose'),
    upstream: plan.upstream,
    upstreamHeaders: plan.headers,
    onDivergence: (d) => {
      divergences.push(d);
      if (!trace) return;
      writes.push(async () => {
        await trace.append({
          type: 'divergence',
          actor: 'orca',
          // Turn 0 for everything in this trace, and deliberately not a running count. An exact
          // match produces no callback, so a counter here would number the third divergence as
          // turn 1 and claim a position in the conversation that it does not have. `source_seq`
          // is the honest coordinate: it points straight at the parent's own event.
          turn: 0,
          attrs: { level: d.level, rung: d.rung, detail: d.detail, source_seq: d.seq },
        });
      });
    },
    // Printed as it happens rather than tallied at the end. A halted replay stops the agent, so
    // the count in `replay.done` arrives after the operator has already seen the run die — and a
    // bare `unmatched=1` with no reason is indistinguishable from a bug in orca itself.
    //
    // The two directories are on the line because a distance in the hundreds of thousands is true
    // and unactionable. Harnesses put absolute paths in their tool calls, so a replay running
    // anywhere but the recording's own directory gets a permission refusal where the recording has
    // file contents — by far the most common cause of a halt, and invisible from the number alone.
    onUnmatched: (u) => {
      unmatched.push(u);
      out.warn('replay.unmatched', {
        seq: u.seq,
        index: u.index,
        reason: u.reason,
        recorded_in: ctx.manifest.cwd,
        replayed_in: workspace.dir,
        next:
          workspace.dir === ctx.manifest.cwd
            ? 'orca replay <run> --loose'
            : `cd ${ctx.manifest.cwd} && orca replay <run> --in-place   # or --loose to continue live`,
      });
      if (!trace) return;
      // `error`, not `divergence`: nothing was served and the run is over, so calling it an
      // inexact match would put a rung on a ladder the request never climbed. It is also the one
      // finding here that exists nowhere else — a matched exchange is already in the parent, but
      // "the agent asked for something this recording cannot answer" is new, and until now it
      // lived only in the operator's scrollback.
      writes.push(async () => {
        await trace.append({
          type: 'error',
          actor: 'orca',
          turn: 0,
          attrs: {
            rule: 'replay_unmatched',
            rung: 4,
            reason: u.reason,
            index: u.index,
            source_seq: u.seq,
            recorded_in: ctx.manifest.cwd,
            replayed_in: workspace.dir,
          },
        });
      });
    },
  });

  await trace?.append({
    type: 'run.start',
    actor: 'orca',
    turn: 0,
    attrs: {
      adapter: ctx.manifest.adapter.id,
      cwd: workspace.dir,
      proxy: proxy.url,
      mode: 'replay',
      // Also on the manifest, which is what an out-of-process reader sees first. Here as well
      // because a trace read on its own should say what it is a replay of.
      parent_run: ctx.manifest.run_id,
      exchanges: ctx.exchanges.length,
    },
  });

  out.phase('replaying', {
    run: ctx.manifest.run_id,
    exchanges: ctx.exchanges.length,
    egress: 'blocked',
    proxy: proxy.url,
    cwd: workspace.dir,
  });

  const adapter = defaultAdapters().get(ctx.manifest.adapter.id);
  const launch = await adapter.prepare({
    runId: ctx.manifest.run_id,
    cwd: workspace.dir,
    proxyUrl: proxy.url,
    runDir: ctx.runDir,
    userArgs: ctx.manifest.argv.slice(1),
    env: process.env,
  });

  let exitCode: number;
  try {
    exitCode = await runChild(
      launch.command,
      launch.args,
      { ...process.env, ...launch.env },
      workspace.dir,
    );
  } finally {
    // In a finally because the whole justification for restoring over the working tree is that it
    // is put back — a throw between here and there would leave someone's checkout holding a
    // recorded run's files.
    await workspace.release();
  }

  await writes.drain();
  const stats = proxy.stats();
  await proxy.close();

  for (const d of divergences) {
    out.warn('divergence', { seq: d.seq, level: d.level, detail: d.detail });
  }

  // A halted replay is a failed replay even if the harness chose to exit 0 on the error. The exit
  // code is what a script reads, so it has to reflect what happened rather than what the agent
  // decided to do about it — and the trace records the same verdict for the same reason.
  const verdict = exitCode === 0 && unmatched.length > 0 ? 1 : exitCode;

  if (trace) {
    await trace.append({
      type: 'run.end',
      actor: 'orca',
      turn: 0,
      attrs: {
        exit_code: verdict,
        agent_exit_code: exitCode,
        matched: stats.matchedExact,
        divergences: stats.divergences,
        unmatched: stats.unmatched,
      },
    });
    await trace.close(verdict);
  }

  out.phase('replay.done', {
    matched: stats.matchedExact,
    total: ctx.exchanges.length,
    divergences: stats.divergences,
    unmatched: stats.unmatched,
    exit: exitCode,
    // Omitted entirely under --no-trace: `Output` drops undefined fields, so the line stays the
    // shape it has always been for anyone who opted out.
    trace: trace?.runId,
  });

  return {
    runId: ctx.manifest.run_id,
    mode: 'exact',
    ...(trace === undefined ? {} : { traceRunId: trace.runId }),
    matchedExact: stats.matchedExact,
    divergences: stats.divergences,
    liveCalls: stats.liveCalls,
    exitCode: verdict,
  };
}

/**
 * The run an exact replay writes about itself, or nothing under `--no-trace`.
 *
 * Spec §4 says every inexact match is an event in the trace, and until now the exact path had no
 * trace to put one in: divergences were printed and discarded with the scrollback. They cannot go
 * into the run being replayed — it is append-only and its manifest carries a digest over
 * events.jsonl, so a single line appended would invalidate every verification anyone had done of
 * it — so the replay becomes a run of its own, pointing back at its subject through `parent_run`.
 * That one field is what `orca list`, `orca show` and `orca gc` already read, which is why it is
 * on the manifest and not only in an event: gc uses it to refuse to delete a run something else
 * still points at.
 *
 * There is no `fork_point`. An exact replay does not branch anywhere, and a fabricated checkpoint
 * would be a number `orca list` prints as though someone had chosen it.
 *
 * What it deliberately does NOT record is the exchanges it served. Every one of them was read out
 * of the parent's own events.jsonl and handed back byte for byte, so copying them here would
 * duplicate the trace's single largest cost — the conversation bodies, blobs and all — to store a
 * second copy that is identical by construction, and would make `orca gc` report a store twice the
 * size for one recording's worth of content. An unmatched request is the opposite case: it is
 * something the agent asked that the recording never contained, so it exists nowhere else and is
 * written as an `error` event above. The rule is that this trace holds what replaying *discovered*,
 * and points at the parent for what replaying merely repeated.
 */
async function openReplayTrace(
  args: ParsedArgs,
  ctx: Ctx,
  cwd: string,
): Promise<TraceWriter | undefined> {
  if (!args.bool('trace', true)) return undefined;
  const dir = runsDir(ctx.cwd);
  await mkdir(dir, { recursive: true });
  return TraceWriter.create(dir, {
    adapter: ctx.manifest.adapter,
    argv: ctx.manifest.argv,
    // Where the replay actually ran, which is not always where the recording did: `--worktree`
    // puts it in a scratch copy, and `orca gc` reads exactly this to decide whether the directory
    // is one of ours to reclaim.
    cwd,
    orcaVersion: ORCA_VERSION,
    parentRun: ctx.manifest.run_id,
  });
}

/**
 * Fork replay. Replay deterministically to a checkpoint, materialize the filesystem as it was at
 * that moment, then let the agent continue live — optionally on a different model.
 */
async function replayFork(
  args: ParsedArgs,
  out: Output,
  ctx: Ctx & { cwd: string; from?: number; model?: string },
): Promise<ReplayResult> {
  const checkpoints = deriveCheckpoints(ctx.events);
  if (checkpoints.length === 0) {
    throw new Error(
      'this run has no checkpoints, so there is nothing to fork from\n' +
        '  checkpoints need a filesystem snapshot; was the run recorded with --no-fs?',
    );
  }

  const target = ctx.from ?? checkpoints[checkpoints.length - 1]!.seq;
  const { checkpoint, snapped } = snapToCheckpoint(checkpoints, target);
  if (snapped) {
    // Saying so matters: silently forking from different state than the user asked for is the
    // worst failure mode this tool has.
    out.warn('fork.snapped', {
      requested: target,
      using: checkpoint.seq,
      why: 'nearest preceding checkpoint',
    });
  }

  // Exchanges are indexed by position, so the fork point in exchange terms is how many model
  // requests happened at or before the checkpoint.
  const forkAt = ctx.exchanges.filter((e) => e.seq <= checkpoint.seq).length;

  const worktree = await mkdtemp(join(tmpdir(), `orca-${checkpoint.seq}-`));
  if (checkpoint.fsTree) {
    // Restore from the ORIGINAL run's shadow store: that is the only place the tree object
    // exists. Pointing a fresh store at the tree id fails to unpack it, which is exactly the
    // silent-wrong-state failure the checkpoint machinery is meant to prevent.
    const fs = await FsCapture.start({ runDir: ctx.runDir, cwd: ctx.cwd });
    await fs.restore(checkpoint.fsTree, worktree);
  }

  const dir = runsDir(ctx.cwd);
  await mkdir(dir, { recursive: true });
  const writer = await TraceWriter.create(dir, {
    adapter: ctx.manifest.adapter,
    argv: ctx.manifest.argv,
    cwd: worktree,
    orcaVersion: ORCA_VERSION,
    // Also in the manifest, not only the fork event: the manifest is what an out-of-process
    // reader sees first, and `orca gc` uses it to decide a parent run may not be deleted.
    parentRun: ctx.manifest.run_id,
    forkPoint: checkpoint.seq,
    ...(ctx.model === undefined ? {} : { forkModel: ctx.model }),
  });

  const deriver = new ExchangeEventDeriver();
  let turn = 0;
  const writes = new SerialQueue();

  const plan = await upstreamPlan(args);

  // A fork runs a real agent live, so it has exactly the same blind spot `orca record` does: a
  // harness that talks to its own backend over TLS reads no base-URL variable and is invisible
  // without interception. The flag was parsed here and silently discarded, which is the worse
  // half — the operator believes they captured that traffic.
  const tls = await setupTlsCapture({ args, out, writer, writes, turn: () => turn });

  const proxy = await createProxy({
    mode: 'hybrid',
    forkAt,
    forkModel: ctx.model,
    exchanges: ctx.exchanges,
    upstream: plan.upstream,
    upstreamHeaders: plan.headers,
    ...tls.proxyOptions,
    onExchange: (exchange) => {
      writes.push(async () => {
        turn += 1;
        for (const d of deriver.derive(exchange, turn)) {
          await writer.append({
            type: d.type,
            actor: d.actor,
            turn,
            attrs: d.attrs,
            payload: d.payload as never,
          });
        }
      });
    },
    onDivergence: (d) => {
      writes.push(async () => {
        await writer.append({
          type: 'divergence',
          actor: 'orca',
          turn,
          attrs: { level: d.level, rung: d.rung, detail: d.detail, source_seq: d.seq },
        });
      });
    },
  });

  await writer.append({
    type: 'fork',
    actor: 'orca',
    turn: 0,
    attrs: {
      parent_run: ctx.manifest.run_id,
      fork_point: checkpoint.seq,
      model: ctx.model ?? ctx.manifest.adapter.id,
      worktree,
    },
  });

  out.phase('forked', {
    from: ctx.manifest.run_id,
    at: checkpoint.seq,
    run: writer.runId,
    model: ctx.model ?? '(unchanged)',
    worktree,
  });

  const adapter = defaultAdapters().get(ctx.manifest.adapter.id);
  const launch = await adapter.prepare({
    runId: writer.runId,
    cwd: worktree,
    proxyUrl: proxy.url,
    runDir: writer.runDir,
    userArgs: ctx.manifest.argv.slice(1),
    env: process.env,
  });

  if (proxy.tls) {
    await trustRunCa(writer, proxy.tls, proxy.url, launch.env, out);
  }

  let exitCode: number;
  try {
    exitCode = await runChild(
      launch.command,
      launch.args,
      { ...process.env, ...launch.env },
      worktree,
    );
  } catch (err) {
    // The same two failures `orca record` had. A listening proxy keeps Node's event loop alive, so
    // a throw here printed the error and then hung; and a fork that mints a certificate authority
    // must not leave the private key on disk when it dies. The trace is sealed either way, because
    // a fork that failed to launch is still a fork someone will want to read.
    await proxy.close().catch(() => undefined);
    await writes.drain().catch(() => undefined);
    await tls.ca?.dispose().catch(() => undefined);
    await writer
      .append({ type: 'run.end', actor: 'orca', turn, attrs: { error: String(err) } })
      .catch(() => undefined);
    await writer.close().catch(() => undefined);
    throw err;
  }
  await writes.drain();

  const stats = proxy.stats();
  await writer.append({ type: 'run.end', actor: 'orca', turn, attrs: { exit_code: exitCode } });
  const manifest = await writer.close(exitCode);
  await proxy.close();
  await tls.ca?.dispose();

  out.phase('fork.done', {
    run: writer.runId,
    replayed: forkAt,
    live: stats.liveCalls,
    divergences: stats.divergences,
    events: manifest.counts?.events ?? writer.seq,
    exit: exitCode,
  });

  return {
    runId: ctx.manifest.run_id,
    traceRunId: writer.runId,
    forkRunId: writer.runId,
    worktree,
    mode: 'fork',
    matchedExact: stats.matchedExact,
    divergences: stats.divergences,
    liveCalls: stats.liveCalls,
    exitCode,
  };
}

/** Where an exact replay runs, and how to put the directory back afterwards. */
interface Workspace {
  dir: string;
  release: () => Promise<void>;
}

const noRelease = async (): Promise<void> => {};

/**
 * Prepare the filesystem an exact replay needs.
 *
 * Two facts decide this, and they pull against each other. A harness reads files into the
 * conversation, so the bytes on disk are inside the recorded request and replaying against a
 * directory the recording itself edited produces a different request. And a harness writes
 * *absolute* paths into its tool calls, so replaying a copy of that directory somewhere else makes
 * the agent read outside its working directory — where it gets a permission refusal in place of
 * the file, which diverges just as badly. Measured on a real Claude Code run: a scratch copy
 * halted at the first tool result; the same trace restored at its own path replayed all six
 * exchanges with nothing unmatched.
 *
 * So the default restores the recorded state *over the working tree*, at the path the run was
 * recorded in. That is only defensible because it is reversible: the current tree is snapshotted
 * into a scratch store first and put back in a `finally`, so a replay is observationally a no-op
 * on your checkout, and the snapshot id is printed before anything is touched in case the process
 * is killed in between.
 *
 * Three ways out. `--worktree` replays in a scratch copy and never touches your files, at the cost
 * of the divergence above. `--in-place` uses the tree exactly as it stands, restoring nothing.
 * And a replay invoked from somewhere other than the directory the run was recorded in never
 * restores, because writing a recorded tree over an unrelated directory is not a thing to do by
 * default.
 */
async function replayWorkspace(args: ParsedArgs, out: Output, ctx: Ctx): Promise<Workspace> {
  if (args.bool('in-place')) return { dir: ctx.cwd, release: noRelease };

  const initial = deriveCheckpoints(ctx.events).find((c) => c.fsTree !== undefined);
  if (!initial?.fsTree) {
    out.warn('replay.in-place', {
      why: 'this run has no filesystem snapshot to restore',
      note: 'recorded with --no-fs; a file the run read may since have changed',
    });
    return { dir: ctx.cwd, release: noRelease };
  }

  const recorded = await FsCapture.start({ runDir: ctx.runDir, cwd: ctx.cwd });

  if (args.bool('worktree')) {
    const worktree = await mkdtemp(join(tmpdir(), `orca-replay-${ctx.manifest.run_id}-`));
    await recorded.restore(initial.fsTree, worktree);
    return { dir: worktree, release: noRelease };
  }

  if (resolve(ctx.cwd) !== resolve(ctx.manifest.cwd)) {
    out.warn('replay.elsewhere', {
      recorded_in: ctx.manifest.cwd,
      running_in: ctx.cwd,
      note: 'not restoring over a directory the run was not recorded in; use --worktree for a copy',
    });
    return { dir: ctx.cwd, release: noRelease };
  }

  // A store of its own, under the OS temp dir: the safety snapshot is scratch, and writing it into
  // the trace's shadow store would leave an object in a recorded run that nothing references.
  const scratch = await mkdtemp(join(tmpdir(), 'orca-safety-'));
  const safety = await FsCapture.start({ runDir: scratch, cwd: ctx.cwd });
  const before = await safety.snapshotTurn(0);

  out.info('replay.restored', {
    to: initial.fsTree,
    your_tree: before.tree,
    note: 'your files are restored when the replay ends',
  });

  await recorded.restore(initial.fsTree, ctx.cwd);

  return {
    dir: ctx.cwd,
    release: async () => {
      await safety.restore(before.tree, ctx.cwd);
      // Only after the restore succeeded. This store holds the only copy of your working tree as
      // it was before the replay overwrote it, so removing it on the failure path would delete the
      // thing the failure means you still need — better a directory to clean up by hand than the
      // one that had your uncommitted work in it.
      //
      // Left behind on every run until now: a whole workspace per `orca replay`, in a directory
      // `orca gc` deliberately will not touch because it only reclaims scratch worktrees belonging
      // to forks. Owning its lifetime here is the fix; teaching gc to delete unknown temp
      // directories is how gc ends up removing someone's work.
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

function runChild(
  command: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env, cwd, stdio: 'inherit' });
    child.on('error', (err) =>
      reject(new Error(`could not launch "${command}": ${String(err)}\n  is it on your PATH?`)),
    );
    child.on('close', (code) => resolve(code ?? 0));
  });
}
