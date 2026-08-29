import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { delimiter } from 'node:path';
import { TraceWriter, runsDir } from '@orcareplay/core';
import { FsCapture } from '@orcareplay/fs-capture';
import { createProxy, type RecordedExchange } from '@orcareplay/proxy';
import { defaultAdapters } from '@orcareplay/adapters';
import type { Adapter, RecordContext } from '@orcareplay/plugin-api';
import { ExchangeEventDeriver } from '../exchange-events.js';
import { installShellShim, readShellFrames } from '@orcareplay/shell-shim';
import { setupMcpCapture, type McpCapture } from '../mcp.js';
import { SerialQueue } from '../serial.js';
import { snapshotWithRetry } from '../snapshot.js';
import type { Output } from '../out.js';
import type { ParsedArgs } from '../args.js';
import { upstreamOverrides } from '../upstream.js';
import { ORCA_VERSION } from '../version.js';

export interface RecordResult {
  runId: string;
  runDir: string;
  events: number;
  exitCode: number;
}

/**
 * `orca record <agent>` — stand up the capture layers, launch the agent pointed at them, and get
 * out of the way. The agent is not patched, wrapped or modified; it is simply started with a
 * couple of environment variables that point its model traffic at a local proxy.
 */
export async function recordCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
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
          `  name one explicitly: orca record <${registry.ids().join('|')}>`,
      );
    }
    out.info('adapter.detected', { id: adapter.id });
  }

  const dir = runsDir(cwd);
  await mkdir(dir, { recursive: true });

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
  // Serial, not parallel: each persist snapshots the workspace, and two overlapping `git add`
  // calls collide on index.lock. It also keeps seq in the order exchanges actually happened.
  const writes = new SerialQueue();

  const proxy = await createProxy({
    mode: 'record',
    upstream: upstreamOverrides(args),
    onExchange: (exchange: RecordedExchange) => {
      writes.push(() => persist(exchange));
    },
  });

  async function persist(exchange: RecordedExchange): Promise<void> {
    turn += 1;
    for (const derived of deriver.derive(exchange, turn)) {
      const causes: number[] = [];
      if (derived.causesToolId) {
        const seq = deriver.seqOf(derived.causesToolId);
        if (seq !== undefined) causes.push(seq);
      }
      const event = await writer.append({
        type: derived.type,
        actor: derived.actor,
        turn,
        attrs: derived.attrs,
        payload: derived.payload as never,
        ...(causes.length > 0 ? { causes } : {}),
      });
      if (derived.type === 'tool.call') {
        deriver.markPending(String(derived.attrs.tool_use_id), event.seq);
      }
    }

    if (fs) {
      const outcome = await snapshotWithRetry(fs, turn);
      if (!outcome.ok || !outcome.snapshot) {
        // Degrade, never abort: losing a snapshot costs one checkpoint, whereas throwing here
        // would cost the user the run they were trying to record.
        out.warn('fs.snapshot_failed', { turn, attempts: outcome.attempts, error: outcome.error });
        await writer.append({
          type: 'note',
          actor: 'orca',
          turn,
          attrs: { rule: 'fs_snapshot_skipped', attempts: outcome.attempts, error: outcome.error },
        });
      } else {
        const snap = outcome.snapshot;
        await writer.append({
          type: 'fs.snapshot',
          actor: 'orca',
          turn,
          attrs: { tree: snap.tree, changes: snap.changes.length },
        });
        for (const change of snap.changes) {
          await writer.append({
            type: 'fs.change',
            actor: 'orca',
            turn,
            attrs: {
              path: change.path,
              status: change.status,
              insertions: change.insertions,
              deletions: change.deletions,
            },
          });
        }
      }
    }
  }

  await writer.append({
    type: 'run.start',
    actor: 'orca',
    turn: 0,
    attrs: { adapter: adapter.id, cwd, proxy: proxy.url },
  });

  if (fs) {
    const initial = await snapshotWithRetry(fs, 0);
    if (initial.ok && initial.snapshot) {
      await writer.append({
        type: 'fs.snapshot',
        actor: 'orca',
        turn: 0,
        attrs: { tree: initial.snapshot.tree, changes: 0, initial: true },
      });
    } else {
      out.warn('fs.snapshot_failed', { turn: 0, error: initial.error });
    }
  }

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
  if (mcp) {
    // Every target harness reads one of these; setting all three costs nothing and avoids making
    // the user work out which one their agent uses.
    launch.env.MCP_CONFIG_PATH = mcp.configPath;
    launch.env.CLAUDE_MCP_CONFIG = mcp.configPath;
    launch.env.OPENCODE_MCP_CONFIG = mcp.configPath;
  }

  out.phase('recording', {
    run: writer.runId,
    adapter: adapter.id,
    proxy: proxy.url,
    fs: fs ? 'on' : 'off',
    shell: shell ? 'on' : 'off',
  });

  const exitCode = await runChild(
    launch.command,
    launch.args,
    {
      ...process.env,
      ...launch.env,
      ...(launch.cwd ? {} : {}),
    },
    launch.cwd ?? cwd,
  );

  await writes.drain();

  if (shell) {
    for (const frame of await readShellFrames(shell.framesPath)) {
      const exec = await writer.append({
        type: 'shell.exec',
        actor: 'harness',
        turn,
        attrs: { argv: [frame.name, ...frame.argv], cwd: frame.cwd },
      });
      await writer.append({
        type: 'shell.result',
        actor: 'harness',
        turn,
        causes: [exec.seq],
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

  if (mcp) {
    for (const frame of await mcp.drain()) {
      await writer.append({
        type: frame.direction === 'in' ? 'mcp.request' : 'mcp.response',
        actor: 'agent',
        turn,
        attrs: { server: frame.server, kind: frame.kind, method: frame.method, id: frame.id },
        payload: frame.raw,
      });
    }
  }

  const orphans = deriver.unresolved();
  if (orphans.length > 0) {
    await writer.append({
      type: 'note',
      actor: 'orca',
      turn,
      attrs: { rule: 'unresolved_tool_calls', ids: orphans.map((o) => o.id) },
    });
  }

  await writer.append({ type: 'run.end', actor: 'orca', turn, attrs: { exit_code: exitCode } });
  const manifest = await writer.close(exitCode);
  await proxy.close();

  out.phase('recorded', {
    run: writer.runId,
    events: manifest.counts?.events ?? writer.seq,
    blobs: manifest.counts?.blobs ?? 0,
    exit: exitCode,
    dir: writer.runDir,
  });
  out.plain('');
  out.plain(`  orca replay ${writer.runId}            # reproduce it exactly`);
  out.plain(`  orca replay ${writer.runId} --ui       # open the timeline`);

  return {
    runId: writer.runId,
    runDir: writer.runDir,
    events: manifest.counts?.events ?? writer.seq,
    exitCode,
  };
}

function runChild(
  command: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env, cwd, stdio: 'inherit' });
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
