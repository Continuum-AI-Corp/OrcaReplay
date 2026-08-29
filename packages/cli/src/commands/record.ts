import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { delimiter } from 'node:path';
import { TraceWriter, runsDir } from '@orcareplay/core';
import { FsCapture } from '@orcareplay/fs-capture';
import {
  createProxy,
  DEFAULT_TLS_HOSTS,
  HostPolicy,
  RunCa,
  type NetExchange,
  type RecordedExchange,
  type TunnelRecord,
} from '@orcareplay/proxy';
import { defaultAdapters } from '@orcareplay/adapters';
import type { Adapter, RecordContext } from '@orcareplay/plugin-api';
import { ExchangeEventDeriver } from '../exchange-events.js';
import { installShellShim, readShellFrames } from '@orcareplay/shell-shim';
import { setupMcpCapture, type McpCapture } from '../mcp.js';
import { SerialQueue } from '../serial.js';
import { snapshotWithRetry } from '../snapshot.js';
import type { Output } from '../out.js';
import type { ParsedArgs } from '../args.js';
import { upstreamPlan } from '../upstream.js';
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
          `  name one explicitly: orca record <${registry.ids().join('|')}>\n` +
          `  known agents: ${registry.names().join('; ')}`,
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
  const interceptTls = args.bool('tls-intercept');
  const tlsHosts = args.list('tls-hosts');
  // Naming hosts without asking for interception captures nothing and says nothing, which reads
  // as "orca ignored my traffic" rather than as "orca ignored my flag".
  if (!interceptTls && tlsHosts.length > 0) {
    out.warn('tls.hosts_ignored', { hosts: tlsHosts.join(','), next: 'add --tls-intercept' });
  }
  const interceptHosts = tlsHosts.length > 0 ? tlsHosts : DEFAULT_TLS_HOSTS;
  let ca: RunCa | undefined;
  let originRoots: string[] = [];
  if (interceptTls) {
    // Everything that can be rejected is rejected before anything is minted, so a run that is not
    // going to happen — `--tls-hosts '*'`, an unreadable ORCA_TLS_UPSTREAM_CA — leaves no private
    // key on disk at all.
    HostPolicy.from(interceptHosts);
    originRoots = await extraOriginRoots();
    ca = await RunCa.create({ runDir: writer.runDir });
  }

  const proxy = await createProxy({
    mode: 'record',
    upstream: plan.upstream,
    upstreamHeaders: plan.headers,
    onExchange: (exchange: RecordedExchange) => {
      writes.push(() => persist(exchange));
    },
    ...(ca
      ? {
          tls: {
            ca,
            hosts: interceptHosts,
            trustedOriginCerts: originRoots,
            onNetExchange: (exchange: NetExchange) => {
              writes.push(() => persistNetExchange(exchange));
            },
            onTunnel: (tunnel: TunnelRecord) => {
              writes.push(() => persistTunnel(tunnel));
            },
            onFailure: (failure) => out.warn('tls.handshake_failed', { ...failure }),
          },
        }
      : {}),
  });

  /**
   * One decrypted HTTP exchange orca did not recognise as a model call.
   *
   * `net.request` / `net.response` have been in the spec since v0 and nothing has ever emitted
   * them; this is what makes them real. The pair is deliberately shaped like `model.request` /
   * `model.response` so the timeline reads the same either way.
   */
  async function persistNetExchange(exchange: NetExchange): Promise<void> {
    const request = await writer.append({
      type: 'net.request',
      // The agent made the call. No actor names "some server on the internet", so the reply is
      // attributed to orca, which is the only party that witnessed it.
      actor: 'agent',
      turn,
      attrs: {
        host: exchange.host,
        port: exchange.port,
        method: exchange.method,
        path: exchange.path,
        intercepted: true,
        headers: exchange.requestHeaders,
        truncated: exchange.requestTruncated,
      },
      payload: exchange.requestBody,
    });
    await writer.append({
      type: 'net.response',
      actor: 'orca',
      turn,
      causes: [request.seq],
      attrs: {
        host: exchange.host,
        port: exchange.port,
        status: exchange.status,
        intercepted: true,
        headers: exchange.responseHeaders,
        bytes: exchange.responseBytes,
        truncated: exchange.responseTruncated,
        duration_ms: exchange.durationMs,
      },
      payload: exchange.responseBody,
    });
  }

  /**
   * A connection orca refused to decrypt.
   *
   * Recorded because the refusal is itself the evidence — and because an operator whose harness
   * talks to an endpoint nobody predicted finds it here, in a line naming the host and nothing
   * else, rather than by guessing. No path, no headers, no payload: there is nothing to write,
   * because orca never held the plaintext.
   */
  async function persistTunnel(tunnel: TunnelRecord): Promise<void> {
    const request = await writer.append({
      type: 'net.request',
      actor: 'agent',
      turn,
      attrs: {
        host: tunnel.host,
        port: tunnel.port,
        intercepted: false,
        reason: 'host not in the TLS interception allowlist',
      },
    });
    await writer.append({
      type: 'net.response',
      actor: 'orca',
      turn,
      causes: [request.seq],
      attrs: {
        host: tunnel.host,
        port: tunnel.port,
        intercepted: false,
        bytes_to_origin: tunnel.bytesToOrigin,
        bytes_to_client: tunnel.bytesToClient,
        duration_ms: tunnel.durationMs,
        ...(tunnel.error === undefined ? {} : { error: tunnel.error }),
      },
    });
  }

  async function persist(exchange: RecordedExchange): Promise<void> {
    turn += 1;
    turnStartedAt.push({ turn, at: Date.now() });
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

  if (proxy.tls) {
    // A digest, never the certificate and never the key. The CA is deleted when the run ends, so
    // this line is the only lasting evidence of which authority signed what — enough to match a
    // certificate someone finds later to the run that minted it, and useless for anything else.
    await writer.append({
      type: 'note',
      actor: 'orca',
      turn: 0,
      attrs: {
        rule: 'tls_intercept',
        hosts: proxy.tls.hosts,
        ca_sha256: proxy.tls.fingerprint,
      },
    });
  }

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

  if (proxy.tls) {
    // The child trusts the run CA through its own environment and through nothing else. Nothing
    // here touches a system or browser trust store, and orca will not offer to: interception ends
    // when this process does, which is the property that makes it defensible at all.
    launch.env.HTTPS_PROXY = proxy.url;
    launch.env.https_proxy = proxy.url;
    // NODE_EXTRA_CA_CERTS *adds* to Node's trust store. The rest of these *replace* an OpenSSL
    // client's store outright, so they get the bundle — the run CA plus the public roots — or the
    // child would lose its ability to reach every host orca deliberately does not intercept.
    launch.env.NODE_EXTRA_CA_CERTS = proxy.tls.caCertPath;
    for (const variable of [
      'SSL_CERT_FILE',
      'REQUESTS_CA_BUNDLE',
      'CURL_CA_BUNDLE',
      'AWS_CA_BUNDLE',
      'DENO_CERT',
    ]) {
      launch.env[variable] = proxy.tls.caBundlePath;
    }
    // The agent also talks to the recording proxy directly over plain HTTP via the base-URL
    // variables. Sending those through the proxy as well would be a loop.
    const existing = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
    const noProxy = [existing, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
    launch.env.NO_PROXY = noProxy;
    launch.env.no_proxy = noProxy;

    out.warn('tls.intercepting', {
      hosts: proxy.tls.hosts,
      ca_sha256: proxy.tls.fingerprint,
      ca_dir: `${writer.runDir}/tls`,
    });
    out.plain('  TLS interception is on for this run. Traffic to the hosts above is decrypted,');
    out.plain('  recorded and re-encrypted; everything else is tunnelled unread. The certificate');
    out.plain('  authority is unique to this run, trusted only by the agent orca launches, and');
    out.plain('  deleted when the run ends. It is not installed anywhere.');
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

  if (mcp) {
    for (const frame of await mcp.drain()) {
      const at = frame.ts === undefined ? Number.NaN : Date.parse(frame.ts);
      const when = Number.isNaN(at) ? undefined : new Date(at);
      await writer.append({
        type: frame.direction === 'in' ? 'mcp.request' : 'mcp.response',
        actor: 'agent',
        turn: when === undefined ? turn : turnAt(at),
        ...(when === undefined ? {} : { occurredAt: when }),
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

/**
 * Extra roots the proxy will trust when it re-encrypts to a real origin.
 *
 * Interception does not switch off origin verification — that would turn a debugging aid into a
 * downgrade attack against the user. But a machine already sitting behind a corporate
 * TLS-inspecting middlebox presents a certificate signed by a root Node does not ship, and orca
 * would refuse every request. This is the way to say "that root is expected here".
 */
async function extraOriginRoots(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const configured = env.ORCA_TLS_UPSTREAM_CA;
  if (!configured) return [];
  const roots: string[] = [];
  for (const path of configured
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    roots.push(await readFile(path, 'utf8'));
  }
  return roots;
}
