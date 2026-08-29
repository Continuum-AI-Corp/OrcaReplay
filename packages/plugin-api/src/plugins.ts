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
  /** Semver range of harness versions this adapter is tested against. */
  harnessVersions?: string;
  detect(cwd: string): Promise<boolean>;
  prepare(ctx: RecordContext): Promise<Launch>;
  /** Harness-internal state a fork must restore, where the harness exposes it. */
  sessionState?(ctx: RecordContext): Promise<Uint8Array | undefined>;
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
