import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CanonicalRequest, CanonicalResponse, Usage } from '@orcareplay/plugin-api';
import {
  anthropicToCanonicalRequest,
  anthropicToCanonicalResponse,
  openaiToCanonicalRequest,
  openaiToCanonicalResponse,
  parseAnthropicSse,
  parseOpenaiSse,
} from '@orcareplay/providers';
import { anthropicDialect, openaiDialect, selectDialect, type Dialect } from './dialects.js';
import { RequestMatcher, type Divergence } from './matching.js';

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
}

export interface ProxyStats {
  mode: ProxyMode;
  recorded: number;
  matchedExact: number;
  divergences: number;
  liveCalls: number;
  unmatched: number;
}

export interface ProxyHandle {
  url: string;
  port: number;
  stats(): ProxyStats;
  exchanges(): RecordedExchange[];
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
 */
const SECRET_REQUEST_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'proxy-authorization',
]);

export function defaultDialects(): Dialect[] {
  return [
    anthropicDialect({
      toCanonicalRequest: anthropicToCanonicalRequest,
      toCanonicalResponse: anthropicToCanonicalResponse,
      parseSse: parseAnthropicSse,
    }),
    openaiDialect({
      toCanonicalRequest: openaiToCanonicalRequest,
      toCanonicalResponse: openaiToCanonicalResponse,
      parseSse: parseOpenaiSse,
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

    let parsed: unknown = JSON.parse(rawBody);
    if (options.forkModel) parsed = dialect.withModel(parsed, options.forkModel);
    const outboundBody = JSON.stringify(parsed);

    const origin = options.upstream?.[dialect.id] ?? dialect.defaultUpstream;
    const upstreamRes = await doFetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
        ...(options.upstreamHeaders ?? {}),
      },
      body: outboundBody,
    });

    const contentType = upstreamRes.headers.get('content-type') ?? 'application/json';
    const streamed = contentType.includes('event-stream');

    res.writeHead(upstreamRes.status, { 'content-type': contentType });

    // Tee rather than buffer. A model response arrives over seconds, and reading it to completion
    // before writing a byte makes every turn of an interactive session appear to hang for its full
    // duration — the agent's own progressive rendering stops working because there is nothing
    // progressive left to render. Chunks go straight through; the copy we keep is assembled on the
    // way past, so the recording is still the complete body.
    const text = await pipeThrough(upstreamRes, res);

    // Recorded whatever the status. A run that died on rate limits used to produce a trace with no
    // evidence of it — and replay would then be short exactly the exchanges that explain the
    // failure you are trying to reproduce.
    const exchange = buildExchange({
      dialect,
      path,
      rawRequest: outboundBody,
      rawResponse: text,
      status: upstreamRes.status,
      streamed,
      headers: recordableHeaders,
      seq: captured.length,
      durationMs: Date.now() - startedAt,
    });
    captured.push(exchange);
    options.onExchange?.(exchange);
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
    close: () =>
      new Promise<void>((resolve, reject) =>
        (server as Server).close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
