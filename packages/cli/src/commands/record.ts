import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { TraceWriter, ensureRunsDir } from '@orcareplay/core';
import { FsCapture } from '@orcareplay/fs-capture';
import { createProxy, RunCa, type NetExchange, type RecordedExchange } from '@orcareplay/proxy';
import { defaultAdapters } from '@orcareplay/adapters';
import type { Adapter, RecordContext } from '@orcareplay/plugin-api';
import { ExchangeEventDeriver, appendDerivedEvents } from '../exchange-events.js';
import { installShellShim, readShellFrames } from '@orcareplay/shell-shim';
import { drainMcpFrames, pointAtMcpConfig, setupMcpCapture, type McpCapture } from '../mcp.js';
import { SerialQueue } from '../serial.js';
import { appendSnapshot } from '../fs-events.js';
import type { Output } from '../out.js';
import type { ParsedArgs } from '../args.js';
import { persistNetExchange, setupTlsCapture, trustRunCa } from '../tls-capture.js';
import { upstreamPlan } from '../upstream.js';
import { ORCA_VERSION } from '../version.js';

export interface RecordResult {
  /**
   * Model exchanges the proxy captured.
   *
   * Zero is the failure this whole field exists for, and it has to be readable by a caller that
   * has no terminal to watch: the agent answers, the exit code is zero, and the trace is empty.
   */
  modelExchanges: number;
  runId: string;
  runDir: string;
  events: number;
  exitCode: number;
}

/**
 * `orca record <agent>` — stand up the capture layers, launch the agent pointed at them, and get
 * out of the way. The agent is not patched, wrapped or modified; it is simply started with a
 * couple of environment variables that point its model traffic at a local proxy.
 *
 * The wrapper exists for one reason: a TLS-intercepting run mints a private key, and a key that
 * outlives a failed run is the outcome this feature must not have. The recording's own teardown
 * deletes it on the way out, but the likeliest failure of all — the agent is not installed —
 * happens before any teardown runs. Owning the key's lifetime out here means no failure path
 * inside can skip it.
 */
export async function recordCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<RecordResult> {
  const minted: RunCa[] = [];
  try {
    return await runRecording(args, out, cwd, minted);
  } catch (err) {
    for (const ca of minted) {
      await ca.dispose().catch(() => undefined);
    }
    throw err;
  }
}

async function runRecording(
  args: ParsedArgs,
  out: Output,
  cwd: string,
  minted: RunCa[],
): Promise<RecordResult> {
  const registry = defaultAdapters();
  const agentName = args.positionals[0];

  let adapter: Adapter | undefined;
  if (agentName) {
    adapter = registry.get(agentName);
  } else {
    adapter = await registry.detect(cwd);
    if (!adapter) {
      throw new Error(
        `could not detect an agent in ${cwd}\n` +
          `  name one explicitly: orca record <${registry.ids().join('|')}>\n` +
          `  known agents: ${registry.names().join('; ')}`,
      );
    }
    out.info('adapter.detected', { id: adapter.id });
  }

  const dir = await ensureRunsDir(cwd);

  const writer = await TraceWriter.create(dir, {
    adapter: { id: adapter.id, version: ORCA_VERSION, harness_version: adapter.harnessVersions },
    argv: [agentName ?? adapter.id, ...args.passthrough],
    cwd,
    orcaVersion: ORCA_VERSION,
  });

  const captureFs = args.bool('fs', true);
  let fs: FsCapture | undefined;
  if (captureFs) {
    try {
      fs = await FsCapture.start({ runDir: writer.runDir, cwd });
      // Read once, before the agent touches anything: `git` describes the state the run started
      // from, which is what makes it a reproduction instruction rather than a postscript.
      writer.setGit(await fs.gitInfo());
    } catch (err) {
      // Filesystem capture is valuable but not essential; losing it should degrade the trace,
      // not abort the run the user actually wanted to record.
      out.warn('fs.unavailable', { reason: String(err) });
    }
  }

  // MCP capture is opt-in by pointing at a config: the file lives in a different place for every
  // harness, and guessing wrong would rewrite something the user did not mean us to touch.
  let mcp: McpCapture | undefined;
  const mcpConfigPath = args.str('mcp-config');
  if (mcpConfigPath) {
    mcp = await setupMcpCapture({ sourceConfigPath: mcpConfigPath, runDir: writer.runDir, out });
    if (mcp) {
      // The source path, written down because a replay needs it and can get it nowhere else:
      // `manifest.argv` holds the agent's own arguments, and `--mcp-config` is orca's. Without this
      // a replay of an MCP-using run either loses the layer or cannot start the harness at all.
      await writer.append({
        type: 'note',
        actor: 'orca',
        turn: 0,
        attrs: {
          rule: 'mcp_instrumented',
          source: resolve(cwd, mcpConfigPath),
          servers: mcp.rewritten.join(',') || undefined,
          skipped: mcp.skipped.join(',') || undefined,
        },
      });
    }
  }

  // Shell capture: a PATH shim in front of sh/bash. The protocol layer already reports the command
  // and its merged output one turn late; what only the shim can see is the exit code, the real
  // duration, and which stream each byte came out of.
  let shell: Awaited<ReturnType<typeof installShellShim>> | undefined;
  if (args.bool('shell', true)) {
    try {
      shell = await installShellShim({ runDir: writer.runDir });
    } catch (err) {
      // Same posture as filesystem capture: degrade the trace, never abort the run.
      out.warn('shell.unavailable', { reason: String(err) });
    }
  }

  const deriver = new ExchangeEventDeriver();
  let turn = 0;
  // When each turn began, so an out-of-band frame can be attributed to the turn it happened during
  // rather than to whichever turn happened to be last when we drained the file.
  const turnStartedAt: { turn: number; at: number }[] = [];
  // Serial, not parallel: each persist snapshots the workspace, and two overlapping `git add`
  // calls collide on index.lock. It also keeps seq in the order exchanges actually happened.
  const writes = new SerialQueue();

  const plan = await upstreamPlan(args);

  /**
   * TLS interception, off unless the flag is present.
   *
   * Base-URL injection captures every harness that reads a base-URL variable, which is most of
   * them. A Codex CLI signed in with a ChatGPT subscription reads none, and talks to its own
   * backend over TLS — invisible to the ordinary mechanism. This is the answer to that, and it is
   * deliberately a separate decision the operator has to make: it mints a certificate authority.
   */
  const tls = await setupTlsCapture({ args, out, writer, writes, turn: () => turn });
  if (tls.ca) minted.push(tls.ca);
  const ca = tls.ca;

  /** Model exchanges the proxy actually captured — the number the warning below turns on. */
  let modelExchanges = 0;

  const proxy = await createProxy({
    mode: 'record',
    upstream: plan.upstream,
    upstreamHeaders: plan.headers,
    onExchange: (exchange: RecordedExchange) => {
      modelExchanges += 1;
      writes.push(() => persist(exchange));
    },
    // A POST on a path no dialect claims is forwarded rather than refused, and lands in the trace
    // as the same `net.*` pair unrecognised TLS traffic does. Orca holds the bytes but not the
    // meaning, so it is evidence, not a replayable turn.
    onNetExchange: (exchange: NetExchange) => {
      writes.push(() => persistNetExchange(writer, turn, exchange));
    },
    ...tls.proxyOptions,
  });

  async function persist(exchange: RecordedExchange): Promise<void> {
    turn += 1;
    turnStartedAt.push({ turn, at: Date.now() });
    await appendDerivedEvents(writer, deriver, exchange, turn);

    if (fs) await appendSnapshot(fs, writer, out, turn);
  }

  await writer.append({
    type: 'run.start',
    actor: 'orca',
    turn: 0,
    attrs: { adapter: adapter.id, cwd, proxy: proxy.url },
  });

  if (fs) await appendSnapshot(fs, writer, out, 0, { initial: true });

  const ctx: RecordContext = {
    runId: writer.runId,
    cwd,
    proxyUrl: proxy.url,
    runDir: writer.runDir,
    userArgs: args.passthrough,
    env: process.env,
  };
  const launch = await adapter.prepare(ctx);
  if (shell) {
    launch.env.PATH = `${shell.dir}${delimiter}${process.env.PATH ?? ''}`;
  }
  if (mcp) pointAtMcpConfig(launch.env, mcp.configPath);

  if (proxy.tls) {
    await trustRunCa(writer, proxy.tls, proxy.url, launch.env, out);
  }

  out.phase('recording', {
    run: writer.runId,
    adapter: adapter.id,
    proxy: proxy.url,
    fs: fs ? 'on' : 'off',
    shell: shell ? 'on' : 'off',
  });

  let exitCode: number;
  try {
    exitCode = await runChild(
      launch.command,
      launch.args,
      { ...process.env, ...launch.env },
      launch.cwd ?? cwd,
      // Under --json, stdout is the result document. The agent's own output must not land in it.
      args.bool('json'),
    );
  } catch (err) {
    // Two failures share this path, and both were silent in their own way.
    //
    // A listening proxy keeps Node's event loop alive, so a throw here printed the error and then
    // hung — `orca record generic-openai -- /nonexistent` never exited, and mistyping an agent
    // name is the first thing a new user does. And an unsealed trace has no `ended_at`, `counts`
    // or `integrity`, so everything the agent did is on disk while `verifyIntegrity` reports the
    // run as *tampered* rather than as unfinished.
    //
    // Sealing here rather than discarding: a run that died is often the run you most want to
    // read, and the exit code is unknown rather than zero, so it is left absent.
    await proxy.close().catch(() => undefined);
    await writes.drain().catch(() => undefined);
    if (ca) await ca.dispose().catch(() => undefined);
    await writer
      .append({ type: 'run.end', actor: 'orca', turn, attrs: { error: String(err) } })
      .catch(() => undefined);
    await writer.close().catch(() => undefined);
    throw err;
  }

  await writes.drain();

  /** The turn an out-of-band frame belongs to: the last one that had begun when it happened. */
  function turnAt(at: number): number {
    let found = 0;
    for (const mark of turnStartedAt) {
      if (mark.at > at) break;
      found = mark.turn;
    }
    return found;
  }

  if (shell) {
    // Timestamped from the frame, not from now. These are read off disk after the agent has
    // exited, so stamping them at write time put every shell command at the end of the run with
    // the final turn number — which makes `mono_us` describe the drain rather than the command,
    // and leaves the commands unable to interleave with the model turns they happened between.
    for (const frame of await readShellFrames(shell.framesPath)) {
      const startedAt = Date.parse(frame.startedAt);
      const at = Number.isNaN(startedAt) ? undefined : new Date(startedAt);
      const frameTurn = at === undefined ? turn : turnAt(startedAt);
      const exec = await writer.append({
        type: 'shell.exec',
        actor: 'harness',
        turn: frameTurn,
        ...(at === undefined ? {} : { occurredAt: at }),
        attrs: { argv: [frame.name, ...frame.argv], cwd: frame.cwd },
      });
      await writer.append({
        type: 'shell.result',
        actor: 'harness',
        turn: frameTurn,
        causes: [exec.seq],
        // The result happened when the command finished, which is what its duration measures.
        ...(at === undefined ? {} : { occurredAt: new Date(startedAt + frame.durationMs) }),
        attrs: {
          exit_code: frame.exitCode,
          signal: frame.signal,
          duration_ms: frame.durationMs,
          stdout_bytes: frame.stdoutBytes,
          stderr_bytes: frame.stderrBytes,
        },
      });
    }
  }

  if (mcp) await drainMcpFrames(mcp, writer, turnAt, turn);

  const orphans = deriver.unresolved();
  if (orphans.length > 0) {
    await writer.append({
      type: 'note',
      actor: 'orca',
      turn,
      attrs: { rule: 'unresolved_tool_calls', ids: orphans.map((o) => o.id) },
    });
  }

  // Before the trace is sealed, not after. A tunnel's record is only complete when its socket
  // closes, and closing the proxy is what closes the ones an exiting agent left open — so a
  // `proxy.close()` after `writer.close()` produced tunnel records with nowhere to go.
  await proxy.close();
  await writes.drain();
  // The CA dies with the run. `dispose` is idempotent and best-effort: failing to delete a key is
  // worth a warning, never worth losing the trace the user was recording.
  if (ca) {
    try {
      await ca.dispose();
    } catch (err) {
      out.warn('tls.ca_not_removed', { path: ca.dir, reason: String(err) });
    }
  }

  await writer.append({ type: 'run.end', actor: 'orca', turn, attrs: { exit_code: exitCode } });
  const manifest = await writer.close(exitCode);

  out.phase('recorded', {
    run: writer.runId,
    events: manifest.counts?.events ?? writer.seq,
    blobs: manifest.counts?.blobs ?? 0,
    exit: exitCode,
    dir: writer.runDir,
  });

  /**
   * The quietest way orca can fail, and the most damaging.
   *
   * Capture works by pointing a base-URL variable at the proxy, so a harness that reads none of
   * them is never redirected — and there is nothing to notice. The agent answers, the exit code is
   * zero, and the trace is empty. `@ai-sdk/openai` is the live example: it takes its base URL only
   * as a constructor argument, so an agent built on the Vercel AI SDK produces exactly this.
   *
   * `contract.ts` already names this shape as what the adapter checks exist to prevent. They guard
   * the adapters; this guards the run, which is where a user actually meets it.
   */
  if (modelExchanges === 0) {
    out.warn('capture.empty', {
      exchanges: 0,
      cause: 'the agent never called the proxy — it may not read a base-URL variable',
      set:
        Object.keys(launch.env)
          .filter((name) => /(?:_BASE_URL|_API_BASE)$/.test(name))
          .sort()
          .join(',') || 'none',
      next: 'orca doctor',
    });
  }

  out.plain('');
  out.plain(`  orca replay ${writer.runId}            # reproduce it exactly`);
  out.plain(`  orca replay ${writer.runId} --ui       # open the timeline`);

  return {
    runId: writer.runId,
    runDir: writer.runDir,
    events: manifest.counts?.events ?? writer.seq,
    modelExchanges,
    exitCode,
  };
}

/**
 * Launch the agent.
 *
 * `stdio: 'inherit'` by default, and that matters: an interactive harness needs the real terminal,
 * and anything less turns a TUI into a stream of escape codes.
 *
 * `quietStdout` is for `--json`, where orca's stdout is a document rather than a terminal. The
 * agent's own chatter is still shown — it moves to stderr, where a human reads it and a parser
 * does not. stdin and stderr stay inherited so the agent can still prompt and still colour.
 */
function runChild(
  command: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  quietStdout = false,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      env,
      cwd,
      stdio: quietStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    });
    child.stdout?.pipe(process.stderr);
    // Forward interrupts so Ctrl-C reaches the agent rather than orphaning it behind the proxy.
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);

    child.on('error', (err) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      reject(
        new Error(
          `could not launch "${command}"\n` +
            `  ${String(err)}\n` +
            `  is it installed and on your PATH?`,
        ),
      );
    });
    child.on('close', (code) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve(code ?? 0);
    });
  });
}
