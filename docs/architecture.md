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
| Model calls | `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` injected into the child; proxy speaks the native wire protocol and tees a canonical copy while streaming through | high | opt-in per-run ephemeral CA, never installed system-wide |
| Tools & results | free — reconstructed from the protocol | high | — |
| MCP | config rewritten to launch `orca mcp-shim -- <original>`, a transparent JSON-RPC tee | high | protocol layer, one turn late |
| Shell | `PATH` shim capturing argv, exit code, duration, stdout/stderr split | medium | protocol layer gives the command and merged output |
| Filesystem | shadow git index (`--git-dir=.orca/runs/<id>/fs --work-tree=.`), one snapshot per turn | high | — |
| Network | same proxy when the child honours `HTTPS_PROXY` | low | out of scope for v0 |

Reusing git plumbing for the filesystem layer gives content-addressed storage, cheap diffs,
`.gitignore` handling and worktree materialization — the exact four things fork replay needs — for
about a hundred lines of code.

## Three modes, one proxy

Exact, fork and compare are not three subsystems. They are one proxy with a **cursor**: the
position in the recorded event stream where it stops serving from disk and starts serving from the
network.

| Mode | Cursor | Behaviour |
|---|---|---|
| Exact | end | Every response served from the trace. Egress blocked at the socket, not merely discouraged. |
| Fork | *n* | Serve from the trace below *n*, live at and above it. Filesystem materialized from the checkpoint tree. |
| Compare | *n* × N | *N* forks from one checkpoint, isolated worktrees, run in parallel, then a verdict table. |

A fork is recorded as a new run carrying `parent_run` and `fork_point`, so forks of forks work with
no extra machinery.

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

**Replay never silently approximates.** Every inexact match is an event in the trace. A debugger
that quietly guesses is worse than no debugger, because you will believe it.

The share of runs replaying clean at rung 1 is the best single health metric for the project. It is
tracked per adapter and per harness version.

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
