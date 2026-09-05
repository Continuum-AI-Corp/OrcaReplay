import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AUTH_REQUEST_HEADERS, Redactor } from '@orcareplay/core';
import type { CanonicalRequest, CanonicalResponse, Usage } from '@orcareplay/plugin-api';
import {
  anthropicToCanonicalRequest,
  anthropicToCanonicalResponse,
  canonicalToAnthropicRequest,
  canonicalToAnthropicResponse,
  canonicalToAnthropicSse,
  canonicalToOpenaiRequest,
  canonicalToOpenaiResponse,
  canonicalToOpenaiSse,
  canonicalToResponsesRequest,
  canonicalToResponsesResponse,
  canonicalToResponsesSse,
  openaiToCanonicalRequest,
  openaiToCanonicalResponse,
  parseAnthropicSse,
  parseOpenaiSse,
  parseResponsesSse,
  responsesToCanonicalRequest,
  responsesToCanonicalResponse,
} from '@orcareplay/providers';
import {
  anthropicDialect,
  codexDialect,
  openaiDialect,
  responsesDialect,
  selectDialect,
  type Dialect,
} from './dialects.js';
import {
  attachTlsIntercept,
  decodeRequestBody,
  type InterceptResponse,
  type NetExchange,
  type NetRequest,
  type TlsInterceptOptions,
} from './intercept.js';
import { RequestMatcher, type Divergence } from './matching.js';

export type {
  InterceptFailure,
  InterceptResponse,
  NetExchange,
  NetRequest,
  TlsInterceptOptions,
  TunnelRecord,
} from './intercept.js';

/**
 * The interception point.
 *
 * Exact, fork and compare are not three subsystems — they are this one server with a cursor: the
 * position in the recorded stream where it stops serving from disk and starts serving from the
 * network. `record` puts the cursor before everything, `replay` after everything, `hybrid` at
 * `forkAt`.
 */

export type ProxyMode = 'record' | 'replay' | 'hybrid';

/**
 * Beta flags that belong to the model that was recorded, not to the request.
 *
 * `anthropic-beta` is a header, so substituting a model in the body leaves it untouched — and a
 * fork of a run made on a 1M-context model onto one without that entitlement comes back
 * `400 The long context beta is not yet available for this subscription`. The failure names the
 * subscription rather than the flag, so it reads as an account problem and not as orca carrying
 * over something it should have dropped.
 *
 * Only entitlement-gated flags are removed. The rest of the header is what the harness needs to
 * speak its own protocol — tool shapes, output formats — and dropping those would break the fork
 * in a way that is much harder to see than a 400.
 */
const MODEL_GATED_BETAS = [/^context-\d+m\b/i];

/** `anthropic-beta` with the recorded model's entitlements taken out, or undefined if empty. */
export function betasForModelChange(value: string): string | undefined {
  const kept = value
    .split(',')
    .map((flag) => flag.trim())
    .filter((flag) => flag !== '' && !MODEL_GATED_BETAS.some((re) => re.test(flag)));
  return kept.length > 0 ? kept.join(',') : undefined;
}

/** The outbound headers for a live call, reconciled with a model the recording did not use. */
function headersForModel(
  headers: Record<string, string>,
  forkModel: string | undefined,
): Record<string, string> {
  if (forkModel === undefined) return headers;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'anthropic-beta') {
      out[key] = value;
      continue;
    }
    const kept = betasForModelChange(value);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

export interface RecordedExchange {
  seq: number;
  dialect: string;
  path: string;
  /** Verbatim request body. Keeping it is what makes exact replay exact. */
  rawRequest: string;
  /** Verbatim response body, SSE included. */
  rawResponse: string;
  status: number;
  streamed: boolean;
  canonicalRequest: CanonicalRequest;
  canonicalResponse?: CanonicalResponse;
  usage?: Usage;
  requestHeaders?: Record<string, string>;
  durationMs?: number;
}

export interface ProxyOptions {
  mode: ProxyMode;
  /** Recorded exchanges, for replay and hybrid. */
  exchanges?: RecordedExchange[];
  /** Index at which hybrid mode stops replaying and goes live. */
  forkAt?: number;
  /** Model to substitute on live requests — the whole point of `--model` on a fork. */
  forkModel?: string;
  /** Continue live instead of halting when replay finds no match. */
  loose?: boolean;
  upstream?: Record<string, string>;
  dialects?: Dialect[];
  onExchange?: (e: RecordedExchange) => void;
  onDivergence?: (d: Divergence & { seq: number }) => void;
  /** Called once per live call that carried a model substitution. See {@link RouteDecision}. */
  onRoute?: (decision: RouteDecision) => void;
  /**
   * Called when strict replay refuses a request. Separate from `onDivergence` because it is not a
   * divergence: nothing was served, and the run is over. A count alone leaves the operator staring
   * at `unmatched: 12` with no reason, which is how this failure stayed invisible.
   */
  onUnmatched?: (u: { seq: number; index: number; reason: string }) => void;
  fetchImpl?: typeof fetch;
  host?: string;
  port?: number;
  /** Extra headers to attach to live upstream calls (an API key the agent never saw). */
  upstreamHeaders?: Record<string, string>;
  /**
   * Where to send a POST whose path no dialect claims.
   *
   * Orca pointed the harness's base URL at itself, so every call the harness makes arrives here —
   * including the ones orca has no translator for. Refusing those does not mean "not captured", it
   * means the agent gets an error for a call that would have worked, from a tool whose whole job is
   * not to change the run it is watching. Left unset, an origin is inferred; see `passthroughOrigin`.
   */
  passthroughUpstream?: string;
  /**
   * An exchange orca forwarded but could not interpret.
   *
   * Deliberately the same type the TLS interceptor reports unrecognised traffic with, so both
   * arrive in the trace as `net.request` / `net.response` and a reader does not have to learn a
   * second shape for the same fact. TLS traffic keeps reporting through `tls.onNetExchange`; this
   * is the plain-HTTP channel, so a caller wiring both never sees one exchange twice.
   */
  onNetExchange?: (e: NetExchange) => void;
  /**
   * Terminate TLS for a named set of hosts, for a harness that ignores base-URL variables.
   *
   * Absent by default, and absence is the whole safety story: with no `tls` block the server
   * registers no `'connect'` listener at all, so there is no code path that could decrypt
   * anything. Opting in is what creates the capability.
   */
  tls?: TlsInterceptOptions;
}

export interface ProxyStats {
  mode: ProxyMode;
  recorded: number;
  matchedExact: number;
  /** Served from the recording, but only after the ladder had to approximate. */
  matchedInexact: number;
  divergences: number;
  liveCalls: number;
  unmatched: number;
  /** Decrypted HTTPS exchanges. Zero unless TLS interception was asked for. */
  intercepted: number;
  /** Connections passed through as opaque bytes because their host was not on the list. */
  tunnelled: number;
  /** Requests forwarded on a path no dialect claims — captured, but not replayable. */
  passedThrough: number;
}

/** What a run needs to tell the operator, and to tell the child process, about interception. */
/**
 * One routing decision: which model, which wire format serves it, and where it was sent.
 *
 * `recorded` is the dialect the agent's own request used, which is what makes a cross-provider fork
 * legible — without it, "target: openai" leaves a reader unable to tell a substitution from a run
 * that was OpenAI all along.
 */
export interface RouteDecision {
  model: string;
  /** Dialect that will serve it. */
  target: string;
  /** Dialect the agent's request arrived in. */
  recorded: string;
  origin: string;
  crossProvider: boolean;
  reason: string;
}

export interface TlsInterceptInfo {
  /** The hosts that will be decrypted, as written. */
  hosts: string;
  /** SHA-256 of the run CA, so the certificate on disk can be matched to this run. */
  fingerprint: string;
  caCertPath: string;
  /** The run CA plus the system roots, for clients whose trust variable replaces the store. */
  caBundlePath: string;
}

export interface ProxyHandle {
  url: string;
  port: number;
  stats(): ProxyStats;
  exchanges(): RecordedExchange[];
  /** Present only when TLS interception is on. */
  tls?: TlsInterceptInfo;
  close: () => Promise<void>;
}

/**
 * Hop-by-hop headers, dropped before forwarding because they describe *this* connection.
 *
 * The full RFC 7230 §6.1 set, plus `host` and `accept-encoding`, which describe this hop for the
 * same reason. `transfer-encoding` is the one that was missing and the one that bites: an SDK
 * that hands `fetch` a `Request` — or any stream body — sends `transfer-encoding: chunked` and no
 * `content-length`, and orca then copied that header onto an outbound call whose body it had
 * already buffered. undici refuses the contradiction, so the agent got
 * `500 {"error":{"message":"TypeError: fetch failed"}}` on every such turn, with nothing in the
 * message pointing at a header, at orca, or at the agent.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
]);

/**
 * Auth material. Forwarded upstream — an agent that cannot authenticate is an agent that cannot
 * run — but never written into a trace. Claude Code under a subscription login sends its own
 * `authorization: Bearer` and ignores any injected key, so dropping these would break it outright.
 * §7 says never *write* auth material, which is a different requirement from never relaying it.
 *
 * From core, not restated here: this list had drifted from the interceptor's copy of it, and the
 * two headers only the interceptor knew about were an Azure key and a Google one.
 */
const SECRET_REQUEST_HEADERS = new Set(AUTH_REQUEST_HEADERS);

export function defaultDialects(): Dialect[] {
  return [
    codexDialect(),
    anthropicDialect({
      toCanonicalRequest: anthropicToCanonicalRequest,
      toCanonicalResponse: anthropicToCanonicalResponse,
      parseSse: parseAnthropicSse,
      fromCanonicalRequest: canonicalToAnthropicRequest,
      fromCanonicalResponse: canonicalToAnthropicResponse,
      toSse: canonicalToAnthropicSse,
    }),
    openaiDialect({
      toCanonicalRequest: openaiToCanonicalRequest,
      toCanonicalResponse: openaiToCanonicalResponse,
      parseSse: parseOpenaiSse,
      fromCanonicalRequest: canonicalToOpenaiRequest,
      fromCanonicalResponse: canonicalToOpenaiResponse,
      toSse: canonicalToOpenaiSse,
    }),
    // After the chat dialect deliberately: see the note on `responsesDialect`.
    responsesDialect({
      toCanonicalRequest: responsesToCanonicalRequest,
      toCanonicalResponse: responsesToCanonicalResponse,
      parseSse: parseResponsesSse,
      fromCanonicalRequest: canonicalToResponsesRequest,
      fromCanonicalResponse: canonicalToResponsesResponse,
      toSse: canonicalToResponsesSse,
    }),
  ];
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Is this something a dialect could parse at all? Cheap guard, run before anything is forwarded. */
function isReadable(rawBody: string): boolean {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

export async function createProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const dialects = options.dialects ?? defaultDialects();
  const doFetch = options.fetchImpl ?? fetch;
  const recorded = options.exchanges ?? [];
  const captured: RecordedExchange[] = [];

  const stats: ProxyStats = {
    mode: options.mode,
    recorded: recorded.length,
    matchedExact: 0,
    matchedInexact: 0,
    divergences: 0,
    liveCalls: 0,
    unmatched: 0,
    intercepted: 0,
    tunnelled: 0,
    passedThrough: 0,
  };

  // In hybrid mode only the exchanges below the fork point are replayable; everything at or above
  // it must go live, which is exactly what makes a fork a fork.
  const replayable =
    options.mode === 'hybrid' ? recorded.slice(0, options.forkAt ?? recorded.length) : recorded;
  // The recorded requests carry placeholders where secrets were; a live replay request carries the
  // secrets themselves. Without a redactor on this side the two are never in the same
  // representation, and a recording of any real harness — whose own system prompt carries a
  // session id — cannot match itself.
  const matcher = new RequestMatcher(
    replayable.map((e) => e.canonicalRequest),
    { redactor: new Redactor() },
  );

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      json(res, 500, { error: { message: String(err) } });
    });
  });

  /**
   * A decrypted exchange that turns out to be a model call is recorded as one.
   *
   * This is the reason the feature exists rather than a refinement of it: a harness that ignores
   * base-URL variables produces a trace indistinguishable from one captured the ordinary way,
   * which means replay, fork and compare all work on it. Anything the dialects do not recognise
   * falls through to `net.request` / `net.response`, where it is described but not interpreted.
   */
  function onDecrypted(exchange: NetExchange): void {
    const dialect = selectDialect(dialects, exchange.path);
    // `status === 0` means no response header was ever seen: the client abandoned the call before
    // the origin answered. The request is still worth keeping -- it is what the agent asked --
    // but a model exchange with no response is not one, and inserting it in the replay set gives
    // the matcher an entry that can answer nothing and cannot be forked. It goes below as network
    // traffic instead, which is what it is.
    if (
      dialect &&
      exchange.method === 'POST' &&
      !exchange.requestTruncated &&
      exchange.status !== 0
    ) {
      try {
        // Codex's HTTPS fallback currently labels this SSE body as application/json. The wire
        // framing is authoritative when the provider header is not, otherwise we lose the
        // canonical response and replay sends the right bytes with the wrong content type.
        const streamed =
          (exchange.responseHeaders['content-type'] ?? '').includes('event-stream') ||
          exchange.responseBody.startsWith('event:');
        const built = buildExchange({
          dialect,
          path: exchange.path,
          rawRequest: exchange.requestBody,
          rawResponse: exchange.responseBody,
          status: exchange.status,
          streamed,
          headers: exchange.requestHeaders,
          seq: captured.length,
          durationMs: exchange.durationMs,
        });
        captured.push(built);
        options.onExchange?.(built);
        return;
      } catch {
        // Not a model call after all — a path that merely looks like one, or a body this dialect
        // cannot read. Describing it as plain network traffic is honest; guessing is not.
      }
    }
    options.tls?.onNetExchange?.(exchange);
  }

  /**
   * Replay hook for requests inside an intercepted TLS session. The ordinary HTTP proxy reaches
   * `handle()` below, but the TLS interceptor has already terminated the outer CONNECT and needs
   * the same matcher before it opens an origin connection.
   */
  function onInterceptedRequest(request: NetRequest): InterceptResponse | undefined {
    const path = request.path.split('?')[0] ?? '/';
    const dialect = selectDialect(dialects, path);
    if (!dialect || request.method !== 'POST' || request.requestTruncated) return undefined;

    let rawBody: string;
    try {
      rawBody = decodeRequestBody(request.requestBytes, request.requestHeaders['content-encoding']);
    } catch (err) {
      if (options.mode !== 'replay' || !options.loose) {
        stats.unmatched += 1;
        return replayError(`cannot decode intercepted request body: ${String(err)}`);
      }
      return undefined;
    }

    const result = tryReplay(dialect, rawBody);
    if (result?.exchange) {
      return {
        status: result.exchange.status,
        headers: {
          'content-type': result.exchange.streamed ? 'text/event-stream' : 'application/json',
        },
        body: result.exchange.rawResponse,
      };
    }
    if (result?.error) return replayError(result.error);
    return undefined;
  }

  function tryReplay(
    dialect: Dialect,
    rawBody: string,
  ): { exchange?: RecordedExchange; error?: string } | undefined {
    let canonical: CanonicalRequest;
    try {
      canonical = dialect.toCanonicalRequest(JSON.parse(rawBody));
    } catch (err) {
      return { error: `unparseable request body: ${String(err)}` };
    }

    const beyondFork =
      options.mode === 'hybrid' && matcher.cursor >= (options.forkAt ?? replayable.length);
    if (beyondFork) return undefined;

    const result = matcher.match(canonical);
    if (result.matched) {
      const exchange = replayable[result.index]!;
      if (result.divergence) {
        stats.matchedInexact += 1;
        stats.divergences += 1;
        options.onDivergence?.({ ...result.divergence, seq: exchange.seq });
      } else {
        stats.matchedExact += 1;
      }
      return { exchange };
    }

    stats.unmatched += 1;
    if (options.mode === 'hybrid' || options.loose) {
      stats.divergences += 1;
      options.onDivergence?.({
        level: 'major',
        rung: 4,
        distance: -1,
        detail: result.reason ?? 'request does not match the recording; served live instead',
        seq: replayable[result.index]?.seq ?? -1,
      });
      return undefined;
    }
    const reason = result.reason ?? 'request does not match the recording';
    options.onUnmatched?.({
      seq: replayable[result.index]?.seq ?? -1,
      index: result.index,
      reason,
    });
    return { error: `orca: replay halted — ${reason}` };
  }

  function replayError(message: string): InterceptResponse {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            `${message}. Re-run with \`orca replay <run> --loose\` to continue live from this point, ` +
            'or `orca show <run>` to see what was recorded.',
        },
      }),
    };
  }

  const interception = options.tls
    ? attachTlsIntercept(
        server,
        {
          ...options.tls,
          ...(options.mode === 'record' ? {} : { onRequest: onInterceptedRequest }),
          onNetExchange: onDecrypted,
        },
        stats,
      )
    : undefined;

  async function goLive(
    dialect: Dialect,
    path: string,
    rawBody: string,
    /** Sent upstream, auth included. */
    headers: Record<string, string>,
    /** Written to the trace, auth removed. */
    recordableHeaders: Record<string, string>,
    res: ServerResponse,
    startedAt: number,
  ): Promise<void> {
    stats.liveCalls += 1;

    // Which dialect actually serves the model we are about to ask for. Without this the origin
    // came from the *recorded* request, so forking an Anthropic run onto gpt-5.2 posted an
    // Anthropic body to api.anthropic.com naming a model that does not exist there — the
    // cross-provider comparison the tool is pitched on could not have worked.
    // The recorded dialect wins whenever it can serve the model, and only then do we go looking.
    // Two dialects now share a provider — chat completions and Responses both answer for anything
    // that is not Claude — so a bare `find` would route every Responses fork to chat completions
    // and translate a turn that never needed translating.
    const target =
      options.forkModel === undefined || dialect.ownsModel(options.forkModel)
        ? dialect
        : (dialects.find((d) => d.ownsModel(options.forkModel!)) ?? dialect);
    const crossProvider = target.id !== dialect.id;

    let parsed: unknown = JSON.parse(rawBody);
    if (crossProvider) {
      // Through canonical, which is the only representation both dialects agree on.
      const canonical = dialect.toCanonicalRequest(parsed);
      parsed = target.fromCanonicalRequest({ ...canonical, model: options.forkModel! });
    } else if (options.forkModel) {
      parsed = dialect.withModel(parsed, options.forkModel);
    }
    const outboundBody = JSON.stringify(parsed);

    // Prefer an override for the provider we are actually calling; fall back to the override for
    // the recorded provider before the vendor default. That fallback is the gateway case, and it
    // is the common one: someone who passed --upstream-anthropic pointed *this run* at a specific
    // origin, and a gateway serves both dialects from it. Going to api.openai.com instead because
    // the fork changed model would ignore an instruction the user gave explicitly.
    const origin =
      options.upstream?.[target.id] ?? options.upstream?.[dialect.id] ?? target.defaultUpstream;
    const upstreamPath = crossProvider ? target.requestPath : path;

    // Spec §2: "a gateway chose a model". Orca *is* the gateway on this path — it substitutes the
    // model, picks the wire format that serves it, and picks the origin — and it was making all
    // three of those choices silently. Which is the one thing a comparison must not do: reading
    // `claude-opus-5 vs gpt-5.2` in a verdict table tells you nothing about where either went, and
    // a fork that quietly fell back to the recorded provider's origin looked identical to one that
    // did not. Emitted only when a decision was actually taken, so an ordinary recording — where
    // orca forwards what it was given — stays free of an event saying "nothing was chosen".
    if (options.forkModel !== undefined) {
      options.onRoute?.({
        model: options.forkModel,
        target: target.id,
        recorded: dialect.id,
        origin,
        crossProvider,
        // Deliberately does not open with the model name: the viewer already renders that as the
        // row's label, so a reason that repeats it produces `gpt-5.2  gpt-5.2 is served by…` and
        // spends the row's width saying the same thing twice.
        reason: crossProvider
          ? `served by ${target.id}, not the recorded ${dialect.id}`
          : `served by the recorded dialect ${dialect.id}`,
      });
    }
    const upstreamRes = await doFetch(`${origin}${upstreamPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headersForModel(headers, options.forkModel),
        ...(options.upstreamHeaders ?? {}),
      },
      body: outboundBody,
    });

    const upstreamType = upstreamRes.headers.get('content-type') ?? 'application/json';
    const upstreamStreamed = upstreamType.includes('event-stream');

    // The agent asked one provider and must be answered in that provider's shape, whatever served
    // the request. Handing an agent a `chat.completion` body it cannot parse is indistinguishable
    // from the model having failed.
    //
    // A cross-provider reply cannot be teed: translating it means having all of it, so this path
    // buffers where the same-provider path streams. That is a real cost and it only applies to a
    // fork that deliberately changed provider — the recording path, which is what an interactive
    // session runs through, still streams.
    if (crossProvider) {
      const raw = await upstreamRes.text();
      const canonical = upstreamStreamed
        ? target.parseStream(raw)
        : target.toCanonicalResponse(JSON.parse(raw));
      // Match the shape the agent asked for, not the shape the other provider happened to send.
      const wantsStream = requestedStream(rawBody);
      const body = dialect.fromCanonicalResponse(canonical, wantsStream);
      res.writeHead(upstreamRes.status, {
        'content-type': wantsStream ? 'text/event-stream' : 'application/json',
      });
      res.end(body);
      recordExchange(body, upstreamRes.status, wantsStream);
      return;
    }

    const contentType = upstreamType;
    const streamed = upstreamStreamed;

    res.writeHead(upstreamRes.status, { 'content-type': contentType });

    // Tee rather than buffer. A model response arrives over seconds, and reading it to completion
    // before writing a byte makes every turn of an interactive session appear to hang for its full
    // duration — the agent's own progressive rendering stops working because there is nothing
    // progressive left to render. Chunks go straight through; the copy we keep is assembled on the
    // way past, so the recording is still the complete body.
    const text = await pipeThrough(upstreamRes, res);

    recordExchange(text, upstreamRes.status, streamed);

    /**
     * Recorded whatever the status. A run that died on rate limits used to produce a trace with no
     * evidence of it — and replay would then be short exactly the exchanges that explain the
     * failure you are trying to reproduce.
     *
     * The recorded body is what the *agent* received, so a cross-provider fork replays as a run of
     * the dialect the agent speaks. Recording the other provider's bytes would produce a trace
     * that no adapter could replay.
     */
    function recordExchange(rawResponse: string, status: number, isStreamed: boolean): void {
      const exchange = buildExchange({
        dialect,
        path,
        rawRequest: outboundBody,
        rawResponse,
        status,
        streamed: isStreamed,
        headers: recordableHeaders,
        seq: captured.length,
        durationMs: Date.now() - startedAt,
      });
      captured.push(exchange);
      options.onExchange?.(exchange);
    }
  }

  /**
   * Where a request orca could not read should have gone.
   *
   * Explicit first, then the gateway: someone who pointed this run at one origin pointed *all* of
   * it there, and splitting a run across two origins because orca could not read one call is not a
   * choice they made. Only then the guess — and the guess is narrow, because it is not choosing a
   * destination so much as restoring one. Orca took this request away from a provider by rewriting
   * a base URL; the client's own headers say which provider that was, and its own credential is
   * already on the request addressed to them.
   */
  function passthroughOrigin(headers: Record<string, string>): string {
    if (options.passthroughUpstream !== undefined) return options.passthroughUpstream;
    const configured = [...new Set(Object.values(options.upstream ?? {}))];
    if (configured.length === 1) return configured[0]!;
    const names = new Set(Object.keys(headers).map((h) => h.toLowerCase()));
    // `x-api-key` alongside the version headers: this request carries the caller's own credential,
    // and a wrong guess does not merely fail — it hands one vendor a key issued by another.
    // Anthropic's client is the one that announces itself, so absence of a signal means OpenAI.
    const anthropic =
      names.has('anthropic-version') || names.has('anthropic-beta') || names.has('x-api-key');
    return anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com';
  }

  /**
   * Forward a POST no dialect claims, and record that it happened.
   *
   * It is recorded as `NetExchange` rather than `RecordedExchange` on purpose: orca holds the bytes
   * but not the meaning, so it cannot match this request on replay or rewrite its model on a fork.
   * Filing it with the model exchanges would inflate `reused=n/m` with turns replay will never
   * serve, and an operator would be reading a fidelity number that is not one.
   */
  async function passThrough(
    path: string,
    rawBody: string,
    headers: Record<string, string>,
    recordableHeaders: Record<string, string>,
    res: ServerResponse,
    startedAt: number,
  ): Promise<void> {
    // `hybrid` is a fork, and a fork runs a live agent — so it forwards, exactly as `record` does.
    // Refusing here killed the fork on the first call orca could not read, which is the failure
    // passthrough exists to prevent, reintroduced one mode over.
    if (options.mode === 'replay') {
      // Strict replay has the network blocked and no recording to serve from — orca never
      // understood this call well enough to match it. Say so: a bare 502 mid-replay reads as orca
      // being broken, when the honest fact is narrower and more useful than that.
      stats.unmatched += 1;
      const reason =
        `${path} was captured as opaque network traffic, not as a model exchange, so it ` +
        'cannot be replayed. Recorded with --tls-intercept, or on a path no dialect claims.';
      options.onUnmatched?.({ seq: -1, index: -1, reason });
      json(res, 502, { error: { message: `orca replay cannot reproduce ${path}: ${reason}` } });
      return;
    }

    stats.passedThrough += 1;
    const origin = passthroughOrigin(headers);
    const upstreamRes = await doFetch(`${origin}${path}`, {
      method: 'POST',
      // `upstreamHeaders` too, as `goLive` does. Omitting them sent a gateway the agent's own
      // credential — often the `orca-recorded` placeholder — and the call came back 401 for a
      // reason nothing in the trace explained.
      headers: {
        'content-type': 'application/json',
        ...headers,
        ...(options.upstreamHeaders ?? {}),
      },
      body: rawBody,
    });

    const responseHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    res.writeHead(upstreamRes.status, {
      'content-type': responseHeaders['content-type'] ?? 'application/json',
    });
    const body = await pipeThrough(upstreamRes, res);

    let host = origin;
    let port = 443;
    try {
      const url = new URL(origin);
      host = url.hostname;
      port = url.port !== '' ? Number(url.port) : url.protocol === 'http:' ? 80 : 443;
    } catch {
      // An origin that does not parse is still worth recording under the string we were given.
    }
    options.onNetExchange?.({
      host,
      port,
      method: 'POST',
      path,
      // `recordableHeaders`, never `headers`: the auth material was forwarded a moment ago and
      // must not now be written down. §7 says never write it, which is not the same as never relay it.
      requestHeaders: recordableHeaders,
      requestBody: rawBody,
      requestTruncated: false,
      status: upstreamRes.status,
      responseHeaders,
      responseBody: body,
      responseTruncated: false,
      responseBytes: Buffer.byteLength(body),
      durationMs: Date.now() - startedAt,
    });
  }

  /** Did the agent ask for a stream? Both dialects spell it the same way. */
  function requestedStream(rawBody: string): boolean {
    try {
      return (JSON.parse(rawBody) as { stream?: unknown }).stream === true;
    } catch {
      return false;
    }
  }

  /**
   * Forward an upstream body to the client as it arrives, returning the complete text.
   *
   * `Response.body` is absent in a couple of legitimate cases — a 204, and any stubbed Response
   * built without one — so fall back to buffering rather than failing: the point is never to lose
   * the recording.
   */
  async function pipeThrough(upstream: Response, res: ServerResponse): Promise<string> {
    const body = upstream.body;
    if (!body) {
      const text = await upstream.text();
      res.end(text);
      return text;
    }

    const decoder = new TextDecoder();
    const reader = body.getReader();
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        // Backpressure: if the socket says it is full, wait for it rather than buffering in memory
        // on the agent's behalf.
        if (!res.write(value)) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
      text += decoder.decode();
    } finally {
      res.end();
    }
    return text;
  }

  function buildExchange(input: {
    dialect: Dialect;
    path: string;
    rawRequest: string;
    rawResponse: string;
    status: number;
    streamed: boolean;
    headers: Record<string, string>;
    seq: number;
    durationMs: number;
  }): RecordedExchange {
    const canonicalRequest = input.dialect.toCanonicalRequest(JSON.parse(input.rawRequest));
    let canonicalResponse: CanonicalResponse | undefined;
    try {
      canonicalResponse = input.streamed
        ? input.dialect.parseStream(input.rawResponse)
        : input.dialect.toCanonicalResponse(JSON.parse(input.rawResponse));
    } catch {
      // An unparseable response is still worth recording verbatim — the raw bytes are the
      // authoritative record, and a canonical view we could not build is not a reason to lose them.
      canonicalResponse = undefined;
    }
    return {
      seq: input.seq,
      dialect: input.dialect.id,
      path: input.path,
      rawRequest: input.rawRequest,
      rawResponse: input.rawResponse,
      status: input.status,
      streamed: input.streamed,
      canonicalRequest,
      canonicalResponse,
      usage: canonicalResponse?.usage,
      requestHeaders: input.headers,
      durationMs: input.durationMs,
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    if (path === '/__orca/health') {
      json(res, 200, { ok: true, ...stats });
      return;
    }

    const dialect = selectDialect(dialects, path);
    // Only a POST is ever a model call. Relaxing this to `!dialect && …` let a PUT or a DELETE on
    // a dialect path through to `goLive`, which forwarded it upstream and recorded it as a model
    // exchange; and it turned `GET /v1/messages` into a 400 about unreadable JSON rather than the
    // honest answer. Method first, then passthrough decides what to do with a POST orca cannot read.
    if (req.method !== 'POST') {
      json(res, 404, {
        error: { message: `orca proxy does not handle ${req.method ?? 'GET'} ${path}` },
      });
      return;
    }

    const rawBody = await readBody(req);
    const headers: Record<string, string> = {};
    const recordableHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(key)) continue;
      if (typeof v !== 'string') continue;
      headers[k] = v;
      if (!SECRET_REQUEST_HEADERS.has(key)) recordableHeaders[k] = v;
    }

    if (!dialect) {
      await passThrough(path, rawBody, headers, recordableHeaders, res, startedAt);
      return;
    }

    // Parsed here rather than inside `goLive`, which read it unguarded — so a body orca could not
    // read reached the server's catch-all and came back as `500 SyntaxError: …`. To whoever is
    // running the agent that reads as orca falling over, and sends them to orca's issue tracker
    // instead of to the line of their own harness that sent it. Replay already answered 400.
    if (!isReadable(rawBody)) {
      json(res, 400, {
        error: {
          message:
            `orca proxy could not read the body of POST ${path}: expected JSON, got ` +
            `${rawBody === '' ? 'an empty body' : `${rawBody.length} bytes that do not parse`}`,
        },
      });
      return;
    }

    if (options.mode === 'record') {
      await goLive(dialect, path, rawBody, headers, recordableHeaders, res, startedAt);
      return;
    }

    // Replay and hybrid: try the recording first.
    let canonical: CanonicalRequest;
    try {
      canonical = dialect.toCanonicalRequest(JSON.parse(rawBody));
    } catch (err) {
      json(res, 400, { error: { message: `unparseable request body: ${String(err)}` } });
      return;
    }

    const beyondFork =
      options.mode === 'hybrid' && matcher.cursor >= (options.forkAt ?? replayable.length);

    if (!beyondFork) {
      const result = matcher.match(canonical);
      if (result.matched) {
        const exchange = replayable[result.index]!;
        if (result.divergence) {
          stats.matchedInexact += 1;
          stats.divergences += 1;
          options.onDivergence?.({ ...result.divergence, seq: exchange.seq });
        } else {
          stats.matchedExact += 1;
        }
        res.writeHead(exchange.status, {
          'content-type': exchange.streamed ? 'text/event-stream' : 'application/json',
        });
        res.end(exchange.rawResponse);
        return;
      }

      stats.unmatched += 1;

      // Hybrid mode is *supposed* to continue live here — that is what forking means — but spec §4
      // says replay must not silently approximate, and every inexact match is an event in the
      // trace. Without this a fork could start diverging below its own fork point and every
      // artifact it produced would look clean. Going live is the right behaviour; being quiet
      // about it is not.
      if (options.mode === 'hybrid' || options.loose) {
        stats.divergences += 1;
        options.onDivergence?.({
          level: 'major',
          rung: 4,
          distance: -1,
          detail: result.reason ?? 'request does not match the recording; served live instead',
          seq: replayable[result.index]?.seq ?? -1,
        });
      }

      if (!options.loose && options.mode === 'replay') {
        // Halt loudly. Inventing a reply here would make every downstream conclusion worthless.
        const reason = result.reason ?? 'request does not match the recording';
        options.onUnmatched?.({
          seq: replayable[result.index]?.seq ?? -1,
          index: result.index,
          reason,
        });

        // 400, emphatically not 409. Every mainstream client retries 408/409/429/5xx by default,
        // so a 409 halt is re-sent until the retry budget is gone — the operator gets a stalled
        // terminal and no reason, which is strictly worse than a wrong answer because it looks
        // like a hang in orca rather than a mismatch in the recording. 400 is terminal everywhere.
        //
        // The envelope is the provider's own error shape for the same reason: clients read
        // `error.message` and print it, so this sentence is what actually reaches the human.
        json(res, 400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              `orca: replay halted — ${reason}. ` +
              'Re-run with `orca replay <run> --loose` to continue live from this point, ' +
              'or `orca show <run>` to see what was recorded.',
          },
        });
        return;
      }
    }

    await goLive(dialect, path, rawBody, headers, recordableHeaders, res, startedAt);
  }

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://${host}:${port}`,
    port,
    stats: () => ({ ...stats }),
    exchanges: () => captured.slice(),
    ...(options.tls && interception
      ? {
          tls: {
            hosts: interception.policy.describe(),
            fingerprint: options.tls.ca.fingerprint,
            caCertPath: options.tls.ca.certPath,
            caBundlePath: options.tls.ca.bundlePath,
          },
        }
      : {}),
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Tunnels and decrypted sessions are long-lived by design, and `close` waits for every
        // open connection. Without this a recorded run would hang on exit behind an agent's idle
        // keep-alive socket.
        interception?.close();
        (server as Server).close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
