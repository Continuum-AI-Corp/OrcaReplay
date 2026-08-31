import type { CanonicalChunk, CanonicalRequest, ModelInfo, Money, Usage } from './canonical.js';

/** Everything an adapter needs to know about the run it is preparing. */
export interface RecordContext {
  runId: string;
  cwd: string;
  /** Base URL of the local recording proxy, e.g. http://127.0.0.1:51733 */
  proxyUrl: string;
  /** Directory the run may write scratch config into. */
  runDir: string;
  /** Argv the user passed after the agent name. */
  userArgs: string[];
  env: Record<string, string | undefined>;
}

/** How to launch the instrumented agent. */
export interface Launch {
  command: string;
  args: string[];
  /** Environment overlay merged onto the parent environment. */
  env: Record<string, string>;
  cwd?: string;
  /** Files the adapter wrote (rewritten MCP configs, shims) for cleanup and provenance. */
  tempFiles?: string[];
}

/** How to launch and instrument one agent harness. */
export interface Adapter {
  id: string;
  /**
   * Other names this adapter answers to on the command line.
   *
   * The id is a stable internal handle written into every manifest; an alias is what a human
   * types, which is almost always the name of the binary they run. `claude-code` and `claude` are
   * the canonical example — keeping them separate means the manifest stays unambiguous while
   * `orca record claude` does what anyone would expect it to.
   */
  aliases?: readonly string[];
  /** Semver range of harness versions this adapter is tested against. */
  harnessVersions?: string;
  detect(cwd: string): Promise<boolean>;
  prepare(ctx: RecordContext): Promise<Launch>;
  /**
   * The harness's own session records, where it keeps any.
   *
   * Orca's capture layers see what a run *did*; only the harness knows what it was *asked*. A run
   * driven by hand has its prompts nowhere on the wire, so without this a replay launches an agent
   * with nothing to make it ask anything. Supplying it is what makes an interactive recording
   * replayable and forkable at all.
   */
  session?: SessionSupport;
  /**
   * Arguments that load an MCP config from a path, for a harness that takes one.
   *
   * The environment variables orca sets alongside this are read by none of the harnesses it
   * targets: Claude Code loads MCP servers from `.mcp.json`, from the user config, or from
   * `--mcp-config`, and ignores `CLAUDE_MCP_CONFIG` entirely — so `orca record --mcp-config`
   * instrumented a copy of the file and then launched an agent that never opened it. The capture
   * reported success and recorded no frames, which is the same silent shape the base-URL variables
   * had before an adapter passed those on the command line too.
   */
  mcpConfigArgs?(path: string): string[] | undefined;
  /**
   * Arguments that drive this harness through a recorded prompt with no terminal attached.
   *
   * `recorded` is the argv the run was made with, so an adapter can extend it rather than replace
   * it — the flags that shaped the recording still have to shape the replay.
   */
  driveArgs?(prompts: string[], recorded: string[]): string[] | undefined;
}

/** How to find, read and resume a harness's own session transcripts. */
export interface SessionSupport {
  /** Directory the harness writes session transcripts into, or undefined if it keeps none. */
  dir(cwd: string, env: Record<string, string | undefined>): string | undefined;
  /** Pull the session id and the user's turns out of one transcript. */
  parse(bytes: Uint8Array): { id?: string; prompts: string[] };
  /** Arguments that resume that session, for a fork continuing where the run stopped. */
  resumeArgs(id: string): string[];
}

/** How to reach a model when the replay cursor goes live. */
export interface Provider {
  id: string;
  models(): Promise<ModelInfo[]>;
  invoke(req: CanonicalRequest, signal?: AbortSignal): AsyncIterable<CanonicalChunk>;
  price(usage: Usage, model: string): Money | null;
}

export interface ProviderFactory {
  id: string;
  create(options: ProviderOptions): Provider;
}

export interface ProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}
