import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { rewriteMcpConfig } from '@orcareplay/adapters';
import type { TraceWriter } from '@orcareplay/core';
import type { McpFrameRecord } from '@orcareplay/mcp-shim';
import type { Output } from './out.js';

export interface McpCapture {
  /** Path to the rewritten config the agent should be pointed at. */
  configPath: string;
  rewritten: string[];
  skipped: string[];
  /** Frames observed so far, drained by the recorder. */
  drain(): Promise<McpFrameRecord[]>;
}

/**
 * A captured frame, as the shim writes it.
 *
 * Re-exported rather than redeclared. The version that used to live here named two of the same
 * fields differently — `server` for `name`, `direction` for `dir` — and since `JSON.parse` casts to
 * whatever the call site claims, nothing anywhere disagreed: every MCP event went into the trace
 * with an undefined server, and `direction === 'in'` was false for all of them, so every request
 * was recorded as a response. A format has one owner, and it is the thing that writes it.
 */
export type { McpFrameRecord };

/**
 * The MCP config a *replay* should instrument: the flag if one was given, else whatever the
 * recording itself used.
 *
 * Replay and fork launch the same agent the recording did, so they hit the same blind spot record
 * had before `--mcp-config` existed: without a config the harness either talks to servers orca
 * cannot see, or — for one that requires the variable — does not start at all. The recording knows
 * the answer; it just had nowhere to write it down, since `manifest.argv` holds only the agent's
 * own arguments and `--mcp-config` is orca's.
 *
 * The path is read back from the run's own `mcp_instrumented` note. Nothing is re-instrumented from
 * the *rewritten* config in the parent run directory: its servers already point at the parent's
 * frames file, so reusing it would append this replay's traffic to the recording it is replaying.
 */
export function mcpSourceFrom(
  flagValue: string | undefined,
  events: { type: string; attrs?: Record<string, unknown> }[],
): string | undefined {
  if (flagValue) return flagValue;
  for (const event of events) {
    if (event.type !== 'note' || event.attrs?.rule !== 'mcp_instrumented') continue;
    const source = event.attrs.source;
    if (typeof source === 'string' && source !== '') return source;
  }
  return undefined;
}

/** Did this run capture MCP at all? Decides whether a replay without a config is worth warning about. */
export function usedMcp(events: { type: string }[]): boolean {
  return events.some((e) => e.type === 'mcp.request' || e.type === 'mcp.response');
}

/**
 * Set up MCP capture for a replay or a fork, from the flag or from what the recording used.
 *
 * Returns undefined — quietly — when the run never had MCP, which is most runs. When it did and the
 * source config has since moved or been deleted, that is said out loud rather than silently
 * dropping a capture layer: an absent `mcp.*` in the replay would otherwise read as "the agent made
 * no MCP calls" instead of "orca was not looking".
 */
export async function mcpForReplay(
  args: { str(name: string): string | undefined },
  events: { type: string; attrs?: Record<string, unknown> }[],
  writer: TraceWriter,
  out: Output,
): Promise<McpCapture | undefined> {
  const source = mcpSourceFrom(args.str('mcp-config'), events);
  if (source === undefined) {
    if (usedMcp(events)) {
      out.warn('mcp.not_instrumented', {
        why: 'the recording captured MCP but did not record which config it came from',
        next: 'pass --mcp-config <path> to capture it here too',
      });
    }
    return undefined;
  }
  if (!(await stat(source).catch(() => null))) {
    out.warn('mcp.source_missing', {
      path: source,
      note: 'the config the recording used is no longer there; MCP will not be captured',
    });
    return undefined;
  }
  return setupMcpCapture({ sourceConfigPath: source, runDir: writer.runDir, out });
}

/**
 * Point the launched agent at the instrumented config.
 *
 * Every target harness reads one of these; setting all three costs nothing and avoids making the
 * user work out which one their agent uses.
 */
export function pointAtMcpConfig(env: Record<string, string>, configPath: string): void {
  env.MCP_CONFIG_PATH = configPath;
  env.CLAUDE_MCP_CONFIG = configPath;
  env.OPENCODE_MCP_CONFIG = configPath;
}

/**
 * Drain captured frames into a trace as `mcp.request` / `mcp.response`.
 *
 * Frames are read off disk after the agent exits, so each carries the moment it passed through the
 * shim and is stamped with that rather than with the drain — `mono_us` is authoritative for
 * duration (spec §2.1), and a frame stamped at the drain can never interleave with the model turns
 * it actually sat between.
 */
export async function drainMcpFrames(
  mcp: McpCapture,
  writer: TraceWriter,
  turnAt: (at: number) => number,
  fallbackTurn: number,
): Promise<void> {
  for (const frame of await mcp.drain()) {
    const at = frame.ts === undefined ? Number.NaN : Date.parse(frame.ts);
    const when = Number.isNaN(at) ? undefined : new Date(at);
    await writer.append({
      type: frame.dir === 'in' ? 'mcp.request' : 'mcp.response',
      actor: 'agent',
      turn: when === undefined ? fallbackTurn : turnAt(at),
      ...(when === undefined ? {} : { occurredAt: when }),
      attrs: { server: frame.name, kind: frame.kind, method: frame.method, id: frame.id },
      payload: frame.raw as never,
    });
  }
}

/**
 * Set up MCP capture for a run.
 *
 * The mechanism is a config rewrite, not a patch: each stdio server is relaunched through
 * `orca-mcp-shim`, a transparent JSON-RPC tee. The agent's own config file is never touched — a
 * rewritten copy goes in the run directory, and the agent is pointed at that.
 *
 * HTTP and SSE servers are deliberately left alone and reported as skipped; they route through the
 * HTTP proxy instead, and silently dropping them would be worse than not capturing them.
 */
export async function setupMcpCapture(opts: {
  sourceConfigPath: string;
  runDir: string;
  out: Output;
}): Promise<McpCapture | undefined> {
  const raw = await readFile(opts.sourceConfigPath, 'utf8').catch(() => undefined);
  if (raw === undefined) {
    opts.out.warn('mcp.config_unreadable', { path: opts.sourceConfigPath });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    opts.out.warn('mcp.config_unparseable', { path: opts.sourceConfigPath, error: String(err) });
    return undefined;
  }

  const framesPath = join(opts.runDir, 'mcp-frames.jsonl');
  const shim = resolveShimEntry();
  const { config, rewritten, skipped } = rewriteMcpConfig(parsed, process.execPath, [
    shim,
    '--out',
    framesPath,
  ]);

  const configPath = join(opts.runDir, 'mcp-config.json');
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  opts.out.info('mcp.instrumented', {
    servers: rewritten.length,
    skipped: skipped.length,
    config: configPath,
  });

  return {
    configPath,
    rewritten,
    skipped,
    async drain() {
      const text = await readFile(framesPath, 'utf8').catch(() => '');
      const records: McpFrameRecord[] = [];
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
          records.push(JSON.parse(line) as McpFrameRecord);
        } catch {
          // A malformed capture line must never break the recorder; the agent's run matters more.
        }
      }
      return records;
    },
  };
}

/**
 * Locate the installed shim entry point, whether running from source or from a published dist.
 *
 * This used to ask for `@orcareplay/mcp-shim/dist/cli.js` and fall back to `@orcareplay/mcp-shim`
 * when that threw. It always threw — the package declares an `exports` map, and an exports map
 * blocks every subpath it does not list — so the fallback ran every time and resolved to
 * `dist/index.js`, which is the library.
 *
 * The consequence was not a missing capture layer. Every stdio MCP server in the agent's config was
 * rewritten to launch that module, which exports and exits: the real server was never started at
 * all, so `--mcp-config` silently broke the agent's MCP servers *and* recorded nothing, while
 * `orca doctor` reported the shim runnable because the wrong process exited 0.
 *
 * So: one declared subpath, and no fallback that can succeed with the wrong file. A resolution
 * failure has to stay a failure — `setupMcpCapture` reports it, and the run continues without MCP
 * capture, which is the honest outcome.
 */
function resolveShimEntry(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@orcareplay/mcp-shim/cli');
}

/**
 * Exposed for the doctor command: is the shim runnable at all?
 *
 * It checks that the thing it launched *is the shim*, not merely that a process started and
 * stopped. Asking only for a clean exit is what let doctor vouch for a resolution that had landed
 * on the library: that module exits 0 having done nothing, which is indistinguishable from success
 * unless you look at what it said.
 */
export async function shimIsRunnable(): Promise<boolean> {
  let entry: string;
  try {
    entry = resolveShimEntry();
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, '--help'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => resolve(false));
    // `--help` is not a flag the shim takes, so it prints its usage and exits non-zero. That usage
    // line is the identification: any other program is not this one.
    child.on('close', () => resolve(stderr.includes('orca-mcp-shim --name')));
  });
}
