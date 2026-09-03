# Capturing Cursor, and the four things in the way

Cursor's CLI agent was the one harness none of the existing techniques reached. Getting to its
system prompt took four separate fixes, three of them in OrcaReplay itself. This is what each one
was, how it was diagnosed, and how to reproduce the result.

```console
ORCA_BIN=packages/cli/dist/cli.js node capture/capture.mjs cursor
```

That is the whole procedure now. What follows is why it did not work before.

## The shape of the problem

Cursor is unlike the other four harnesses in every layer that matters.

| | Claude Code / Codex / Qwen | OpenCode | Cursor |
|---|---|---|---|
| origin | environment variable | `opencode.json` | fixed, undiscoverable |
| redirect | yes | no | no |
| transport | HTTP/1.1 | HTTP/1.1 | **HTTP/2 only** |
| wire format | JSON | JSON | **Connect over protobuf** |
| prompt lives in | the request | the request | **the response** |

Every cell in that last column is a separate obstacle, and they had to be removed in order.

## 1. The interceptor spoke only HTTP/1.1

The conversation goes to `agentn.global.api5.cursor.sh`, which negotiates h2 exclusively. The
interceptor offered one protocol:

```ts
ALPNProtocols: ['http/1.1'],   // packages/proxy/src/intercept.ts
```

No common protocol, so the handshake died before any bytes moved:

```
warn tls.handshake_failed host=agentn.global.api5.cursor.sh
  reason="tls_handle_alpn: no application protocol"
```

Offering `['h2', 'http/1.1']` fixes the handshake and nothing else. Two mistakes followed.

**`secureConnect` is the client-side event.** A socket built with `isServer: true` emits `secure`.
Listening for the wrong one dispatched nothing at all: the baseline passed 12 of 12 interception
tests, and the change passed 4. That comparison is the only reason it was caught, and it is worth
running the baseline before believing any test result on a change like this.

**`session.socket` is a Proxy.** Node's http2 hands out a stand-in rather than the real socket, so
the `WeakMap` keyed by socket never matched and every h2 stream was rejected as arriving on an
unknown connection. The target is now a symbol property on the socket, looked up along `_parent`.

## 2. An already-terminated TLS socket cannot be handed to an h2 server

With ALPN fixed, the session established and then nothing flowed. The client gave up after five
seconds:

```
RetriableError: [internal] HTTP/2 keepalive ping timed out after 5000ms
```

Rather than keep guessing against a live agent, this was reduced to a loopback with no agent in it
at all: a raw socket, `new TLSSocket({ isServer: true })`, and the decrypted socket handed to
`http2.createServer()` — exactly what the interceptor did.

```
client: connected
server: alpn = h2
server: session established
TIMEOUT after 8s
```

So the architecture was wrong, not Cursor. An `Http2Session` takes over the socket's handle rather
than reading the stream, and the client's connection preface and first PING — already buffered by
the time the handshake callback runs — are never seen.

The same harness with `http2.createSecureServer` doing the TLS itself answers immediately. The
interceptor now keeps one such server per intercepted host, with `allowHTTP1: true` so a single
server still serves HTTP/1.1. Per host rather than one server with `SNICallback`, so the
certificate is still chosen by the CONNECT target: SNI would work for every client that sends it
and quietly pick the wrong certificate for one that does not.

One detail only a real run surfaces: with `allowHTTP1`, an h2 request emits **both** `stream` and
`request`. Answering both throws `ERR_HTTP2_HEADERS_SENT`, so the `request` handler serves HTTP/1.1
only.

## 3. A binary body could not survive the trace

Two independent problems, one after the other.

**Bodies were decoded as text.** `bytes.toString('utf8')` on a protobuf body replaces every invalid
sequence with U+FFFD and is not reversible: 974 replacement characters in 8,459 bytes. A body that
is not valid UTF-8 is now recorded as base64 behind a marker, decided by a round-trip test, so text
bodies are untouched.

**Then the redactor shredded the base64.** A base64 body is one long high-entropy run by
construction, and the entropy scanner replaced 226 spans of a 14 KB response with
`<secret:high_entropy:…>` placeholders. The raw bytes were 14,366 and started with valid Connect
framing; the trace copy was 6,161 bytes of noise. Comparing the two in one run is what identified
it — before that, the corruption looked like the interceptor losing the head of the stream.

The redactor now leaves a body carrying the marker alone. The named pattern rules still run on it;
only the randomness heuristic is skipped, and it was protecting nothing there, because a credential
inside a binary body is not matchable once encoded.

## 4. The prompt is in the response, not the request

The request to `/agent.v1.AgentService/Run` is around 3 KB and carries the user's turn, a few
session ids, and — with `auto` — the router's whole candidate set with per-model settings, such as
`claude-fable-5-1` at `thinking: true, context: 300k, effort: high`. No system prompt.

The server composes the prompt and sends the whole conversation **back** in the response stream,
gzipped inside Connect frames. Reading it needs no `.proto` files: the frames carry the messages as
JSON strings, so five bytes of framing, a gunzip where the flag bit says so, and a brace-matched
scan for `{"role": …}` is enough.

An earlier conclusion here was wrong and worth recording as such: the request being small was read
as "the prompt is server-side, so it cannot be captured". The first half is right and the second
does not follow.

**Which model answered comes from the response, not the request.** The first version of this
profile took the first model-shaped string in the request, which under `auto` is a candidate rather
than the choice, and filed three captures under `grok-4.6` when the model that actually answered
was `grok-4.5-high`. The response states it once:

```json
"providerOptions":{"cursor":{"modelName":"cursor-grok-4.5-high"}}
```

The same regex also matched the working directory, which reaches the request as a path and produces
a slug beginning `claude-`. Real model ids are short, so the candidate list is filtered by length.

## What comes out

```
system[0]      1,954 chars    the prompt itself
user[0]       19,031 chars    environment, rules, skills, tool namespaces
user[1]          165 chars    timestamp and the typed turn
assistant[2]     844 chars    the reply
```

The prompt opens:

> You are an AI coding assistant, powered by Composer. You are an interactive CLI tool that helps
> users with software engineering tasks.
>
> `<communication>` Communicate directly and concisely. You are Auto, an agent router designed by
> Cursor. If asked who you are or what your model name is, this is the correct response.
> `</communication>`

Sections are `<communication>`, `<citing_code>` and `<terminal_files_information>`. The 19 KB user
turn carries `user_info`, `agent_transcripts`, `rules`, `user_rule`, `agent_skills`,
`dynamic_tools` and `dynamic_tool_namespaces`.

Cursor declares no tool schemas. Two meta-tools are described in prose, `GetDynamicTools` and
`CallDynamicTool`, and the rest are named in an attribute:

```xml
<namespace name="cursor" tools="CreateGoal, GenerateImage, UpdateGoal" …>
```

The schemas stay server-side, so a tool count of five is the honest number rather than a missing
one.

## What is still not captured, and why

`cursor-agent models` lists 217 entries, mostly effort and speed variants of a dozen base models.
Only `auto` can be captured on this account. Every named model answers:

```
capture failed: Cursor answered resource_exhausted rather than running the turn, so there is no
prompt to read.
  resource_exhausted means the account has no quota left for this model; try another, or `auto`.
```

Tried and refused: `composer-2.5`, `composer-2.5-fast`, `claude-opus-5-thinking-high`,
`gpt-5.3-codex`, `gpt-5.2`, `cursor-grok-4.6-low`, `gemini-3.7-flash-high`. This is an account
limit, not a pipeline limit — the same command succeeds on `auto` every time.

`auto` routed to `grok-4.5-high` on all seven runs and produced a byte-identical prompt every
time, including when the typed turn was changed from a one-word reply to a reasoning question and
to a coding task. So there is no evidence either way about whether the prompt varies with the model
Auto picks. Getting that answer needs an account with quota on more than the router.

The candidate set is worth reading on its own, because it is the only place that says what Auto was
choosing between — nine models, recorded in `meta.json` as `router_candidates`:

```
claude-fable-5-1  claude-opus-5  claude-sonnet-5  composer-2.5  gemini-3.8-flash
gpt-5.6-sol  gpt-5.6-terra  grok-4.5  grok-4.6
```

Nine candidates and one reachable model is the same account limit seen from the other side.

## Reproducing it

The h2 interception is not in any published orca build, so the capture has to run against a local
one. `ORCA_BIN` exists for that.

```console
npm ci && npm run build
ORCA_BIN=packages/cli/dist/cli.js node capture/capture.mjs cursor
```

Prerequisites: `cursor-agent` installed and signed in (`cursor-agent status`), and a directory it
trusts — the profile passes `--trust`, which grants the directory and nothing else, unlike
`--yolo`.

Two things look like failures and are not. `tls.handshake_failed … ECONNRESET` appears once or
twice per run for connections that are not the model call. And `capture.empty exchanges=0` is
expected: that counter tracks *model* exchanges, and a harness captured by decrypting its own
protocol produces net exchanges instead, which is why the profile is marked `netOnly`.

## Verification

| | |
|---|---|
| `npm run typecheck` | passes |
| `packages/proxy/test/tls-intercept.test.ts` | 12/12 |
| `packages/core` + `packages/proxy` | 3 failed / 372 passed, the same three files as the baseline |
| full suite | 32 failed / 1493 passed, file-for-file identical to the baseline |
| Cursor capture | succeeds; prompt identical across three runs |

Every failure in the suite predates this work. The baseline was recorded by restoring the original
`intercept.ts` and running the same commands, which is the only way that claim means anything.
