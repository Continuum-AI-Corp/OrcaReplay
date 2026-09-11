import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AUTH_REQUEST_HEADERS, Redactor } from '@orcareplay/core';
import type {
  CanonicalRequest,
  CanonicalResponse,
  RetrievalRule,
  Usage,
} from '@orcareplay/plugin-api';
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
import { decodeForwardPath, type ForwardPath } from './forward.js';
import {
  consume,
  defaultRetrievalRules,
  indexRetrievals,
  selectRetrievalRule,
  type RecordedRetrieval,
  type RetrievalStore,
} from './retrieval.js';
import {
  attachTlsIntercept,
  decodeBody,
  type InterceptDecision,
  type InterceptResponse,
  type NetExchange,
  type NetRequest,
  type TlsInterceptOptions,
} from './intercept.js';
import { RequestMatcher, type Divergence } from './matching.js';

export type {
  InterceptDecision,
  InterceptFailure,
  InterceptForward,
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

/**
 * An origin with the parts a credential rides in taken out.
 *
 * `orca setup --gateway` accepts whatever URL it is handed and stores it in `~/.orca/config.json`,
 * and a gateway that authenticates by URL rather than by header is handed one that carries the key:
 * `https://user:pw@gw.example` or `https://gw.example?key=…`. The proxy has to *send* that — it is
 * how the request authenticates — but recording it verbatim would have written the key into every
 * trace made on that machine, breaking the promise stated where the key is read:
 *
 *   > the proxy adds it to the outbound request only, while what gets recorded is derived from the
 *   > *incoming* request with auth stripped, so a gateway key orca injects is invisible to the
 *   > recording by construction rather than by a rule someone has to remember.
 *
 * So the stripping happens here, in the one place an exchange is built, rather than at each call
 * site — for the same reason that sentence gives.
 *
 * The path is kept. It is not a credential, and it is load-bearing: a gateway serving tenants at
 * `/team-a/v1` and `/team-b/v1` answers from two different places, and the exchange's own `path`
 * is the *client's* (`/chat/completions`), not the upstream's base. Only userinfo, query and
 * fragment come out.
 *
 * An origin that will not parse is dropped rather than passed through: it cannot be sanitised, and
 * absent already means "not recorded".
 */
export function recordableOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  try {
    const url = new URL(origin);
    const port = url.port === '' ? '' : `:${url.port}`;
    // `new URL('https://h').pathname` is '/', which is not part of how anyone writes an origin.
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${url.protocol}//${url.hostname}${port}${path}`;
  } catch {
    return undefined;
  }
}

/**
 * Why a string cannot be used as an origin at all, or nothing if it can.
 *
 * Narrower than it first was, because the first version refused configurations that work. A
 * gateway that authenticates by query — `https://gw.example/v1?key=…` — is an ordinary way to
 * configure one, and undici sends it without complaint; refusing it broke a working setup to close
 * a leak that was never about sending. Userinfo is the same story one step along: undici does
 * reject `https://u:pw@gw` at request time, but it is *sanitisable* — {@link recordableOrigin}
 * removes it cleanly — and the recording path already accepts it and keeps it out of the trace.
 *
 * What is left is the case where there is nothing to sanitise, because there is no origin. A
 * gateway typed without a scheme parses with the username as the protocol:
 *
 *     new URL('myuser:PASSWORD@gw.example/v1')   // protocol 'myuser:', pathname the rest
 *
 * so {@link recordableOrigin} answers `myuser://PASSWORD@gw.example/v1` — a value, which means a
 * caller guarding with `?? url` never notices, and the password is on the line anyway. There is no
 * fixing that by rewriting: with no scheme there is no telling which half of `a:b` was meant as
 * the host. And nothing refused here could have worked — undici cannot parse it either.
 */
export function unusableOrigin(origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return 'it is not a URL — an origin needs a scheme, like https://gateway.example';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    // Named without echoing the value: a scheme-less URL puts the username here, so `protocol` is
    // the one part of it that is safe to quote back.
    return `its scheme is "${url.protocol.replace(/:$/, '')}" — an origin has to be http or https`;
  }
  return undefined;
}

/**
 * Free text with the credential taken out of any URL it names.
 *
 * For error messages, which nobody composes and everybody prints. A failed `fetch` reports the URL
 * it was given, so an origin configured as `https://user:pw@gw` or `https://gw?key=…` arrives
 * inside the exception text and goes straight to a terminal:
 *
 *     warn gateway.unreachable why="Request cannot be constructed from a URL that includes
 *       credentials: http://someone:PASSWORD@127.0.0.1:50164/v1/models"
 *
 * {@link recordableOrigin} cannot help there — it takes a URL, and this is prose with a URL in it.
 *
 * The query goes as well as the userinfo. That loses the occasional harmless parameter from an
 * error message, which is the right trade: a key in a query is the commonest way a gateway
 * authenticates by URL, and an error string is not where anyone should be reading parameters back.
 */
export function withoutCredentials(text: string): string {
  return (
    text
      // Up to the *last* `@` before the path, not the first. `[^/\s@]*` could not cross an `@`, so
      // an ordinary password containing one — `p@ssw0rd` — ended the match early and the remainder
      // stayed in userinfo position: `https://myuser:p@ssw0rd@gw` came out as `https://ssw0rd@gw`.
      // `[^\s/]*` may cross `@` and backtracks to the last one, and still cannot reach past the
      // path, so an `@` in a path segment (`/v1/@scope/pkg`) is not mistaken for userinfo.
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1')
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#"']*)\?[^\s#"']*/gi, '$1')
      // And once more without a scheme. undici reports an origin it could not parse verbatim —
      // `Failed to parse URL from my.gateway.example?key=…` — and both rules above need a
      // `scheme://` to fire, so that string went through untouched into the 500 body the agent
      // prints. A host-shaped token is one with a dot in it and no whitespace. The cost is that
      // an error naming a file ending in '?' loses the question mark, which is a fair price in
      // prose nobody reads for punctuation.
      .replace(/([a-z0-9][a-z0-9.-]*\.[a-z][a-z0-9-]*(?::\d+)?[^\s?#"']*)\?[^\s#"']*/gi, '$1')
  );
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
  /**
   * Which application protocol carried it: `h2`, `http/1.1`, or absent where orca did not
   * establish the connection itself and so cannot say. Only interception knows this -- the
   * base-URL route hands the call to `fetch`, which chooses for itself and does not report back.
   */
  alpn?: string;
  /**
   * The `content-encoding` orca decoded away before recording the response, when there was one.
   * Interception only, for the same reason: on the base-URL route the HTTP client decompresses
   * before orca sees a body, so there is nothing orca could truthfully claim to have removed.
   */
  responseDecodedFrom?: string;
  /**
   * The origin that actually answered this call.
   *
   * A run's destination is not one value that could live in the manifest: the origin is chosen per
   * request, from an explicit `--upstream-*`, the gateway `orca setup` configured, a `/forward/`
   * base the client announced, or the dialect's vendor default — and a fork that changes provider
   * changes it again mid-run. So it is recorded where it is decided, once per exchange.
   *
   * The trace could say what was sent and what came back but not who answered it, which is the
   * question asked first when a recording looks wrong: a gateway left over in `~/.orca/config.json`
   * redirects every run on the machine, and nothing in the run said so.
   */
  upstream?: string;
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
  /** Extra headers attached to live upstream calls, and the origin they belong to. */
  upstreamHeaders?: Record<string, string>;
  /**
   * The origin {@link upstreamHeaders} are meant for, when they belong to one.
   *
   * The gateway's key goes on requests to the gateway and on nothing else: a forwarded request
   * can name a destination the gateway is not, and attaching the credential anyway would hand a
   * third party a key they were never meant to see. Unset keeps the old behaviour — headers on
   * every live call — for callers that attach them per purpose rather than per origin.
   */
  upstreamHeadersOrigin?: string;
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
   * Endpoints whose answer is a function of their request — embeddings, rerank — so a recording
   * can serve them back without a dialect. Defaults to {@link defaultRetrievalRules}; pass an
   * empty array to turn the whole mechanism off and have these calls pass through as before.
   */
  retrievalRules?: RetrievalRule[];
  /** Recorded retrieval calls, for replay and hybrid. See {@link RecordedRetrieval}. */
  retrievals?: RecordedRetrieval[];
  /**
   * Whether a recorded retrieval call keeps its response body or only a digest of it.
   *
   * `full` is the default and the only one that can be replayed. `digest` exists because the
   * bodies are large in a way chat responses are not — six paragraphs at 768 dimensions is 98 KB
   * of JSON floats, and an index build makes thousands of those calls — so a run recorded to
   * check consistency rather than to reproduce can keep the hash and none of the vectors.
   */
  retrievalStore?: RetrievalStore;
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
  /**
   * Retrieval calls served from the recording, and how many the recording holds.
   *
   * A separate axis from `matchedExact` on purpose. `exact` is a statement about a matching
   * ladder these calls never climb — they are looked up by their own request, because the answer
   * is a function of it — and folding them in would make a recording look more faithfully
   * reproduced the more embeddings it happened to make. Reported as `retrieval=served/total`.
   */
  retrievalServed: number;
  retrievalTotal: number;
  /** Retrieval calls the recording could not answer and the run had to make live. */
  retrievalLive: number;
  /**
   * Retrieval calls served from a recorded batch whose items arrived in a different order.
   *
   * Counted apart from the rest because the bytes were rebuilt rather than handed back: each text
   * got the vector recorded for that exact text, at its new position. Exact, and worth saying.
   */
  retrievalReordered: number;
  /**
   * Exchanges served from a position other than the cursor — held from earlier, or stepped over
   * to. Not a fidelity loss: either the request was byte-identical or it carried a divergence of
   * its own. It says the run's *order* differed, which is what a worker pool does.
   */
  reordered: number;
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
  /**
   * Where the call went, sanitised the way an exchange's `upstream` is: userinfo and query out,
   * path kept. Absent when the configured origin cannot be sanitised into one, because absent
   * already means "not recorded" — see {@link recordableOrigin}.
   */
  origin?: string;
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

/**
 * Whether two origin strings name the same scheme, host and port — the test a credential must
 * pass before travelling with a request. Same shape as the copy in the CLI's upstream plan,
 * which cannot be imported from here: the proxy is a leaf, and the comparison is two lines.
 */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  }
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
    retrievalServed: 0,
    retrievalTotal: 0,
    retrievalLive: 0,
    retrievalReordered: 0,
    reordered: 0,
  };

  // In hybrid mode only the exchanges below the fork point are replayable; everything at or above
  // it must go live, which is exactly what makes a fork a fork.
  const replayable =
    options.mode === 'hybrid' ? recorded.slice(0, options.forkAt ?? recorded.length) : recorded;
  /**
   * The most requests this proxy has had open at once, and the count it is derived from.
   *
   * Only the proxy can know this, and the matcher needs it: a pipeline that issues ten requests
   * together is answered in whatever order the origin finished them, so a replay's request can
   * arrive up to nine positions from the cursor. See {@link LOOKAHEAD}.
   */
  let inFlight = 0;
  let peakInFlight = 0;
  function opened(): void {
    inFlight += 1;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
  }
  function closed(): void {
    if (inFlight > 0) inFlight -= 1;
  }

  // The recorded requests carry placeholders where secrets were; a live replay request carries the
  // secrets themselves. Without a redactor on this side the two are never in the same
  // representation, and a recording of any real harness — whose own system prompt carries a
  // session id — cannot match itself.
  const matcher = new RequestMatcher(
    replayable.map((e) => e.canonicalRequest),
    { redactor: new Redactor(), concurrency: () => peakInFlight },
  );

  /**
   * The recording's retrieval calls, by key, ready to be consumed one at a time.
   *
   * Not filtered by the fork point. A fork keeps replaying these past the cursor on purpose: the
   * vector for a paragraph does not depend on which chat model answers the question afterwards,
   * so re-embedding it live would spend money to recompute an identical value and leave the
   * fork's index differing from its parent's for no reason. See `RetrievalRule.forkable`.
   */
  const retrievalRules = options.retrievalRules ?? defaultRetrievalRules();
  const retrievalIndex = indexRetrievals(options.retrievals ?? []);
  stats.retrievalTotal = (options.retrievals ?? []).length;

  const server = createServer((req, res) => {
    opened();
    void handle(req, res)
      .catch((err: unknown) => {
        // Whatever failed, its message may name the origin it was given — and this body reaches
        // the agent, which prints it. See {@link withoutCredentials}.
        json(res, 500, { error: { message: withoutCredentials(String(err)) } });
      })
      .finally(closed);
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
    // On the path alone. A dialect matches an endpoint, and a query string is not part of the
    // endpoint -- Azure OpenAI's are all `?api-version=...`, so matching the raw path recorded
    // those runs as opaque network traffic that cannot be replayed or forked, while telling the
    // operator no dialect claimed the path. `onInterceptedRequest` below has always split it off
    // for exactly this reason; the recording side had not.
    const dialect = selectDialect(dialects, exchange.path.split('?')[0] ?? exchange.path);
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
          // The two things only the interceptor witnessed. Without them a promoted exchange is
          // indistinguishable from one captured over the base-URL route, which is the point --
          // except where the difference is the thing being debugged.
          alpn: exchange.alpn,
          responseDecodedFrom: exchange.responseDecodedFrom,
          // Under interception orca did not choose this origin, the agent did — which is the
          // case where "who answered" is least obvious from the command line, and so the one most
          // worth having in the trace. The port is kept only where https does not imply it.
          upstream: `https://${exchange.host}${exchange.port === 443 ? '' : `:${exchange.port}`}`,
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
   *
   * Live calls used to return `undefined` here, which forwarded the client's bytes unchanged —
   * so `orca replay --from N --model X` on a TLS-intercepted recording echoed `model=X` and then
   * called the recorded model. `replayed=0 live=0` was the tell: `goLive` never ran, substitution
   * never had a chance. Same-provider `--model` now rewrites the body and still talks to the
   * intercepted origin (the only origin that origin's credential can reach). A cross-provider
   * target would have to leave that host, which this path cannot do; that fails loudly instead of
   * succeeding with the old model.
   */
  function onInterceptedRequest(
    request: NetRequest,
  ): InterceptDecision | undefined | Promise<InterceptDecision | undefined> {
    const path = request.path.split('?')[0] ?? '/';
    const dialect = selectDialect(dialects, path);
    if (!dialect || request.method !== 'POST' || request.requestTruncated) return undefined;

    let rawBody: string;
    try {
      rawBody = decodeBody(request.requestBytes, request.requestHeaders['content-encoding']);
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
    return liveIntercepted(dialect, request, rawBody);
  }

  /**
   * A decrypted model call the recording will not serve — past the fork point, or unmatched on a
   * hybrid / `--loose` run. Counted as live the way `handle()` → `goLive` is, so `fork.done`
   * `live=N` is the number of exchanges the fork actually owned.
   */
  function liveIntercepted(
    dialect: Dialect,
    request: NetRequest,
    rawBody: string,
  ): InterceptDecision | undefined {
    if (options.forkModel === undefined) {
      stats.liveCalls += 1;
      return undefined;
    }

    const target = dialect.ownsModel(options.forkModel)
      ? dialect
      : (dialects.find((d) => d.ownsModel(options.forkModel!)) ?? dialect);
    const crossProvider = target.id !== dialect.id;

    if (crossProvider) {
      return replayError(
        `--model ${options.forkModel} is served by ${target.id}, not the intercepted ` +
          `${dialect.id} origin ${request.host}:${request.port}. A TLS-intercepted fork cannot ` +
          `leave the host the recording talked to. Pick a model that origin serves`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch (err) {
      return replayError(`unparseable request body: ${String(err)}`);
    }
    const outboundBody = Buffer.from(
      JSON.stringify(dialect.withModel(parsed, options.forkModel)),
      'utf8',
    );
    stats.liveCalls += 1;
    const origin = `https://${request.host}${request.port === 443 ? '' : `:${request.port}`}`;
    const recordable = recordableOrigin(origin);
    options.onRoute?.({
      model: options.forkModel,
      target: target.id,
      recorded: dialect.id,
      ...(recordable === undefined ? {} : { origin: recordable }),
      crossProvider: false,
      reason: `served by the recorded dialect ${dialect.id}`,
    });
    return { outboundBody };
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
      if (result.reordered) stats.reordered += 1;
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

  /**
   * The configured extra headers for one outbound call — only when the call is going where they
   * belong.
   *
   * `upstreamHeaders` exist to put a gateway's credential on calls to that gateway. With a
   * forwarded request naming its own destination, "every live call" would put the credential on
   * someone else's origin, so the origin the headers name is attached to them and compared here.
   * Callers that set headers without an origin get the old behaviour: on every call, their
   * responsibility.
   */
  function headersForOrigin(origin: string): Record<string, string> {
    const extra = options.upstreamHeaders;
    if (extra === undefined) return {};
    if (options.upstreamHeadersOrigin === undefined) return extra;
    return sameOrigin(origin, options.upstreamHeadersOrigin) ? extra : {};
  }

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
    /**
     * The base URL the request itself names, from a `/forward/` path. It restores the destination
     * orca took the call away from, so it outranks only the dialect's vendor default — an upstream
     * the operator configured is an instruction and wins. Dropped on a cross-provider fork, where
     * the model asked for is being served by a different origin on purpose.
     */
    forwardBase?: string,
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
    // Where this call goes, in strict order of who decided it. A `/forward/` path names its own
    // destination — that is the whole point of the encoding — so on a live call that orca is
    // merely relaying (record, or a loose replay continuing past its recording) the request's own
    // base outranks every configured origin: a gateway picked up from `orca setup` is a default
    // for calls orca would otherwise have to guess at, not a licence to readdress one that
    // announces where it was headed. A fork is different: substituting the model is the operator
    // choosing where answers come from, so the fork target's explicit upstream — or the gateway —
    // decides, and the forwarded base is dropped as incoherent for the substitution.
    const relaying = options.forkModel === undefined && !crossProvider;
    const origin =
      relaying && forwardBase !== undefined
        ? forwardBase
        : (options.upstream?.[target.id] ??
          options.upstream?.[dialect.id] ??
          target.defaultUpstream);
    // A relayed call keeps the path the client appended, because the base it names expects
    // exactly that. Everything else is answered by an origin orca chose, which expects the
    // dialect's own path — and the incoming path cannot be trusted to be it: a bare base url
    // (no `/v1`) reaches this proxy as `/chat/completions`, and a gateway handed that without the
    // version segment answers 404.
    //
    // The query survives the substitution either way, because it is not part of the endpoint's
    // shape. A path says which endpoint; a query says how to call it, and the client set it —
    // `?api-version=` is required on every Azure OpenAI call, and dropping it turns a working
    // configuration into `404 Resource not found` with nothing in the run explaining why.
    // Replacing a path is orca normalising an address it chose; replacing the parameters would
    // be orca editing the request.
    const queryAt = path.indexOf('?');
    const query = queryAt === -1 ? '' : path.slice(queryAt);
    const upstreamPath =
      relaying && forwardBase !== undefined ? path : `${target.requestPath}${query}`;

    // Spec §2: "a gateway chose a model". Orca *is* the gateway on this path — it substitutes the
    // model, picks the wire format that serves it, and picks the origin — and it was making all
    // three of those choices silently. Which is the one thing a comparison must not do: reading
    // `claude-opus-5 vs gpt-5.2` in a verdict table tells you nothing about where either went, and
    // a fork that quietly fell back to the recorded provider's origin looked identical to one that
    // did not. Emitted only when a decision was actually taken, so an ordinary recording — where
    // orca forwards what it was given — stays free of an event saying "nothing was chosen".
    if (options.forkModel !== undefined) {
      // Sanitised here for the reason {@link buildExchange} sanitises the exchange's `upstream`,
      // and it is the same value: an origin that came from configuration rather than off the wire,
      // so a gateway that authenticates by URL carries its key in it. This payload is not just
      // reported — `orca replay --model` and `orca compare --models` write it into the fork's
      // trace as `route.decision.attrs` unchanged, and the trace redactor cannot help, because it
      // matches key shapes and field names and this is a password inside a URL under `origin`.
      // Omitted rather than replaced when it will not parse: no consumer reads it — the viewer
      // renders model, target and reason — and a placeholder in a field others may parse as a URL
      // is worse than the field being absent.
      const recordable = recordableOrigin(origin);
      options.onRoute?.({
        model: options.forkModel,
        target: target.id,
        recorded: dialect.id,
        ...(recordable === undefined ? {} : { origin: recordable }),
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
        ...headersForOrigin(origin),
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
        // The origin resolved above, not the one configured: a relayed call keeps the base the
        // client announced, and a fork's substitution can send it somewhere else again.
        upstream: origin,
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
  function passthroughOrigin(headers: Record<string, string>, forwardBase?: string): string {
    if (options.passthroughUpstream !== undefined) return options.passthroughUpstream;
    // A relayed request's own destination, before anything configured: on a live call with no
    // model substitution, the request says where it was headed, and a gateway picked up from
    // setup is a default for calls orca would otherwise guess at — not a readdressing of one that
    // announces its own. A fork is a substitution, and its configured origins decide instead.
    if (options.forkModel === undefined && forwardBase !== undefined) return forwardBase;
    const configured = [...new Set(Object.values(options.upstream ?? {}))];
    if (configured.length === 1) return configured[0]!;
    const names = new Set(Object.keys(headers).map((h) => h.toLowerCase()));
    // `x-api-key` alongside the version headers: this request carries the caller's own credential,
    // and a wrong guess does not merely fail — it hands one vendor a key issued by another.
    // Anthropic's client is the one that announces itself, so absence of a signal means OpenAI.
    const anthropic =
      names.has('anthropic-version') || names.has('anthropic-beta') || names.has('x-api-key');
    // The origin configured for the family this request belongs to, before any vendor default.
    // Two configured values only means the run has more than one destination — not that this
    // request's own destination is unknown — and picking a vendor default over an origin the
    // operator named is how a run configured with `--upstream-openai <stub>` alongside a gateway
    // left in `~/.orca/config.json` sent its embedding calls to `api.openai.com`: a third place,
    // neither of the two configured, carrying the agent's own credential. For a team whose
    // gateway is the point of the gateway, that is every retrieval call bypassing it silently.
    const forFamily = anthropic ? options.upstream?.['anthropic'] : options.upstream?.['openai'];
    if (forFamily !== undefined) return forFamily;
    return anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com';
  }

  /**
   * Serve a retrieval call: from the recording where there is one, live where there is not.
   *
   * The lookup is by the request itself rather than by a cursor. Two reasons, and both matter.
   * The answer is a function of the request, so position carries no information — the same text
   * embedded on turn 3 and on turn 40 has the same vector. And an index build issues these
   * hundreds at a time from a worker pool, so there is no order for a cursor to follow.
   *
   * A recorded call is consumed once, earliest first, so a run that asked the same thing twice
   * gets both of its answers back and `retrieval=N/N` means every recorded call was reused —
   * rather than one of them being served twice while another was never asked for.
   */
  async function serveRetrieval(
    rule: RetrievalRule,
    path: string,
    rawBody: string,
    headers: Record<string, string>,
    recordableHeaders: Record<string, string>,
    res: ServerResponse,
    startedAt: number,
    forwardBase?: string,
  ): Promise<void> {
    let key: string;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
      key = rule.key(parsed);
    } catch (err) {
      // A body this rule cannot key is a body orca cannot promise anything about. Passthrough is
      // the honest fallback: forward it, record the bytes, say it is not replayable.
      if (options.mode === 'replay') {
        stats.unmatched += 1;
        const reason = `${path} could not be keyed for replay: ${String(err)}`;
        options.onUnmatched?.({ seq: -1, index: -1, reason });
        json(res, 502, { error: { message: `orca replay cannot reproduce ${path}: ${reason}` } });
        return;
      }
      await passThrough(path, rawBody, headers, recordableHeaders, res, startedAt, forwardBase);
      return;
    }

    // Across the fork cursor deliberately, in every mode that has a recording. A fork asks the
    // same documents about a different chat model; re-embedding them live would spend money to
    // recompute a value that cannot have changed, and would make the fork's index differ from the
    // parent's for no reason anyone asked for. `RetrievalRule.forkable` is `false` for the same
    // reason, one level up.
    //
    // Exact first, then the batch. A pipeline assembles its batch from a worker pool, so the same
    // set of texts arrives in a different order on every run and an exact key alone found nothing
    // — measured: two replays of one recording, two different keys, neither recorded. Where the
    // endpoint's own contract says `data[i]` answers `input[i]`, the recorded answer for each
    // text can be handed back against that text's new position, which is not an approximation.
    // See {@link BatchRetrieval}.
    let match = retrievalIndex.byKey.get(key)?.[0];
    let rebuilt: string | undefined;
    if (match === undefined) {
      const batchKey = rule.batch?.key(parsed);
      const candidate =
        batchKey === undefined ? undefined : retrievalIndex.byBatch.get(batchKey)?.[0];
      if (candidate !== undefined && candidate.rawResponse !== '') {
        rebuilt = rule.batch?.reorder(
          safeParse(candidate.rawRequest),
          candidate.rawResponse,
          parsed,
        );
        // An inexact reorder is no match at all. Filling the gaps would put another document's
        // vector in the index, and nothing downstream could tell.
        if (rebuilt !== undefined) match = candidate;
      } else if (candidate !== undefined) {
        match = candidate;
      }
    }
    if (match !== undefined) {
      // Consumed only where it is actually served. A recorded call orca cannot serve is still the
      // answer to this request, and dropping it turned a client's retry — langchain retries a 502
      // — into "no recorded retrieval call matches this request", which is false and sends the
      // reader looking for a mismatch that is not there.
      if (rebuilt !== undefined) {
        consume(retrievalIndex, match);
        stats.retrievalServed += 1;
        stats.retrievalReordered += 1;
        res.writeHead(match.status, { 'content-type': match.contentType });
        res.end(rebuilt);
        return;
      }
      if (match.rawResponse === '') {
        // Recorded with `--retrieval-store=digest`: orca kept proof of the answer, not the answer.
        const reason =
          `${path} was recorded with --retrieval-store=digest, so the trace holds a digest of ` +
          'the response and not the response. Re-record with the default (full) to replay it';
        if (options.mode === 'replay' && !options.loose) {
          stats.unmatched += 1;
          options.onUnmatched?.({ seq: match.seq, index: -1, reason });
          json(res, 502, { error: { message: `orca replay cannot reproduce ${path}: ${reason}` } });
          return;
        }
      } else {
        consume(retrievalIndex, match);
        stats.retrievalServed += 1;
        res.writeHead(match.status, { 'content-type': match.contentType });
        res.end(match.rawResponse);
        return;
      }
    }

    if (options.mode === 'replay' && !options.loose) {
      stats.unmatched += 1;
      const reason =
        `no recorded retrieval call matches this request (rule ${rule.id}, key ` +
        `${key.slice(0, 12)}…). The recording holds ${stats.retrievalTotal} retrieval ` +
        `call${stats.retrievalTotal === 1 ? '' : 's'}, and this is not one of them`;
      options.onUnmatched?.({ seq: -1, index: -1, reason });
      json(res, 502, { error: { message: `orca replay cannot reproduce ${path}: ${reason}` } });
      return;
    }

    // Record, a fork past what it can serve, or a loose replay: make the call and keep the answer.
    if (options.mode !== 'record') stats.retrievalLive += 1;
    await forwardRetrieval(
      rule,
      key,
      rule.batch?.key(parsed),
      path,
      rawBody,
      headers,
      recordableHeaders,
      res,
      startedAt,
      forwardBase,
    );
  }

  /** A body that has already parsed once. Undefined rather than a throw where it has not. */
  function safeParse(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  /** Make a retrieval call for real, and file it as a replayable `net.*` pair. */
  async function forwardRetrieval(
    rule: RetrievalRule,
    key: string,
    batchKey: string | undefined,
    path: string,
    rawBody: string,
    headers: Record<string, string>,
    recordableHeaders: Record<string, string>,
    res: ServerResponse,
    startedAt: number,
    forwardBase?: string,
  ): Promise<void> {
    stats.passedThrough += 1;
    // On a recording, the count of retrieval calls *captured*. It is the same field replay uses
    // for "how many the recording holds", which is the same quantity one command later — and it
    // is what lets `capture.empty` tell an index build, whose every call is a retrieval call and
    // every one of them replayable, apart from a run that captured nothing at all.
    if (options.mode === 'record') stats.retrievalTotal += 1;
    const origin = passthroughOrigin(headers, forwardBase);
    const upstreamRes = await doFetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers, ...headersForOrigin(origin) },
      body: rawBody,
    });

    const responseHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((value, key2) => {
      responseHeaders[key2.toLowerCase()] = value;
    });
    res.writeHead(upstreamRes.status, {
      'content-type': responseHeaders['content-type'] ?? 'application/json',
    });
    const body = await pipeThrough(upstreamRes, res);

    const digest = createHash('sha256').update(body).digest('hex');
    const keepBody = (options.retrievalStore ?? 'full') === 'full';
    const { host, port } = originParts(origin);
    options.onNetExchange?.({
      host,
      port,
      method: 'POST',
      path,
      intercepted: false,
      rule: rule.id,
      replayKey: key,
      // Only where the rule offers one. Its absence in a trace means exactly what it says: this
      // call can be found again by its own body and by nothing else.
      ...(batchKey === undefined ? {} : { batchKey }),
      requestHeaders: recordableHeaders,
      requestBody: rawBody,
      requestTruncated: false,
      status: upstreamRes.status,
      responseHeaders,
      // Dropped rather than trimmed under `digest`: half a vector is not a smaller answer, it is
      // a wrong one, and the digest already says whether a later run agreed.
      responseBody: keepBody ? body : '',
      responseDigest: digest,
      responseTruncated: false,
      responseBytes: Buffer.byteLength(body),
      durationMs: Date.now() - startedAt,
    });
  }

  /** Split a configured origin into the host and port an exchange records. */
  function originParts(origin: string): { host: string; port: number } {
    try {
      const url = new URL(origin);
      return {
        host: url.hostname,
        port: url.port !== '' ? Number(url.port) : url.protocol === 'http:' ? 80 : 443,
      };
    } catch {
      // An origin that does not parse is still worth recording under the string we were given.
      return { host: origin, port: 443 };
    }
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
    forwardBase?: string,
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
    const origin = passthroughOrigin(headers, forwardBase);
    const upstreamRes = await doFetch(`${origin}${path}`, {
      method: 'POST',
      // `upstreamHeaders` too, as `goLive` does. Omitting them sent a gateway the agent's own
      // credential — often the `orca-recorded` placeholder — and the call came back 401 for a
      // reason nothing in the trace explained.
      headers: {
        'content-type': 'application/json',
        ...headers,
        ...headersForOrigin(origin),
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
      // Orca decrypted nothing here: the harness sent this in plaintext to the local proxy, and
      // orca relayed it. Saying otherwise puts a claim about TLS termination in the trace over a
      // host orca never terminated TLS for.
      intercepted: false,
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

  /**
   * The host a `/forward/` path names, for a rule that wants to tell two vendors apart.
   *
   * Only where the request announced its own destination. On an ordinary redirected call orca knows
   * where it is *sending* the request but not where the client thought it was going, and inventing
   * a host would let a rule claim an endpoint on evidence that does not exist.
   */
  function forwardHost(forward: ForwardPath | undefined): string | undefined {
    if (forward === undefined) return undefined;
    try {
      return new URL(forward.base).hostname;
    } catch {
      return undefined;
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
    alpn?: string;
    responseDecodedFrom?: string;
    upstream?: string;
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
      ...(input.alpn === undefined ? {} : { alpn: input.alpn }),
      ...(input.responseDecodedFrom === undefined
        ? {}
        : { responseDecodedFrom: input.responseDecodedFrom }),
      ...(recordableOrigin(input.upstream) === undefined
        ? {}
        : { upstream: recordableOrigin(input.upstream)! }),
      durationMs: input.durationMs,
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    // Split, not discarded. Two different questions are asked of a request line here and they
    // want different halves of it: *which endpoint is this* is answered by the path alone —
    // `selectDialect` matches an endpoint and a query is not part of one — while *what do I
    // send upstream* wants the line as the client wrote it. Dropping the query at the top answered
    // the first question and silently lost the second: a client calling
    // `<base>/chat/completions?api-version=2026-02-01` reached its origin as
    // `/v1/chat/completions`, which is `404 Resource not found` on Azure OpenAI, where that
    // parameter is required on every call. The trace lost it too, so nothing in the run said why.
    const rawPath = req.url ?? '/';
    const path = rawPath.split('?')[0] ?? '/';
    const query = rawPath.slice(path.length);

    if (path === '/__orca/health') {
      json(res, 200, { ok: true, ...stats });
      return;
    }

    // A `/forward/` path carries the base URL the client was actually given — see
    // `decodeForwardPath`. The dialect reads the real path behind the prefix, and everything
    // recorded below does too, so the trace shows the conversation the agent had, not the
    // envelope orca wrapped it in.
    const forward: ForwardPath | undefined = decodeForwardPath(path);
    const dialectPath = forward?.path ?? path;
    /** What goes upstream and into the trace: the endpoint orca resolved, called the way it was. */
    const requestedPath = `${dialectPath}${query}`;

    const dialect = selectDialect(dialects, dialectPath);
    // Only a POST is ever a model call. Relaxing this to `!dialect && …` let a PUT or a DELETE on
    // a dialect path through to `goLive`, which forwarded it upstream and recorded it as a model
    // exchange; and it turned `GET /v1/messages` into a 400 about unreadable JSON rather than the
    // honest answer. Method first, then passthrough decides what to do with a POST orca cannot read.
    if (req.method !== 'POST') {
      json(res, 404, {
        error: { message: `orca proxy does not handle ${req.method ?? 'GET'} ${dialectPath}` },
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
      // Before passthrough, and only where no dialect claims the path: a dialect is the richer
      // reading of a call — replayable, forkable, counted in `exact` — and a rule that outranked
      // one would turn a chat completion into opaque bytes keyed by their own body.
      const rule = selectRetrievalRule(retrievalRules, dialectPath, forwardHost(forward));
      if (rule && isReadable(rawBody)) {
        await serveRetrieval(
          rule,
          requestedPath,
          rawBody,
          headers,
          recordableHeaders,
          res,
          startedAt,
          forward?.base,
        );
        return;
      }
      await passThrough(
        requestedPath,
        rawBody,
        headers,
        recordableHeaders,
        res,
        startedAt,
        forward?.base,
      );
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
            `orca proxy could not read the body of POST ${dialectPath}: expected JSON, got ` +
            `${rawBody === '' ? 'an empty body' : `${rawBody.length} bytes that do not parse`}`,
        },
      });
      return;
    }

    if (options.mode === 'record') {
      await goLive(
        dialect,
        requestedPath,
        rawBody,
        headers,
        recordableHeaders,
        res,
        startedAt,
        forward?.base,
      );
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
        if (result.reordered) stats.reordered += 1;
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

    await goLive(
      dialect,
      requestedPath,
      rawBody,
      headers,
      recordableHeaders,
      res,
      startedAt,
      forward?.base,
    );
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
