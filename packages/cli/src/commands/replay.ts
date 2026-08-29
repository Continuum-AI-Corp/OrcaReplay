import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { isBlobRef, type TraceEvent } from '@orcareplay/schema';
import { ExchangeEventDeriver } from '../exchange-events.js';
import type { Output } from '../out.js';
import type { ParsedArgs } from '../args.js';
import { upstreamOverrides } from '../upstream.js';
import { ORCA_VERSION } from '../version.js';

export interface ReplayResult {
  runId: string;
  mode: 'exact' | 'fork';
  matchedExact: number;
  divergences: number;
  liveCalls: number;
  exitCode: number;
  forkRunId?: string;
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
 * Deliberately not `resolvePayload`: that JSON-parses a spilled blob, so a raw JSON string would
 * come back as a string when it fitted inline and as an object once it spilled — and an SSE body
 * would throw outright. Exact replay means handing the agent the same bytes, so we decode them.
 */
async function rawBodyOf(reader: TraceReader, event: TraceEvent): Promise<string> {
  const payload = event.payload;
  if (isBlobRef(payload)) return new TextDecoder().decode(await reader.blob(payload));
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
  if (!integrity.ok) {
    out.warn('trace.integrity', {
      expected: integrity.expected,
      actual: integrity.actual,
      note: 'events.jsonl changed since the run ended',
    });
  }

  const exchanges = await loadExchanges(reader);
  const from = args.num('from');
  const model = args.str('model');
  const isFork = from !== undefined || model !== undefined;

  if (!isFork) {
    return replayExact(args, out, { manifest, events, exchanges, runDir });
  }
  return replayFork(args, out, { manifest, events, exchanges, runDir, cwd, from, model });
}

interface Ctx {
  manifest: ReturnType<TraceReader['manifest']>;
  events: TraceEvent[];
  exchanges: RecordedExchange[];
  runDir: string;
}

/**
 * Exact replay. Every response comes from the trace and egress is blocked — if the agent reaches
 * for the network here, that is a bug we want to fail on, not paper over.
 */
async function replayExact(args: ParsedArgs, out: Output, ctx: Ctx): Promise<ReplayResult> {
  const divergences: { level: string; detail: string; seq: number }[] = [];
  const proxy = await createProxy({
    mode: 'replay',
    exchanges: ctx.exchanges,
    loose: args.bool('loose'),
    upstream: upstreamOverrides(args),
    onDivergence: (d) => void divergences.push(d),
  });

  out.phase('replaying', {
    run: ctx.manifest.run_id,
    exchanges: ctx.exchanges.length,
    egress: 'blocked',
    proxy: proxy.url,
  });

  const adapter = defaultAdapters().get(ctx.manifest.adapter.id);
  const launch = await adapter.prepare({
    runId: ctx.manifest.run_id,
    cwd: process.cwd(),
    proxyUrl: proxy.url,
    runDir: ctx.runDir,
    userArgs: ctx.manifest.argv.slice(1),
    env: process.env,
  });

  const exitCode = await runChild(launch.command, launch.args, {
    ...process.env,
    ...launch.env,
  });

  const stats = proxy.stats();
  await proxy.close();

  for (const d of divergences) {
    out.warn('divergence', { seq: d.seq, level: d.level, detail: d.detail });
  }

  out.phase('replay.done', {
    matched: stats.matchedExact,
    total: ctx.exchanges.length,
    divergences: stats.divergences,
    unmatched: stats.unmatched,
    exit: exitCode,
  });

  return {
    runId: ctx.manifest.run_id,
    mode: 'exact',
    matchedExact: stats.matchedExact,
    divergences: stats.divergences,
    liveCalls: stats.liveCalls,
    exitCode,
  };
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
  });

  const deriver = new ExchangeEventDeriver();
  let turn = 0;
  const writes: Promise<unknown>[] = [];

  const proxy = await createProxy({
    mode: 'hybrid',
    forkAt,
    forkModel: ctx.model,
    exchanges: ctx.exchanges,
    upstream: upstreamOverrides(args),
    onExchange: (exchange) => {
      writes.push(
        (async () => {
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
        })(),
      );
    },
    onDivergence: (d) => {
      writes.push(
        writer.append({
          type: 'divergence',
          actor: 'orca',
          turn,
          attrs: { level: d.level, rung: d.rung, detail: d.detail, source_seq: d.seq },
        }),
      );
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

  const exitCode = await runChild(
    launch.command,
    launch.args,
    { ...process.env, ...launch.env },
    worktree,
  );
  await Promise.all(writes);

  const stats = proxy.stats();
  await writer.append({ type: 'run.end', actor: 'orca', turn, attrs: { exit_code: exitCode } });
  const manifest = await writer.close(exitCode);
  await proxy.close();

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
    forkRunId: writer.runId,
    mode: 'fork',
    matchedExact: stats.matchedExact,
    divergences: stats.divergences,
    liveCalls: stats.liveCalls,
    exitCode,
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
