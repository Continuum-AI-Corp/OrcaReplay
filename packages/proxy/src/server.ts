import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AUTH_REQUEST_HEADERS } from '@orcareplay/core';
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
  openaiToCanonicalRequest,
  openaiToCanonicalResponse,
  parseAnthropicSse,
  parseOpenaiSse,
} from '@orcareplay/providers';
import { anthropicDialect, openaiDialect, selectDialect, type Dialect } from './dialects.js';
import { attachTlsIntercept, type NetExchange, type TlsInterceptOptions } from './intercept.js';
import { RequestMatcher, type Divergence } from './matching.js';

export type {
  InterceptFailure,
  NetExchange,
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
  divergences: number;
  liveCalls: number;
  unmatched: number;
  /** Decrypted HTTPS exchanges. Zero unless TLS interception was asked for. */
  intercepted: number;
  /** Connections passed through as opaque bytes because their host was not on the list. */
  tunnelled: number;
}

/** What a run needs to tell the operator, and to tell the child process, about interception. */
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
 */
const HOP_BY_HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding']);

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
  ];
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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
    divergences: 0,
    liveCalls: 0,
    unmatched: 0,
    intercepted: 0,
    tunnelled: 0,
  };

  // In hybrid mode only the exchanges below the fork point are replayable; everything at or above
  // it must go live, which is exactly what makes a fork a fork.
  const replayable =
    options.mode === 'hybrid' ? recorded.slice(0, options.forkAt ?? recorded.length) : recorded;
  const matcher = new RequestMatcher(replayable.map((e) => e.canonicalRequest));

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
    if (dialect && exchange.method === 'POST' && !exchange.requestTruncated) {
      try {
        const streamed = (exchange.responseHeaders['content-type'] ?? '').includes('event-stream');
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

  const interception = options.tls
    ? attachTlsIntercept(server, { ...options.tls, onNetExchange: onDecrypted }, stats)
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
    const target =
      options.forkModel === undefined
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
    const upstreamRes = await doFetch(`${origin}${upstreamPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
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
    if (!dialect || req.method !== 'POST') {
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
