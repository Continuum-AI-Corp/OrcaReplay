# Architecture

## The observation everything rests on

Model APIs are stateless. On every turn an agent resends the entire conversation — including the
previous turn's `tool_result` blocks. So a proxy in front of the model sees the whole loop: each
request, each streamed response, every tool call the model emitted, and every tool result the
harness produced.

**This is why OrcaReplay does not patch your agent.** One well-placed interception point yields a
near-complete execution graph for any agent that talks to a model over HTTP.

Two honest limits come with it, and they shape everything else:

1. You see a tool result **one turn late** — it arrives with the next request.
2. You see the harness's **rendering** of the result, often truncated, not the raw bytes.

The three supplementary capture layers exist to close that gap where it matters.

## Capture layers

```
agent process ──(base-URL env redirect)──▶ orca proxy ──(verbatim)──▶ provider API
agent process ──(rewritten MCP config)───▶ orca mcp-shim ─(unmodified)▶ MCP servers
workspace ─────(snapshot per turn)───────▶ shadow git index
                                              │
                                              ▼
                            .orca/runs/<id>/{manifest,events.jsonl,blobs,fs}
```

| Layer | Mechanism | Confidence | Fallback |
|---|---|---|---|
| Model calls | `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` injected into the child; proxy speaks the native wire protocol and tees a canonical copy while streaming through | high | none — a harness that ignores those variables is not captured |
| Tools & results | free — reconstructed from the protocol | high | — |
| MCP | config rewritten to launch `orca mcp-shim -- <original>`, a transparent JSON-RPC tee | high | protocol layer, one turn late |
| Shell | `PATH` shim in front of `sh`/`bash`, capturing argv, exit code, duration, stdout/stderr split | medium | protocol layer gives the command and merged output |
| Filesystem | shadow git index (`--git-dir=.orca/runs/<id>/fs --work-tree=.`), one snapshot per turn | high | — |
| Network | not captured | — | — |

Reusing git plumbing for the filesystem layer gives content-addressed storage, cheap diffs,
`.gitignore` handling and worktree materialization — the exact four things fork replay needs — for
about a hundred lines of code.

The tee on the model layer is a real tee: chunks are written to the agent as they arrive and the
copy we keep is assembled on the way past. Buffering the response first would make every turn of
an interactive session appear to hang for its full duration, because the agent's own progressive
rendering has nothing progressive left to render. One path is the exception — a **cross-provider
fork**, where the agent asked one provider and a different one answered. Translating a reply means
having all of it, so that path reads the upstream response to completion, converts it, and only
then writes. It costs the streaming, and it applies only to a fork that deliberately changed
provider; recording never takes it.

**There is no CA mode, opt-in or otherwise.** Nothing in the tree generates a certificate,
terminates TLS or touches a trust store. Capture is base-URL redirection and nothing else, so an
agent that ignores `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `OPENAI_API_BASE` is simply not
captured today. Whether to build one, and under what constraints, is written down in
[SECURITY.md](../SECURITY.md); it is a design question, not a flag that exists and is switched off.

Non-model HTTP is not captured either. `net.request` and `net.response` are reserved in the format
(spec §2.3) and the viewer renders them, but no writer emits one. The proxy is an origin server,
not a forward proxy: it matches `/v1/messages` and the chat-completions paths, answers everything
else with a 404, and registers no `CONNECT` handler — so pointing a child's `HTTPS_PROXY` at it
would get its tunnel request dropped rather than recorded. Out of scope for v0, and with no partial
capture to misread.

### Auth, verified against a real agent

Claude Code under a subscription login authenticates with its **own** `authorization: Bearer`
header and ignores an injected `ANTHROPIC_API_KEY`. So the proxy forwards auth headers upstream
verbatim while never writing them to the trace — §7 forbids *recording* auth material, which is a
different requirement from relaying it. A proxy that dropped the header would break the agent
outright, and only for subscription users, which is the worst kind of bug to ship.

It also probes `GET /v1/code/agent-proxy/ca-cert` and a websocket upgrade at
`/v1/code/agent-proxy/ws`. The proxy answers both with a clean 404 rather than an error — the
upgrade included, because nothing listens for the server's `upgrade` event and node then hands the
request to the ordinary handler, which 404s it like any other unmatched path. (`CONNECT` is the one
node closes when nothing listens for it, which is the other half of why `HTTPS_PROXY` is not a
capture route.)

One capture gap follows from the same place: a Codex CLI signed in with a ChatGPT subscription
talks to its own backend rather than the OpenAI API base URL, so base-URL redirection alone does
not capture that auth mode. OpenCode's provider-OAuth logins carry the same shape of risk.

## Three modes, one proxy

Exact, fork and compare are not three subsystems. They are one proxy with a **cursor**: the
position in the recorded event stream where it stops serving from disk and starts serving from the
network.

| Mode | Cursor | Behaviour |
|---|---|---|
| Exact | end | Every response served from the trace. Egress blocked at the socket, not merely discouraged. |
| Fork | *n* | Serve from the trace below *n*, live at and above it. Filesystem materialized from the checkpoint tree. |
| Compare | *n* × N | *N* forks from one checkpoint, isolated worktrees, run one after another, then a verdict table. |

A fork is recorded as a new run carrying `parent_run` and `fork_point`, so forks of forks work with
no extra machinery.

Compare runs its forks **sequentially**, and that is deliberate rather than unfinished. Each fork
spawns a real agent against a real worktree; running four of those concurrently on one machine
measures the machine, not the models. The wall-clock column would be the first casualty, and it is
a column people compare.

## Divergence

Agent harnesses are not deterministic — timestamps, UUIDs, working directories, context compaction
firing at a different point. A recorded request frequently will **not** be byte-identical to the one
the agent makes on replay.

Matching runs as a ladder, and the rung that matched is recorded:

| Rung | Strategy | Result |
|---|---|---|
| 1 | canonical hash of the normalized request | exact, no event |
| 2 | same turn index and message count, structural distance under threshold | `divergence` minor |
| 3 | identical trailing message, different prefix | `divergence` major |
| 4 | no match | halt and report; `--loose` continues live |

**Replay never silently approximates.** Where an inexact match ends up depends on the mode, because
only one of them is writing a trace. A fork produces a new run, so each divergence below its fork
point is written into the child's trace as a `divergence` event carrying the rung and the level. An
exact replay produces no trace at all — it is reproducing a run, not recording one — so its
divergences are printed as they happen, counted in the closing `replay.done` line, and an unmatched
request halts the replay and makes the exit code non-zero even if the agent exited 0. Either way
you are told. A debugger that quietly guesses is worse than no debugger, because you will believe
it.

The share of runs replaying clean at rung 1 would be the best single health metric for the project.
**Nothing measures it yet.** The rung that matched is recorded per divergence inside a forked run's
trace, but no code aggregates those across runs, and the recorder sends no telemetry there would be
anything to aggregate from. Per-adapter and per-harness-version numbers need a harness that replays
a corpus of traces and tallies the outcome — worth building, and not built.

## Checkpoints are derived

A checkpoint is any `seq` with a complete conversation prefix and a filesystem tree from the same
turn, so the recorder never has to guess where you might want to fork. A `--from N` that lands
between two snaps to the nearest preceding checkpoint **and says so** — silently forking from the
wrong state is the worst bug this project could ship.

## Why blobs are load-bearing

Because every turn resends the whole conversation, naive capture is `O(n²)` in turns. Content
addressing makes the resent prefix dedupe to nothing, so storage is `O(n)` in new content. This is
not an optimisation to defer: without it the recorder is unusable on exactly the long, interesting
runs people want to debug.

## Package graph

```
schema ──────┬──▶ core ──┬──▶ proxy ──▶ cli
plugin-api ──┤           ├──▶ fs-capture
             ├──▶ providers ──────┘
             └──▶ adapters
                  viewer ──▶ cli
```

`schema` and `plugin-api` are the contracts. Everything else compiles against them, which is what
keeps the format from becoming TypeScript-shaped.
