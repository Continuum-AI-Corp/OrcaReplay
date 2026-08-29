import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { rewriteMcpConfig } from '@orcareplay/adapters';
import type { Output } from './out.js';

export interface McpCapture {
  /** Path to the rewritten config the agent should be pointed at. */
  configPath: string;
  rewritten: string[];
  skipped: string[];
  /** Frames observed so far, drained by the recorder. */
  drain(): Promise<McpFrameRecord[]>;
}

export interface McpFrameRecord {
  server: string;
  direction: 'in' | 'out';
  kind: string;
  method?: string;
  id?: string | number;
  raw: string;
  /**
   * RFC3339, written by the shim when the frame passed through it.
   *
   * The shim has always recorded this; the recorder simply did not read it, so every MCP event
   * landed in the trace stamped with the moment the file was drained instead of the moment the
   * call happened. Optional because a frame from an older shim will not carry one.
   */
  ts?: string;
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

/** Locate the installed shim entry point, whether running from source or from a published dist. */
function resolveShimEntry(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('@orcareplay/mcp-shim/dist/cli.js');
  } catch {
    return require.resolve('@orcareplay/mcp-shim');
  }
}

/** Exposed for the doctor command: is the shim runnable at all? */
export async function shimIsRunnable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [resolveShimEntry(), '--help'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(true));
  });
}
