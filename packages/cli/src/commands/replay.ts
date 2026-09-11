import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  enclosingDelegation,
  TraceReader,
  deriveCheckpoints,
  resolveRunSelector,
  ensureRunsDir,
  snapToCheckpoint,
  TraceWriter,
} from '@orcareplay/core';
import { FsCapture } from '@orcareplay/fs-capture';
import {
  createProxy,
  defaultDialects,
  type RecordedExchange,
  type RecordedRetrieval,
  type RunCa,
} from '@orcareplay/proxy';
import { defaultAdapters, resolveLaunch } from '@orcareplay/adapters';
import { serveViewer } from '@orcareplay/viewer';
import { isBlobRef, type TraceEvent } from '@orcareplay/schema';
import type { HarnessArtifacts } from '@orcareplay/plugin-api';
import { ExchangeEventDeriver, appendDerivedEvents } from '../exchange-events.js';
import type { Output } from '../out.js';
import type { ParsedArgs } from '../args.js';
import { SerialQueue } from '../serial.js';
import { appendSnapshot } from '../fs-events.js';
import { drainMcpFrames, mcpForReplay, pointAtMcpConfig } from '../mcp.js';
import { planTlsCapture, recordedTlsHosts, setupTlsCapture, trustRunCa } from '../tls-capture.js';
import { upstreamPlan, type UpstreamPlan } from '../upstream.js';
import { ORCA_VERSION } from '../version.js';

export interface ReplayResult {
  /** The run that was *read*: the recording being replayed or forked. */
  runId: string;
  mode: 'exact' | 'fork';
  matchedExact: number;
  divergences: number;
  /**
   * Requests the recording could not serve.
   *
   * Printed in `replay.done` since the beginning and never returned, so every caller that was not
   * a terminal had to scrape it back out of the log line — while `exitCode` folds it into a single
   * bit. It is the number that says whether a replay actually reproduced the run.
   */
  unmatched: number;
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
      path: String(
        req.attrs?.path ??
          (dialectId === 'anthropic'
            ? '/v1/messages'
            : dialectId === 'codex'
              ? '/backend-api/codex/responses'
              : '/v1/chat/completions'),
      ),
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
 * Rebuild the recording's retrieval calls — embeddings, rerank — from its `net.*` pairs.
 *
 * They live there rather than in `model.request` because that is what they are: HTTP the proxy
 * saw and no dialect claimed. What sets them apart from the rest of that traffic is the two
 * attributes `RetrievalRule` put on them. `replay_key` is what a later run looks the answer up
 * by, and its presence is the whole test for "this pair can be served again" — a pair without one
 * is the opaque traffic `net.*` has always held, and is skipped here rather than guessed at.
 *
 * Pairing is by `causes`, not by position. A run interleaves retrieval with model calls and the
 * responses arrive out of order under a worker pool, so the nth response is not the answer to the
 * nth request; the writer already records which request each response answered.
 */
export async function loadRetrievals(reader: TraceReader): Promise<RecordedRetrieval[]> {
  const events = await reader.events();
  const responses = new Map<number, TraceEvent>();
  for (const event of events) {
    if (event.type !== 'net.response') continue;
    for (const cause of event.causes ?? []) responses.set(cause, event);
  }

  const out: RecordedRetrieval[] = [];
  for (const request of events) {
    if (request.type !== 'net.request') continue;
    const key = request.attrs?.['replay_key'];
    if (typeof key !== 'string' || key === '') continue;
    const response = responses.get(request.seq);
    const headers = response?.attrs?.['headers'];
    const contentType =
      headers !== null && typeof headers === 'object'
        ? ((headers as Record<string, unknown>)['content-type'] ?? 'application/json')
        : 'application/json';
    const stored = response?.attrs?.['stored'];
    const digest = response?.attrs?.['response_sha256'];
    const batchKey = request.attrs?.['batch_key'];
    out.push({
      seq: request.seq,
      rule: String(request.attrs?.['rule'] ?? 'unknown'),
      key,
      path: String(request.attrs?.['path'] ?? ''),
      status: Number(response?.attrs?.['status'] ?? 200),
      contentType: typeof contentType === 'string' ? contentType : 'application/json',
      // Needed only to reorder a batch, which cannot be done without knowing which text each
      // recorded vector answered. A recording made before that existed has none, and simply
      // cannot be reordered.
      rawRequest: await rawBodyOf(reader, request),
      // A digest-only recording kept no body. Empty here is what the proxy reads as "orca has
      // proof of this answer and not the answer", and it says so rather than serving nothing.
      rawResponse:
        stored === 'digest' || response === undefined ? '' : await rawBodyOf(reader, response),
      ...(typeof digest === 'string' ? { digest } : {}),
      ...(typeof batchKey === 'string' ? { batchKey } : {}),
    });
  }
  return out;
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

/**
 * The arguments that will make the agent ask again.
 *
 * A run recorded as `orca record claude -- -p "..."` carries its prompt in argv, and replaying it
 * is simply a matter of passing it back. A run driven by hand carries nothing: the prompt went
 * into a terminal, and argv is just `["claude"]`. Replaying that launched an agent with no reason
 * to call anything, so the recorded exchanges were never requested and the replay came back empty.
 *
 * The prompts recorded from the harness's own transcript are what closes that gap. Only the first
 * turn is driven — the harnesses take one prompt per non-interactive invocation — so a multi-turn
 * conversation says how much of itself it is reproducing instead of quietly reproducing one turn
 * and calling it a replay.
 */
function driveArgs(
  adapter: {
    driveArgs?(prompts: string[], recorded: string[]): string[] | undefined;
    replayArgs?(recorded: string[]): string[] | undefined;
    artifacts?: HarnessArtifacts;
  },
  ctx: { manifest: { argv: string[] }; prompts: string[] },
  out: Output,
  args?: ParsedArgs,
): string[] {
  const argv = chosenArgs(adapter, ctx, out);
  return args?.bool('serialize') ? serialized(adapter.artifacts, argv, out) : argv;
}

/**
 * Run the harness one request at a time, for an operator who asked for determinism explicitly.
 *
 * Never on by default, and the reason is the whole point of a replay: clamping concurrency
 * changes the run being reproduced. A pipeline with ten workers and one with one worker do the
 * same work in a different order, and a replay that quietly ran the second is not a replay of the
 * first. What it *is* good for is the second question someone asks of a flaky pipeline — "is this
 * a concurrency problem?" — which is worth one flag and worth being asked for.
 *
 * The adapter declares which flag its harness spells this with; orca does not guess. An adapter
 * that declares none says so rather than silently doing nothing.
 */
function serialized(
  artifacts: HarnessArtifacts | undefined,
  argv: string[],
  out: Output,
): string[] {
  const clamp = artifacts?.concurrencyFlag;
  if (clamp === undefined) {
    out.warn('replay.serialize_unsupported', {
      why: 'this adapter declares no concurrency flag, so orca has nothing to clamp',
      effect: 'the replay runs exactly as recorded',
    });
    return argv;
  }
  const at = argv.indexOf(clamp.flag);
  const next = [...argv];
  if (at === -1) next.push(clamp.flag, clamp.serialValue);
  else next[at + 1] = clamp.serialValue;
  out.info('replay.serialized', {
    flag: clamp.flag,
    value: clamp.serialValue,
    note: 'this replays a different run from the one recorded, on purpose',
  });
  return next;
}

/** The argv a replay would run with, before `--serialize` has a say. */
function chosenArgs(
  adapter: {
    driveArgs?(prompts: string[], recorded: string[]): string[] | undefined;
    replayArgs?(recorded: string[]): string[] | undefined;
  },
  ctx: { manifest: { argv: string[] }; prompts: string[] },
  out: Output,
): string[] {
  const recorded = ctx.manifest.argv.slice(1);
  const prompts = ctx.prompts;
  // Before the transcript is consulted, because a harness that keeps none never reached the hook
  // below at all: the early return for "no prompts" fired first, so an adapter for a pipeline —
  // whose argv is the entire instruction and whose prompts exist nowhere — had no way to say
  // anything about its own replay.
  const rewritten = adapter.replayArgs?.(recorded);
  if (rewritten !== undefined) return rewritten;
  if (prompts.length === 0) return recorded;

  // Whether argv already drives the run, decided by comparing it against the prompts the harness
  // recorded rather than by looking for a flag. `codex exec` with the prompt on stdin has a
  // non-empty argv that carries no prompt at all, so "argv is non-empty" answers the wrong
  // question; "argv contains what the person actually asked" answers the right one.
  if (prompts.some((prompt) => recorded.includes(prompt))) return recorded;

  const driven = adapter.driveArgs?.(prompts, recorded);
  if (driven === undefined) return recorded;

  // Said before the run, not after, because it reframes every divergence that follows. A harness
  // driven without a terminal does not send byte-identical requests to the ones it sent with one —
  // Claude Code splices an extra reminder turn into an interactive conversation, and the calls it
  // makes for itself, like naming the session, have no counterpart at all. Those show up as
  // unmatched, and without this line they read as a corrupt trace rather than as the cost of
  // reproducing a conversation nobody recorded the keystrokes of.
  out.info('replay.driven', {
    source: 'harness transcript',
    turns_recorded: prompts.length,
    turns_driven: 1,
    note:
      prompts.length > 1
        ? 'the harness takes one prompt per non-interactive run; later turns are not re-asked'
        : 'requests the harness made for itself may not recur',
  });
  return driven;
}

/**
 * Prompts off a `session.snapshot`.
 *
 * The transcript rides in the same payload, so this spills to a blob for any real session — which
 * is why it takes the reader rather than reading the event alone.
 */
async function readPrompts(reader: TraceReader, events: TraceEvent[]): Promise<string[]> {
  const event = events.find((e) => e.type === 'session.snapshot');
  if (event === undefined) return [];
  let payload: unknown = event.payload;
  try {
    if (isBlobRef(payload)) {
      payload = JSON.parse(new TextDecoder().decode(await reader.blob(payload)));
    }
    if (typeof payload === 'string') payload = JSON.parse(payload);
  } catch {
    return [];
  }
  if (payload === null || typeof payload !== 'object') return [];
  const prompts = (payload as { prompts?: unknown }).prompts;
  return Array.isArray(prompts) ? prompts.filter((p): p is string => typeof p === 'string') : [];
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
  const retrievals = await loadRetrievals(reader);
  const prompts = await readPrompts(reader, events);
  const from = args.num('from');
  const model = args.str('model');
  const isFork = from !== undefined || model !== undefined;

  const result = isFork
    ? await replayFork(args, out, {
        manifest,
        events,
        exchanges,
        retrievals,
        runDir,
        cwd,
        prompts,
        from,
        model,
      })
    : await replayExact(args, out, {
        manifest,
        events,
        exchanges,
        retrievals,
        runDir,
        cwd,
        prompts,
      });

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
  /** Embedding and rerank calls the recording can answer without a dialect. */
  retrievals: RecordedRetrieval[];
  runDir: string;
  cwd: string;
  /** The user's turns, recovered from the harness transcript. Empty when there was none. */
  prompts: string[];
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
  // Before `replayWorkspace`, because these refuse and `replayWorkspace` replaces the working
  // tree. Resolved after it, a refusal threw with the checkout holding the recorded run's files
  // and the operator's own tree left behind in an `orca-safety-*` scratch whose path nothing
  // prints — the outcome the release exists to prevent, escaping it because it only ran at the
  // child's launch. An invocation that cannot work should decide so before it touches anything,
  // which is the rule `attach` already follows where it resolves the advertised URL before making
  // a run directory.
  //
  // Two refusals, not one. `upstreamPlan` rejects an upstream that is not an origin;
  // `planTlsCapture` rejects a `--tls-hosts` list that names `*` or contradicts itself, and an
  // `ORCA_TLS_UPSTREAM_CA` that cannot be read. It is the refusing half of `setupTlsCapture` on
  // its own — it mints nothing, so the certificate authority is still created down where the run
  // is, after the workspace exists.
  const plan = await upstreamPlan(args);
  // A run recorded through interception is reproduced through it, without the operator having to
  // remember which hosts they named. See `setupTlsCapture`.
  const interceptedHosts = recordedTlsHosts(ctx.events);
  await planTlsCapture(args, interceptedHosts);

  // Armed on the line after the call, which is only sound because `replayWorkspace` owns its own
  // destructive step: it either returns with the tree replaced and a `release` that undoes that,
  // or it throws having already put the tree back. Arming here without that guarantee would have
  // read as covering the restore while missing it entirely — the restore is inside the call, so a
  // `materialize` that failed part-way rejected before `workspace` was ever assigned.
  const workspace = await replayWorkspace(args, out, ctx);
  try {
    return await replayRestored(args, out, ctx, { plan, interceptedHosts, workspace });
  } finally {
    // The outermost of three, and the one that needs no list to be right. Hoisting a refusal is
    // only ever as complete as the list of refusals somebody thought of, and that list has been
    // wrong twice; `replayRestored` has its own `finally` for the span it owns; this covers what
    // is left, which is `openReplayTrace` throwing before that span begins. `release` is
    // idempotent, so the ordinary path still puts the tree back where it always did — before the
    // run reports itself done — and this is a no-op behind it.
    await workspace.release();
  }
}

/**
 * The replay itself, once the filesystem it needs is in place.
 *
 * Split from `replayExact` for one reason: everything in here happens with the recording's files
 * over the operator's checkout, so it has to run inside something that puts them back.
 */
async function replayRestored(
  args: ParsedArgs,
  out: Output,
  ctx: Ctx,
  prepared: {
    plan: UpstreamPlan;
    interceptedHosts: readonly string[] | undefined;
    workspace: Workspace;
  },
): Promise<ReplayResult> {
  const { plan, interceptedHosts, workspace } = prepared;
  const divergences: { level: string; detail: string; seq: number }[] = [];
  const unmatched: { seq: number; reason: string }[] = [];
  const trace = await openReplayTrace(args, ctx, workspace.dir);
  // Serial for the same reason the recorder's is: the callbacks fire from the proxy's request
  // handler, and two overlapping appends would interleave lines in events.jsonl.
  const writes = new SerialQueue();

  /**
   * The two things a failed replay would otherwise leave running or on disk.
   *
   * Filled as each is built, because what needs cleaning up depends on how far the run got:
   * `createProxy` throwing has a key to remove and no socket, and everything after it has both.
   */
  let mintedCa: RunCa | undefined;
  let openProxy: { close: () => Promise<void> } | undefined;

  /**
   * Give up on a replay that has already built something, then re-throw. `orca record`'s
   * `abandon` is the same function for the same two reasons.
   *
   * A listening proxy keeps Node's event loop alive, so a throw printed the error and then hung
   * forever — `orca replay` was the one command of the three that had to be killed. And an
   * unsealed trace has no `ended_at` or `integrity`, so `verifyIntegrity` reports the run as
   * *tampered* rather than as unfinished.
   *
   * Sealing rather than discarding, for the reason the fork gives: a run that failed to launch is
   * still a run someone will want to read. The CA is not disposed here because the `finally`
   * below does it on both paths.
   */
  async function abandon(err: unknown): Promise<never> {
    await openProxy?.close().catch(() => undefined);
    await writes.drain().catch(() => undefined);
    if (trace) {
      await trace
        .append({ type: 'run.end', actor: 'orca', turn: 0, attrs: { error: String(err) } })
        .catch(() => undefined);
      await trace.close().catch(() => undefined);
    }
    throw err;
  }

  /*
   * Everything from here to the child's exit mints a key and then opens a socket, so everything
   * from here to the child's exit has to come back through `abandon` — the rule `orca record`
   * states in the same words, having learned it the same way.
   *
   * The guard used to start at the spawn, which covered the failure it was written for and missed
   * the four that happen first. `RunCa.create` writes `tls/ca.key`; `createProxy` binds; then
   * `mcpForReplay` rewrites a config and `adapter.prepare` runs a harness's own validation, which
   * is where `orca replay` on a trace naming an adapter this build does not have ended up — the
   * right error message, printed, and then a process that never exited with a private key left
   * behind in the run directory.
   */
  try {
    // A subscription-backed harness does not use the ordinary base URL, so exact replay needs the
    // same per-run CA and HTTPS proxy as recording. The proxy's TLS hook then answers Codex's
    // model request from the trace before it can open an origin connection.
    // The hosts were resolved before the workspace was restored, where anything refusable about
    // them was refused; this is the half that mints.
    const tls = await setupTlsCapture({
      args,
      out,
      ...(interceptedHosts ? { recordedHosts: interceptedHosts } : {}),
      writer: trace,
      runDir: ctx.runDir,
      writes,
      turn: () => 0,
    });
    // Handed to `abandon` the moment it exists, not once the run is under way: `createProxy` on
    // the next line is one of the throws this key has to survive being disposed by.
    mintedCa = tls.ca;

    const proxy = await createProxy({
      mode: 'replay',
      exchanges: ctx.exchanges,
      retrievals: ctx.retrievals,
      loose: args.bool('loose'),
      upstream: plan.upstream,
      upstreamHeaders: plan.headers,
      upstreamHeadersOrigin: plan.headersOrigin,
      ...tls.proxyOptions,
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
        // A halt inside a delegation is not a corrupt trace and not a bug, and looks like both. The
        // harness writes the delegate's prompt itself, fresh on every run, so the request really is
        // a different question — which is exactly what the matcher refuses to serve from a
        // recording. Without this the operator sees `distance 54` and goes looking for the fault.
        const delegation = enclosingDelegation(ctx.events, u.seq);
        out.warn('replay.unmatched', {
          seq: u.seq,
          index: u.index,
          reason: u.reason,
          ...(delegation === undefined
            ? {}
            : {
                inside: `${delegation.subagent} delegated at seq ${delegation.seq}`,
                why: 'the harness writes a delegate prompt of its own each run, so this request is a different question rather than a drifted one',
              }),
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
    // Listening from here on, so from here on a throw that does not close it is a process that
    // does not exit.
    openProxy = proxy;

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
      // Read from the flag, because `--loose` is exactly the run where it is not blocked. It was a
      // literal, so `orca replay <run> --loose` announced `egress=blocked` and then answered the
      // first unmatched request from the provider — the one line a reader checks to know whether a
      // run can spend money, saying the opposite of what the run was about to do. Worse than an
      // inaccuracy, because `replay halted` recommends `--loose` by name: the reader is following
      // orca's own advice when the label stops being true.
      egress: args.bool('loose') ? 'live-on-unmatched' : 'blocked',
      proxy: proxy.url,
      cwd: workspace.dir,
    });

    // The agent runs live for everything that is not a model call, MCP included. Without a config it
    // talks to servers orca cannot see — or, for a harness that requires the variable, does not start
    // at all, which is how a replay of a working recording exits non-zero for a reason that has
    // nothing to do with the recording.
    const mcp =
      trace === undefined
        ? undefined
        : await mcpForReplay(args, ctx.events, trace, out, join(ctx.runDir, 'mcp-frames.jsonl'));

    const adapter = defaultAdapters().get(ctx.manifest.adapter.id);
    const launch = await adapter.prepare({
      runId: ctx.manifest.run_id,
      cwd: workspace.dir,
      proxyUrl: proxy.url,
      runDir: ctx.runDir,
      userArgs: driveArgs(adapter, ctx, out, args),
      env: process.env,
    });
    // Replaying must not introduce a catalog request before the capture plugin is installed.
    if (adapter.id === 'opencode') launch.env.OPENCODE_DISABLE_MODELS_FETCH = '1';
    if (proxy.tls) await trustRunCa(trace, proxy.tls, proxy.url, launch.env, out);
    if (mcp) {
      pointAtMcpConfig(launch.env, mcp.configPath);
      // Same as record: the path has to reach the harness the way the harness actually reads it, or
      // a replay re-instruments a config nothing opens and every recorded MCP call goes unmatched.
      const mcpArgs = adapter.mcpConfigArgs?.(mcp.configPath);
      if (mcpArgs !== undefined) launch.args = [...mcpArgs, ...launch.args];
    }

    const exitCode = await runChild(
      launch.command,
      launch.args,
      { ...process.env, ...launch.env },
      workspace.dir,
      agentStdoutFor(args),
    );

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
      // What the replay discovered rather than repeated: these calls really happened just now, and
      // exist nowhere in the parent.
      if (mcp) await drainMcpFrames(mcp, trace, () => 0, 0);
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

    /**
     * Retrieval fidelity, on its own axis and only when the run has one.
     *
     * Never folded into `exact`: that number is about a matching ladder these calls do not climb,
     * and mixing them would make a recording look more faithfully reproduced the more embeddings
     * it happened to make. Omitted entirely when neither the recording nor the replay had any, so
     * an ordinary run's verdict line keeps the shape it has always had.
     */
    const retrieval =
      stats.retrievalTotal > 0 || stats.retrievalServed > 0 || stats.retrievalLive > 0
        ? { retrieval: `${stats.retrievalServed}/${stats.retrievalTotal}` }
        : {};

    out.phase('replay.done', {
      // `matched=1 total=13` was the old shape, and on a healthy replay of a real harness it read as
      // a failure: rung 1 is only reachable when nothing in the request was redacted, so a run whose
      // every request was served from disk still reported one match. What someone wants to know here
      // is how much of the recording was reused, and how much of that reuse was exact.
      reused: `${stats.matchedExact + stats.matchedInexact}/${ctx.exchanges.length}`,
      exact: stats.matchedExact,
      divergences: stats.divergences,
      unmatched: stats.unmatched,
      // Only when it happened. An exchange served from a position other than the cursor is not a
      // fidelity loss — it was byte-identical, or it carried a divergence of its own and is
      // counted there — but it is worth saying, because it is the difference between a recording
      // that reproduced and one that merely happened to line up.
      ...(stats.reordered > 0 ? { reordered: stats.reordered } : {}),
      ...retrieval,
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
      unmatched: stats.unmatched,
      liveCalls: stats.liveCalls,
      exitCode: verdict,
    };
  } catch (err) {
    // `return await`, not the bare `return abandon(err)` that `orca record` can afford. The
    // difference is the `finally` below: a promise returned out of a `catch` is not adopted by
    // the caller until the `finally` has finished, and this one awaits real I/O, so the
    // rejection sits with no handler attached for as long as that takes. Node reports it as an
    // unhandled rejection and kills the process on the spot — the operator got a raw stack trace
    // where `orca replay` had always printed `error replay.failed`, and `main`'s catch never ran
    // at all. Awaiting here turns it back into a throw *inside* the catch, before the finally,
    // which is what every frame above expects.
    return await abandon(err);
  } finally {
    // Both paths, which is why these two are here and the proxy is not: a replay that ran
    // closes its own proxy after reading `stats()`, and one that did not comes through
    // `abandon`. These do not divide that way. The whole justification for restoring over
    // the working tree is that it is put back, and `tls-capture.ts` asks the caller to own
    // the run CA on every exit path — `replayCommand` had no equivalent of the `minted`
    // wrapper `recordCommand` and `attachCommand` use, so a key outlived every failure
    // between the mint and the launch.
    await workspace.release();
    await mintedCa?.dispose();
  }
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
  const dir = await ensureRunsDir(ctx.cwd);
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

  // Before the worktree and the fork's own run directory, because both of these refuse:
  // `upstreamPlan` an upstream that is not an origin, `planTlsCapture` a `--tls-hosts` list that
  // names `*` or contradicts itself and an `ORCA_TLS_UPSTREAM_CA` that cannot be read. Resolved
  // after them, a typo in any of them left a restored temp tree in `$TMPDIR` that `orca gc` will
  // not reclaim — no manifest points at it — and an empty fork in `orca list`, reading
  // `FROM <parent>@<n>` as though it had run.
  const plan = await upstreamPlan(args);
  // A fork continues a recorded conversation, so it is intercepted on the same terms the
  // recording was; see `setupTlsCapture` below, which this is the refusing half of.
  const forkInterceptedHosts = recordedTlsHosts(ctx.events);
  await planTlsCapture(args, forkInterceptedHosts);

  const worktree = await mkdtemp(join(tmpdir(), `orca-${checkpoint.seq}-`));
  if (checkpoint.fsTree) {
    // Restore from the ORIGINAL run's shadow store: that is the only place the tree object
    // exists. Pointing a fresh store at the tree id fails to unpack it, which is exactly the
    // silent-wrong-state failure the checkpoint machinery is meant to prevent.
    const fs = await FsCapture.start({ runDir: ctx.runDir, cwd: ctx.cwd });
    await fs.restore(checkpoint.fsTree, worktree);
  }

  const dir = await ensureRunsDir(ctx.cwd);
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
  // When each turn began, so an MCP frame drained after the agent exits is attributed to the turn
  // it happened during rather than to whichever turn happened to be last.
  const turnStartedAt: { turn: number; at: number }[] = [];
  const turnAtFork = (at: number): number => {
    let found = 0;
    for (const mark of turnStartedAt) {
      if (mark.at > at) break;
      found = mark.turn;
    }
    return found;
  };
  const writes = new SerialQueue();

  /**
   * The fork's own filesystem capture, over its worktree.
   *
   * A fork had none, so its trace carried no `fs.snapshot` — and a checkpoint is derived from a
   * snapshot (spec §3), so a fork had no checkpoints and could not itself be forked. `orca compare
   * last` immediately after a fork failed with "this run has no checkpoints", because `last` had
   * resolved to the fork. The tool is pitched on iterative exploration; a branch you cannot branch
   * again is a dead end one step in.
   *
   * Same posture as recording: a capture layer that will not start degrades the trace and never
   * stops the run.
   */
  let forkFs: FsCapture | undefined;
  if (args.bool('fs', true)) {
    try {
      // Same widening as the recording's: a fork of a pipeline produces the same kind of
      // artifact, and a fork whose snapshots omit it is a fork that cannot itself be replayed.
      const forkArtifacts = defaultAdapters().get(ctx.manifest.adapter.id).artifacts?.capture;
      forkFs = await FsCapture.start({
        runDir: writer.runDir,
        cwd: worktree,
        ...(forkArtifacts === undefined ? {} : { forced: forkArtifacts }),
      });
    } catch (err) {
      out.warn('fs.unavailable', { reason: String(err) });
    }
  }

  // A fork runs a real agent live, so it has exactly the same blind spot `orca record` does: a
  // harness that talks to its own backend over TLS reads no base-URL variable and is invisible
  // without interception. The flag was parsed here and silently discarded, which is the worse
  // half — the operator believes they captured that traffic.
  // Same for a fork: it continues a recorded conversation, so its prefix is replayed and the
  // requests carrying it arrive by the same intercepted transport they were recorded on.

  /** Filled as each is built; see the exact path's pair, which this mirrors. */
  let mintedCa: RunCa | undefined;
  let openProxy: { close: () => Promise<void> } | undefined;

  /**
   * The same two failures `orca record` had. A listening proxy keeps Node's event loop alive, so
   * a throw printed the error and then hung; and a fork that mints a certificate authority must
   * not leave the private key on disk when it dies. The trace is sealed either way, because a
   * fork that failed to launch is still a fork someone will want to read.
   *
   * This used to guard the spawn alone, which is one throw out of five: `RunCa.create` writes the
   * key, `mcpForReplay` rewrites a config, `createProxy` binds, and `adapter.prepare` runs a
   * harness's own validation — all of them before the child, all of them leaving the key, the
   * socket, or both.
   */
  async function abandon(err: unknown): Promise<never> {
    await openProxy?.close().catch(() => undefined);
    await writes.drain().catch(() => undefined);
    await mintedCa?.dispose().catch(() => undefined);
    await writer
      .append({ type: 'run.end', actor: 'orca', turn, attrs: { error: String(err) } })
      .catch(() => undefined);
    await writer.close().catch(() => undefined);
    throw err;
  }

  const tls = await setupTlsCapture({
    args,
    out,
    ...(forkInterceptedHosts ? { recordedHosts: forkInterceptedHosts } : {}),
    writer,
    writes,
    turn: () => turn,
  }).catch(abandon);
  mintedCa = tls.ca;

  // A fork continues the run live past the checkpoint, so its MCP traffic is new and belongs in the
  // fork's own trace. Without this the layer simply stopped at the fork point.
  const mcp = await mcpForReplay(args, ctx.events, writer, out).catch(abandon);

  const proxy = await createProxy({
    mode: 'hybrid',
    forkAt,
    forkModel: ctx.model,
    exchanges: ctx.exchanges,
    // Past the cursor too: a fork changes which model answers, not what a paragraph embeds to.
    retrievals: ctx.retrievals,
    upstream: plan.upstream,
    upstreamHeaders: plan.headers,
    upstreamHeadersOrigin: plan.headersOrigin,
    ...tls.proxyOptions,
    onExchange: (exchange) => {
      writes.push(async () => {
        turn += 1;
        turnStartedAt.push({ turn, at: Date.now() });
        await appendDerivedEvents(writer, deriver, exchange, turn);
        if (forkFs) await appendSnapshot(forkFs, writer, out, turn);
      });
    },
    onRoute: (decision) => {
      writes.push(async () => {
        await writer.append({
          type: 'route.decision',
          // On a fork the gateway is orca: it substituted the model and picked what serves it.
          actor: 'gateway',
          turn,
          attrs: { ...decision },
        });
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
  // Listening from here on — see the exact path.
  openProxy = proxy;

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

  // The state the fork starts from, so its first checkpoint is the checkpoint it branched at
  // rather than whatever the first live turn happened to leave behind.
  if (forkFs) await appendSnapshot(forkFs, writer, out, 0, { initial: true });

  out.phase('forked', {
    from: ctx.manifest.run_id,
    at: checkpoint.seq,
    run: writer.runId,
    model: ctx.model ?? '(unchanged)',
    worktree,
  });

  // `defaultAdapters().get` refuses a manifest naming an adapter this build does not have, which
  // is what replaying a newer orca's recording looks like from here, and `prepare` is where a
  // harness validates its own invocation. Both are throws with the proxy already listening.
  const launch = await (async () => {
    const adapter = defaultAdapters().get(ctx.manifest.adapter.id);
    const prepared = await adapter.prepare({
      runId: writer.runId,
      cwd: worktree,
      proxyUrl: proxy.url,
      runDir: writer.runDir,
      userArgs: driveArgs(adapter, ctx, out, args),
      env: process.env,
    });

    if (proxy.tls) {
      await trustRunCa(writer, proxy.tls, proxy.url, prepared.env, out);
    }
    if (mcp) {
      pointAtMcpConfig(prepared.env, mcp.configPath);
      // Same as record: the path has to reach the harness the way the harness actually reads it,
      // or a replay re-instruments a config nothing opens and every recorded MCP call goes
      // unmatched.
      const mcpArgs = adapter.mcpConfigArgs?.(mcp.configPath);
      if (mcpArgs !== undefined) prepared.args = [...mcpArgs, ...prepared.args];
    }
    return prepared;
  })().catch(abandon);

  const exitCode = await runChild(
    launch.command,
    launch.args,
    { ...process.env, ...launch.env },
    worktree,
    agentStdoutFor(args),
  ).catch(abandon);
  await writes.drain();
  if (mcp) await drainMcpFrames(mcp, writer, turnAtFork, turn);

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
    // A fork keeps replaying retrieval past its own cursor, so this says how much of the parent's
    // index work it reused rather than paid for again. `live` counts chat turns; these are not.
    ...(stats.retrievalTotal > 0 || stats.retrievalLive > 0
      ? { retrieval: `${stats.retrievalServed}/${stats.retrievalTotal}` }
      : {}),
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
    unmatched: stats.unmatched,
    liveCalls: stats.liveCalls,
    exitCode,
  };
}

/** Where an exact replay runs, and how to put the directory back afterwards. */
interface Workspace {
  dir: string;
  /**
   * Put the working tree back. Idempotent, and called from two places for that reason: once at
   * the child's launch, where it belongs on the ordinary path, and once from a `finally` around
   * the whole restored span, which is what makes the guarantee hold for a throw that never
   * reaches the launch at all.
   */
  release: () => Promise<void>;
  /**
   * Whether this directory holds the recording's state and will be put back afterwards.
   *
   * False for `--in-place`, for a run with no snapshot to restore, and for a replay invoked from
   * somewhere other than the directory the recording was made in. It gates the one thing a replay
   * does that is not reversible on its own: deleting an adapter's declared artifacts. Orca may
   * delete only what it took a copy of first — anywhere else that would be destroying the
   * operator's index to reproduce someone else's.
   */
  restored: boolean;
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
  const artifacts = adapterArtifacts(ctx);
  if (args.bool('in-place')) {
    warnArtifactsKept(artifacts, out);
    return { dir: ctx.cwd, release: noRelease, restored: false };
  }

  const initial = deriveCheckpoints(ctx.events).find((c) => c.fsTree !== undefined);
  if (!initial?.fsTree) {
    out.warn('replay.in-place', {
      why: 'this run has no filesystem snapshot to restore',
      note: 'recorded with --no-fs; a file the run read may since have changed',
    });
    warnArtifactsKept(artifacts, out);
    return { dir: ctx.cwd, release: noRelease, restored: false };
  }

  const recorded = await FsCapture.start({ runDir: ctx.runDir, cwd: ctx.cwd });

  if (args.bool('worktree')) {
    // A fresh directory, so there is nothing for a reset to remove: the restore below is the only
    // thing that puts anything here, and what it puts here is the recording's starting state.
    const worktree = await mkdtemp(join(tmpdir(), `orca-replay-${ctx.manifest.run_id}-`));
    await recorded.restore(initial.fsTree, worktree);
    return { dir: worktree, release: noRelease, restored: true };
  }

  if (resolve(ctx.cwd) !== resolve(ctx.manifest.cwd)) {
    out.warn('replay.elsewhere', {
      recorded_in: ctx.manifest.cwd,
      running_in: ctx.cwd,
      note: 'not restoring over a directory the run was not recorded in; use --worktree for a copy',
    });
    warnArtifactsKept(artifacts, out);
    return { dir: ctx.cwd, release: noRelease, restored: false };
  }

  // A store of its own, under the OS temp dir: the safety snapshot is scratch, and writing it into
  // the trace's shadow store would leave an object in a recorded run that nothing references.
  const scratch = await mkdtemp(join(tmpdir(), 'orca-safety-'));
  // With the adapter's declared artifacts, for the reason the safety snapshot exists at all: the
  // replay is about to delete those paths (see `resetArtifacts`), and a snapshot that skipped
  // them because the workspace ignores them would make that deletion permanent. Orca may delete
  // only what it has a copy of.
  const forced = [
    ...new Set([...(artifacts?.capture ?? []), ...(artifacts?.resetBeforeReplay ?? [])]),
  ];
  const safety = await FsCapture.start({
    runDir: scratch,
    cwd: ctx.cwd,
    ...(forced.length === 0 ? {} : { forced }),
  });
  const before = await safety.snapshotTurn(0);

  out.info('replay.restored', {
    to: initial.fsTree,
    your_tree: before.tree,
    note: 'your files are restored when the replay ends',
  });

  // Two callers, on purpose — see `Workspace.release`. Restoring twice would be wrong rather than
  // merely wasteful: the second pass would write the pre-replay tree back over whatever the
  // caller has done since, and the `rm` would take the scratch with it.
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
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
  };

  // The destructive step, inside the thing that undoes it.
  //
  // A caller cannot guard this one: it happens here, and the `release` that undoes it does not
  // exist outside this function until this function returns. So a `materialize` that failed
  // part-way — it is `read-tree` + `checkout-index -a -f` with no rollback of its own, and a
  // path conflict, EACCES or ENOSPC stops it mid-tree — left the operator holding a mixture of
  // their files and the recording's, with the only copy of the original in a scratch directory
  // whose path nothing prints, and no release attempted anywhere.
  //
  // With this, the function has one postcondition either way: it returns with the tree replaced
  // and a `release` that puts it back, or it throws with the tree as it found it. That is what
  // lets the caller arm its own guard on the line after the call rather than before it.
  try {
    // Before the restore, not after — and that ordering is the whole definition of the reset.
    // `materialize` writes the tree's files and leaves anything else where it is, so a cache the
    // recording never had would survive it and the harness would resume from work the recording
    // did not do. Clearing first and restoring second leaves these paths holding *exactly* what
    // they held when the recording started, which is the only state the recording can answer for
    // — including the case where that state was a populated cache, as it is for a recording of
    // one mid-pipeline stage. Doing it the other way round deleted that stage's own input.
    await resetArtifacts(ctx.cwd, artifacts, out);
    await recorded.restore(initial.fsTree, ctx.cwd);
  } catch (err) {
    await release();
    throw err;
  }

  return { dir: ctx.cwd, release, restored: true };
}

/** What the adapter that made this recording says about its own artifacts, if anything. */
function adapterArtifacts(ctx: {
  manifest: { adapter: { id: string } };
}): HarnessArtifacts | undefined {
  try {
    return defaultAdapters().get(ctx.manifest.adapter.id).artifacts;
  } catch {
    // A trace naming an adapter this build does not have. The replay fails on that later, with a
    // better message than one from here; nothing about the workspace should depend on it.
    return undefined;
  }
}

/**
 * Delete the artifacts the harness resumes from, so the replay starts where the recording did.
 *
 * A pipeline picks up where it left off: it reads its own cache, sees which items are finished
 * and does the rest. Replayed on top of the recording's *completed* cache it does nothing — no
 * request is made, nothing is matched, and the replay reports having reproduced a run it never
 * ran. `reused=0/6 exit=0` is what that looks like, and it reads as a broken recording.
 *
 * Whole paths, never "the parts that look invalid". IndexRAG's resume skips by `chunk_id`
 * including entries whose recorded outcome was a failure, so keeping what looks valid promotes
 * the previous run's failures to completed work — a subtler wrong answer than the one being
 * fixed. The workspace is restored afterwards, which is what makes deleting acceptable at all,
 * and `workspace.restored` is the gate: orca deletes only where it took a copy first.
 */
async function resetArtifacts(
  dir: string,
  artifacts: HarnessArtifacts | undefined,
  out: Output,
): Promise<void> {
  const paths = artifacts?.resetBeforeReplay ?? [];
  if (paths.length === 0) return;
  const removed: string[] = [];
  for (const pattern of paths) {
    // The leading directory of the pattern, which is what a reset actually means: `cache/**` is a
    // declaration about `cache`, and removing the directory is both what the harness needs and
    // the only thing that can be done without a glob library. A pattern that names no directory
    // is removed as the literal path it is.
    const root = pattern.split(/[\\/]/)[0] ?? pattern;
    if (root === '' || root === '.' || root === '..' || root.includes('*')) continue;
    const target = resolve(dir, root);
    // Never outside the workspace, whatever an adapter declares.
    if (!isInsideDir(dir, target)) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(root);
  }
  if (removed.length > 0) {
    out.info('replay.artifacts_reset', {
      paths: [...new Set(removed)].join(','),
      why: 'the harness resumes from these, so they are put back to the recording’s starting state',
      note: 'your files are restored when the replay ends',
    });
  }
}

/** The `--in-place` half of the same rule: say what was not done, rather than doing it unsafely. */
function warnArtifactsKept(artifacts: HarnessArtifacts | undefined, out: Output): void {
  const paths = artifacts?.resetBeforeReplay ?? [];
  if (paths.length === 0) return;
  out.warn('replay.artifacts_kept', {
    paths: paths.join(','),
    why: 'this replay is not restoring the working tree, so orca has no copy to put back',
    effect:
      'the harness may resume from artifacts the recording had not produced yet and ask nothing',
    next: 'replay without --in-place, or clear them yourself',
  });
}

/** Whether `target` is `dir` or sits under it, by the platform's own path rules. */
function isInsideDir(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Where the replayed agent's own stdout should go, given the flags. */
function agentStdoutFor(args: ParsedArgs): 'inherit' | 'stderr' | 'ignore' {
  if (args.bool('quiet')) return 'ignore';
  return args.bool('json') ? 'stderr' : 'inherit';
}

/**
 * Launch the agent for a replay or a fork.
 *
 * Where the replayed agent's own stdout goes:
 *
 *   inherit  the default — you asked to watch the run happen again, so you watch it
 *   stderr   `--json`: orca's stdout is the result document, so the agent's output moves aside
 *            rather than landing in the middle of it
 *   ignore   `--quiet`: the run is being replayed for its verdict, not for its narration
 *
 * stdin and stderr stay inherited in every case, so a harness that prompts still can and a
 * harness that fails still says why.
 */
async function runChild(
  command: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
  agentStdout: 'inherit' | 'stderr' | 'ignore' = 'inherit',
): Promise<number> {
  // Same resolution as record and as detection; see resolveLaunch.
  const target = await resolveLaunch(command, argv);
  return new Promise((resolve, reject) => {
    const child = spawn(target.file, target.args, {
      env,
      cwd,
      shell: target.shell,
      stdio:
        agentStdout === 'inherit'
          ? 'inherit'
          : ['inherit', agentStdout === 'ignore' ? 'ignore' : 'pipe', 'inherit'],
    });
    if (agentStdout === 'stderr') child.stdout?.pipe(process.stderr);
    child.on('error', (err) =>
      reject(new Error(`could not launch "${command}": ${String(err)}\n  is it on your PATH?`)),
    );
    child.on('close', (code) => resolve(code ?? 0));
  });
}
