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
  /**
   * How this adapter gets the agent's traffic to orca.
   *
   * `env` — the default, and what every harness-specific adapter does: point a base-URL variable
   * at the proxy, or install the fetch hook, so the agent connects to a local origin in plaintext.
   *
   * `transport` — the adapter redirects nothing and relies on `--tls-intercept`, which is applied
   * to the launched child by the run rather than by the adapter. Declared rather than inferred,
   * because "sets no base-URL variable" is otherwise indistinguishable from the broken adapter the
   * contract's `redirects-model-traffic` check exists to catch. An adapter that says `transport`
   * is asserting that pointing nowhere is the intent, and takes the check's exemption in exchange.
   */
  capture?: 'env' | 'transport';
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
  /**
   * What this harness leaves on disk that the run cannot be understood or reproduced without.
   *
   * Optional, and most harnesses need none of it: a coding agent's output *is* the working tree,
   * which the ordinary snapshot already captures. A pipeline is the case this exists for — its
   * whole product is an index or a cache, written to a path its own `.gitignore` excludes,
   * because nobody wants a hundred megabytes of vectors in their repository.
   */
  artifacts?: HarnessArtifacts;
  /**
   * Argv for a replay, for a harness that carries no prompt at all.
   *
   * {@link driveArgs} answers "what makes the agent ask the recorded question again", and it only
   * applies to a harness with a transcript orca can read. A pipeline has neither: its argv *is*
   * the whole instruction and there is nothing to recover. This hook is reached before the
   * transcript is consulted, so such an adapter can still adjust what the replay runs — clamping
   * a concurrency flag, say — instead of having no say at all.
   *
   * Return undefined to leave the recorded argv exactly as it was, which is what every adapter
   * that does not implement this gets.
   */
  replayArgs?(recorded: string[]): string[] | undefined;
}

/** Paths a harness writes that the ordinary snapshot would miss, and what to do about them. */
export interface HarnessArtifacts {
  /**
   * Paths to snapshot even when the workspace's own `.gitignore` excludes them.
   *
   * The snapshot is a `git add` against a shadow index, so it honours the workspace's ignore
   * rules — correct for a coding agent, where `node_modules/` and `dist/` are noise, and wrong
   * for a pipeline, where the ignored directory is the entire product. `vector_store/` and
   * `cache/` are the first two lines of IndexRAG's `.gitignore`, and without them a recording of
   * an indexing run holds the model calls that built an index and no trace of the index.
   *
   * It cannot be used to smuggle a secret into a trace: the sensitive pathspecs are applied to
   * this add as well, so an adapter declaring `.` still cannot capture `.env`.
   */
  capture?: readonly string[];
  /**
   * Paths to put back to the state the recording *started* in, before a replay launches.
   *
   * A pipeline resumes: it reads its own cache, sees which items are already done, and does the
   * rest. Replayed on top of the recording's finished cache it does nothing at all — every model
   * call is skipped, nothing is asked, and the replay reports a run it never reproduced. That is
   * `reused=0/6 exit=0` over a recording that was perfectly good.
   *
   * Not "delete these". Orca clears them and then restores the recording's initial snapshot over
   * the top, so they end up holding exactly what they held when recording began — which for a
   * recording of one mid-pipeline stage is a *populated* cache, and deleting that would take away
   * the stage's own input. The clearing is what the plain restore cannot do: it writes the files
   * the tree names and leaves everything else alone, so a cache the recording never had survives
   * it.
   *
   * Whole directories rather than "the invalid parts": IndexRAG's resume skips by `chunk_id`
   * including entries it recorded as failures, so keeping what looks valid silently promotes the
   * previous run's failures to completed work. Nothing is lost either way — an exact replay
   * restores the working tree when it ends, and where it will not (`--in-place`), orca says so
   * and leaves these alone.
   */
  resetBeforeReplay?: readonly string[];
  /**
   * The flag that makes this harness run one request at a time, and the value that does it.
   *
   * Declared, never applied on its own: clamping concurrency changes the run being replayed, and
   * a replay that quietly runs the pipeline differently from the recording is not a replay. It is
   * what `orca replay --serialize` reaches for when the operator asks for determinism explicitly.
   */
  concurrencyFlag?: { flag: string; serialValue: string };
}

/**
 * A non-model HTTP call whose answer is a pure function of its request.
 *
 * The proxy's own comment on passthrough says orca "holds the bytes but not the meaning, so it
 * cannot match this request on replay" — and for an embedding that is the one thing it does not
 * need. `embed(model, input)` is deterministic in a way a chat completion is not: the same text
 * to the same model is the same vector, every time, from any provider. So this class of call is
 * *replayable* without any translator, matched on the request itself rather than on a ladder.
 *
 * It is deliberately not forkable, and `forkable` is `false` rather than absent so that saying so
 * is part of the type. Substituting the embedding model would change the vector space the index
 * was built in — every stored vector would have to be recomputed, and the comparison a fork
 * exists to make ("same run, different model") would be against a different index. That is a
 * rebuild, not a fork. Changing the *chat* model over a fixed index is the useful question, and
 * it is exactly what keeping retrieval on the recording makes possible.
 */
export interface RetrievalRule {
  /** Stable id, written into the trace so a reader can tell which rule claimed a call. */
  id: string;
  /**
   * Whether this rule claims the endpoint. The path is the one the client actually appended, so
   * a base URL rewritten through `/forward/` presents as `/embeddings` rather than
   * `/v1/embeddings` — match on the suffix, not on a version segment that lives in the base.
   */
  matches(path: string, host?: string): boolean;
  /**
   * The value a replay looks this call up by. Defaults to a digest of the whole request body with
   * its keys sorted, which is the strictest honest answer: anything a caller varies is part of
   * what it asked for until a rule says otherwise.
   */
  key(raw: unknown): string;
  /** One line for the timeline — "12 texts, text-embedding-3-small". Optional. */
  describe?(raw: unknown): string;
  /**
   * How to match a batch whose items arrived in a different order, where the endpoint's own
   * contract makes that safe.
   *
   * A retrieval call is usually a *batch* — one request carrying many texts — and the order of
   * that batch is routinely accidental. IndexRAG assembles it from a thread pool that appends
   * results as they complete; LlamaIndex, GraphRAG and LightRAG all have the same shape. So two
   * runs of the same pipeline over the same documents send the same set of texts in a different
   * sequence, and a key over the request body says they asked different questions. Measured: two
   * replays of one recording produced two different keys, and neither matched what was recorded.
   *
   * This is safe here and would not be for a model call, because the API says so: OpenAI's
   * embeddings response carries `data[i].index` and defines `data[i]` as the embedding of
   * `input[i]`. An embedding does not depend on what sat next to it in the batch. So the recorded
   * answer for each text can be found and handed back against that text's new position — which is
   * not an approximation, it is the same answer to the same question.
   *
   * Optional, and absent by default on any endpoint whose contract does not guarantee that.
   */
  batch?: BatchRetrieval;
  /** Always false. See the note above: changing an embedding model is a rebuild, not a fork. */
  readonly forkable: false;
}

/** Matching a retrieval batch whose order differs, for an endpoint where order carries nothing. */
export interface BatchRetrieval {
  /**
   * A key over the request with its batch reduced to a multiset, or undefined when this request
   * is not a batch this rule can reorder — a single input, or a shape it does not recognise.
   */
  key(raw: unknown): string | undefined;
  /**
   * The recorded response rebuilt so that item *i* answers the live request's item *i*, or
   * undefined when it cannot be done exactly. Undefined halts the replay, which is the right
   * answer: a partial reorder would hand some documents another document's vector.
   */
  reorder(
    recordedRequest: unknown,
    recordedResponse: string,
    liveRequest: unknown,
  ): string | undefined;
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
