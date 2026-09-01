import { once } from 'node:events';
import { TraceReader, TraceWriter, ensureRunsDir, resolveRunSelector } from '@orcareplay/core';
import { createProxy, type RecordedExchange, type RunCa } from '@orcareplay/proxy';
import { defaultAdapters } from '@orcareplay/adapters';
import type { ParsedArgs } from '../args.js';
import type { Output } from '../out.js';
import { advertisedUrl, attachExports, attachInstructions } from '../attach.js';
import { ExchangeEventDeriver, appendDerivedEvents } from '../exchange-events.js';
import { SerialQueue } from '../serial.js';
import { planTlsCapture, recordedTlsHosts, setupTlsCapture } from '../tls-capture.js';
import { loadExchanges } from './replay.js';
import { upstreamPlan } from '../upstream.js';
import { ORCA_VERSION } from '../version.js';

/**
 * `orca attach` — record an agent this machine did not start.
 *
 * Everything else here launches the agent: an adapter builds an environment, orca spawns the
 * process, and capture follows from that. It is a good design with one boundary it cannot cross —
 * an agent that is not on this machine. A bot on a VPS, an agent inside a dev container or a cloud
 * sandbox, a harness in someone else's CI: there is no process to spawn, so there is no
 * environment to build and no way to say `orca record` at all.
 *
 * So this inverts it. Orca holds the proxy open, prints exactly what to export on the far side,
 * and records whatever arrives until it is stopped. The recording that comes out is not a lesser
 * one: same matcher, same events, same `orca replay`.
 *
 * The adapters are still what produce the variables — `--for claude` prints what the Claude Code
 * adapter would have set, pointed at the advertised address instead of a loopback one. That keeps
 * one source of truth for "which variable does this harness read", so a sandbox recording cannot
 * drift from a local one.
 */

export interface AttachResult {
  runId: string;
  runDir: string;
  modelExchanges: number;
  events: number;
  proxyUrl: string;
  /** Replay sessions only: recorded exchanges served back, and requests nothing matched. */
  reused: number;
  unmatched: number;
  /**
   * Non-zero only when a replay session could not answer something the agent asked for.
   *
   * A recording session cannot fail this way: it ends because the operator stopped it, which is
   * how it is meant to end. Whether it captured anything is reported by `capture.empty`, because
   * an empty capture is a mistake to point at rather than an error to exit on.
   */
  exitCode: number;
}

export interface AttachOptions {
  /**
   * Resolves when the session should stop. Defaults to SIGINT — the operator pressing ctrl-C,
   * which is how a session with no child process to wait on ends.
   */
  until?: Promise<void>;
  /** Called once the proxy is listening, with the address a remote agent should use. */
  onReady?: (info: { proxyUrl: string; runId: string }) => void;
}

export async function attachCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
  options: AttachOptions = {},
): Promise<AttachResult> {
  const minted: RunCa[] = [];
  try {
    return await runAttached(args, out, cwd, options, minted);
  } catch (err) {
    for (const ca of minted) await ca.dispose().catch(() => undefined);
    throw err;
  }
}

async function runAttached(
  args: ParsedArgs,
  out: Output,
  cwd: string,
  options: AttachOptions,
  minted: RunCa[],
): Promise<AttachResult> {
  const registry = defaultAdapters();
  const bind = args.str('bind') ?? '127.0.0.1';
  const advertise = args.str('advertise');
  const requestedPort = args.num('port') ?? 0;

  // Resolved before the run directory is made, so an invocation that cannot work — a wildcard bind
  // with nothing to advertise — leaves nothing behind to clean up. The port is not known yet when
  // orca is choosing one, and does not need to be: only the host can make this fail.
  advertisedUrl({
    bind,
    port: requestedPort === 0 ? 1 : requestedPort,
    ...(advertise === undefined ? {} : { advertise }),
  });

  /**
   * Serving a recording back instead of recording a new one.
   *
   * `orca replay` launches the agent, which is right for a run orca recorded by launching it and
   * impossible for one that came from a sandbox — the agent may not exist on this machine at all.
   * So replay attaches too: same proxy, same matcher, same blocked egress, and the operator points
   * the same remote agent at it.
   */
  // The parser turns a flag with no value into `true`, so a bare `--replay` — or `--replay
  // --tls-intercept`, where the next token is itself a flag — would read as absent and start a
  // *recording* session against the live provider. That is the worst direction to fail in.
  if (args.has('replay') && args.str('replay') === undefined) {
    throw new Error(
      '--replay needs the run to serve: orca attach --replay <run>, or --replay last',
    );
  }
  const replaySelector = args.str('replay');
  const replaying = replaySelector
    ? await (async () => {
        const runDir = (await resolveRunSelector(cwd, replaySelector)).dir;
        const reader = await TraceReader.open(runDir);
        return {
          exchanges: await loadExchanges(reader),
          hosts: recordedTlsHosts(await reader.events()),
          // Which harness made the recording. It will be the one connecting again, so it is the
          // right default for the block the operator pastes.
          adapter: reader.manifest().adapter?.id,
        };
      })()
    : undefined;

  /**
   * `exec` is the honest default for a fresh session: orca does not know what will connect, and
   * detecting an agent from this directory would be a guess about a machine it cannot see. For a
   * replay it is the wrong default and a useless one — `exec` sets no variables, so the block the
   * operator is meant to paste comes out empty. The recording names the harness, so use it.
   */
  const adapterName = args.str('for') ?? replaying?.adapter ?? 'exec';
  const adapter = registry.get(adapterName);

  // The last thing that can refuse the run, and it runs before the trace exists: a writer created
  // first and abandoned by a throw leaves an unsealed run directory behind, which then wins `last`
  // — so the next command someone types operates on the session that never happened.
  planTlsCapture(args, replaying?.hosts);

  const dir = await ensureRunsDir(cwd);
  const writer = await TraceWriter.create(dir, {
    adapter: { id: adapter.id, version: ORCA_VERSION, harness_version: adapter.harnessVersions },
    argv: [adapterName],
    cwd,
    orcaVersion: ORCA_VERSION,
  });

  let modelExchanges = 0;
  let turn = 0;
  let unmatched = 0;

  const writes = new SerialQueue();
  const plan = await upstreamPlan(args);
  const tls = await setupTlsCapture({
    args,
    out,
    ...(replaying ? { recordedHosts: replaying.hosts } : {}),
    writer,
    writes,
    // Out-of-band traffic belongs to whichever turn was in progress when it happened, exactly as in
    // a launched recording. A fixed 0 filed every net.* event against the start of the session.
    turn: () => turn,
  });
  if (tls.ca) minted.push(tls.ca);
  // Read before the proxy closes: `stats()` is a snapshot of a live object, and the teardown in
  // `finally` is the last moment it is still meaningful.
  let stats = {
    matchedExact: 0,
    matchedInexact: 0,
    unmatched: 0,
  } as ReturnType<Awaited<ReturnType<typeof createProxy>>['stats']>;
  const deriver = new ExchangeEventDeriver();
  const proxy = await createProxy({
    // A replay session serves the recording and blocks egress, exactly as `orca replay` does. The
    // only difference is which side starts the agent, and that is not a difference the proxy has.
    mode: replaying ? 'replay' : 'record',
    ...(replaying ? { exchanges: replaying.exchanges, loose: args.bool('loose') } : {}),
    host: bind,
    port: requestedPort,
    upstream: plan.upstream,
    upstreamHeaders: plan.headers,
    ...tls.proxyOptions,
    onUnmatched: () => {
      unmatched += 1;
    },
    onExchange: (exchange: RecordedExchange) => {
      modelExchanges += 1;
      turn += 1;
      const at = turn;
      writes.push(() => appendDerivedEvents(writer, deriver, exchange, at));
    },
  });

  const advertised = advertisedUrl({
    bind,
    port: proxy.port,
    ...(advertise === undefined ? {} : { advertise }),
  });

  try {
    const proxyUrl = advertised;

    // What the adapter would have put into a child's environment, pointed at the reachable
    // address rather than a loopback one. `runDir` is this machine's, and is only ever used by
    // adapters that write a scratch file — none of which a remote agent would read, which is why
    // `--for` is documented as the variables rather than as full instrumentation.
    const launch = await adapter.prepare({
      runId: writer.runId,
      cwd,
      runDir: writer.runDir,
      proxyUrl,
      userArgs: ['<your agent>'],
      env: process.env,
    });

    const remoteCaPath = args.str('remote-ca-path') ?? '/tmp/orca-ca.crt';
    const instructions = attachInstructions({
      proxyUrl,
      adapterEnv: launch.env,
      ...(proxy.tls
        ? {
            ca: { certPath: proxy.tls.caCertPath, bundlePath: proxy.tls.caBundlePath },
            remoteCaPath,
          }
        : {}),
    });

    out.phase('attached', {
      run: writer.runId,
      proxy: proxyUrl,
      for: adapter.id,
      ...(replaying
        ? { serving: replaySelector, exchanges: replaying.exchanges.length, egress: 'blocked' }
        : {}),
    });
    if (proxy.tls) {
      out.warn('tls.intercepting', {
        hosts: proxy.tls.hosts,
        ca_sha256: proxy.tls.fingerprint,
      });
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
    /**
     * An instruction the operator cannot act on is worse than none: the block pastes cleanly, the
     * session waits, and nothing ever connects. Both shapes of that are visible from here.
     */
    const exported = attachExports({
      proxyUrl,
      adapterEnv: launch.env,
      ...(proxy.tls
        ? {
            ca: { certPath: proxy.tls.caCertPath, bundlePath: proxy.tls.caBundlePath },
            remoteCaPath,
          }
        : {}),
    });
    if (Object.keys(exported).length === 0) {
      out.warn('attach.nothing_to_set', {
        for: adapter.id,
        cause: `${adapter.id} redirects nothing, and this session is not intercepting`,
        next: 'name the harness with --for <agent>, or add --tls-intercept',
      });
    }
    // A path under the run directory exists on this machine and nowhere else. The fetch hook is
    // the live example: `--for node` names a preload orca just wrote here, so the block would
    // instrument nothing over there while looking exactly as though it had.
    const local = Object.entries(exported)
      .filter(([, value]) => value.includes(writer.runDir))
      .map(([name]) => name);
    if (local.length > 0) {
      out.warn('attach.local_path', {
        vars: local.join(','),
        cause: `${adapter.id} instruments by writing a file here and naming it in the environment`,
        effect: 'those paths do not exist in the sandbox, so that half of the capture will not run',
        next: 'copy the named files across, or use --tls-intercept instead',
      });
    }

    out.plain('');
    for (const line of instructions) out.plain(`  ${line}`);
    out.plain('');
    out.plain(
      replaying
        ? '  Serving the recording. Press ctrl-C when the agent is done.'
        : '  Recording. Press ctrl-C when the agent is done.',
    );

    options.onReady?.({ proxyUrl, runId: writer.runId });
    await (options.until ?? firstInterrupt());
  } finally {
    stats = proxy.stats();
    await writes.drain();
    // The proxy closes after the writes drain, for the same reason recording does: a tunnel record
    // arriving after the writer shut would have nowhere to go.
    await proxy.close();
    await tls.ca?.dispose();
  }

  /**
   * The same warning a launched run gets, and it matters more here. A remote agent that was never
   * given the block — or was given it in a shell that had already started the agent — produces a
   * session that ends cleanly and records nothing, and there is no exit code to hint at it.
   */
  if (modelExchanges === 0 && !replaying) {
    out.warn('capture.empty', {
      exchanges: 0,
      cause: 'nothing connected to the proxy while the session was open',
      next: 'check the sandbox can reach the advertised address, and that the exports were set',
    });
  }

  const manifest = await writer.close(0);
  // A replay session did not record a run, and saying it did would send someone looking for turns
  // in a trace that holds none. It reports what it actually did: how much of the recording the
  // agent asked for, and what it asked for that the recording could not answer.
  if (replaying) {
    out.info('served', {
      serving: replaySelector,
      reused: `${stats.matchedExact + stats.matchedInexact}/${replaying.exchanges.length}`,
      unmatched: stats.unmatched,
    });
  } else {
    out.info('recorded', {
      run: writer.runId,
      events: manifest.counts?.events ?? 0,
      exchanges: modelExchanges,
      dir: writer.runDir,
    });
  }

  return {
    runId: writer.runId,
    runDir: writer.runDir,
    modelExchanges,
    events: manifest.counts?.events ?? 0,
    // The address the agent should use, not the one orca bound — a caller reading this from
    // `--json` needs something it can connect to, which a wildcard bind is not.
    proxyUrl: advertised,
    // Exact plus inexact: both were served from the recording, which is what "reused" means here.
    // The distinction between them is a divergence, and divergences are reported on their own.
    reused: replaying ? stats.matchedExact + stats.matchedInexact : 0,
    unmatched: replaying ? stats.unmatched : unmatched,
    exitCode: replaying && stats.unmatched > 0 ? 1 : 0,
  };
}

/** Ctrl-C, which is the only way an operator ends a session with no child process to wait on. */
async function firstInterrupt(): Promise<void> {
  await once(process, 'SIGINT');
}
