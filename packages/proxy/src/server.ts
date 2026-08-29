import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type { CanonicalRequest, CanonicalResponse, Usage } from '@orcareplay/plugin-api';
import {
  anthropicToCanonicalRequest,
  anthropicToCanonicalResponse,
  parseAnthropicSse,
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

/** Headers that must never be forwarded or recorded. §7 applies to the proxy first of all. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
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
      toCanonicalRequest: anthropicToCanonicalRequest,
      toCanonicalResponse: anthropicToCanonicalResponse,
      parseSse: parseAnthropicSse,
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
    headers: Record<string, string>,
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

    const text = await upstreamRes.text();
    const contentType = upstreamRes.headers.get('content-type') ?? 'application/json';
    const streamed = contentType.includes('event-stream');

    res.writeHead(upstreamRes.status, { 'content-type': contentType });
    res.end(text);

    if (upstreamRes.ok) {
      const exchange = buildExchange({
        dialect,
        path,
        rawRequest: outboundBody,
        rawResponse: text,
        status: upstreamRes.status,
        streamed,
        headers,
        seq: captured.length,
        durationMs: Date.now() - startedAt,
      });
      captured.push(exchange);
      options.onExchange?.(exchange);
    }
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
    for (const [k, v] of Object.entries(req.headers)) {
      if (STRIPPED_REQUEST_HEADERS.has(k.toLowerCase())) continue;
      if (typeof v === 'string') headers[k] = v;
    }

    if (options.mode === 'record') {
      await goLive(dialect, path, rawBody, headers, res, startedAt);
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
        json(res, 409, {
          error: {
            type: 'orca_replay_divergence',
            message: result.reason ?? 'request does not match the recording',
            next: 'orca replay <run> --loose  # continue live from this point',
          },
        });
        return;
      }
    }

    await goLive(dialect, path, rawBody, headers, res, startedAt);
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
