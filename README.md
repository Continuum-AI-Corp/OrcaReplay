# OrcaReplay

<sub>**English** · [简体中文](docs/i18n/README.zh-CN.md) · [日本語](docs/i18n/README.ja.md) · [한국어](docs/i18n/README.ko.md) · [Deutsch](docs/i18n/README.de.md) · [Français](docs/i18n/README.fr.md) · [Español](docs/i18n/README.es.md) · [العربية](docs/i18n/README.ar.md)</sub>

### Your agent broke something at 2am. Replay it at 9am — exactly, offline, as many times as you like.

Record any coding agent. Reproduce the run byte-for-byte with the network off. Fork it from any step
onto a different model and see who gets it right.

<a href="https://www.orcarouter.ai">
  <img src="docs/orcarouter.svg" alt="OrcaRouter" height="28" align="left" hspace="10">
</a>

**Built by the team behind [OrcaRouter](https://www.orcarouter.ai)** — one API key and one endpoint
for Claude, GPT, Gemini, Grok, DeepSeek, Qwen and the rest. It is what `orca setup` points at by
default, and what makes `orca compare` a single command instead of four provider accounts.

[All models](https://www.orcarouter.ai/models) · [OrcaCode Review](https://www.orcarouter.ai/code-review) · [X](https://x.com/OrcaRouter) · [Hugging Face](https://huggingface.co/orcarouter)

<br clear="left">

[![License](https://img.shields.io/badge/code-Apache--2.0-blue)](LICENSE)
[![Spec](https://img.shields.io/badge/trace%20spec-CC%20BY%204.0-blue)](spec/orca-trace-v0.md)
[![Node](https://img.shields.io/badge/node-20%2B-brightgreen)](#install)
[![Agents](https://img.shields.io/badge/agents-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Agents%20SDK%20%C2%B7%20AI%20SDK%20%C2%B7%20any-black)](#which-agents)
[![Good first issues](https://img.shields.io/badge/good%20first%20issues-12-orange)](docs/good-first-issues.md)

![Recording a Claude Code run, replaying it offline, then forking it onto two models](docs/demo-cli.gif)

<sup>Real output from one session — a Claude Code run recorded, replayed with the network off, then
forked at checkpoint 4 onto two models and graded by `npx tsc --noEmit`. Nothing here is mocked up.</sup>

## Try it in three commands

```console
orca record claude              # your agent, unmodified, doing whatever it does
orca replay last                # the same run again — no network, no tokens, no charge
orca replay last --from 4 --model claude-haiku-4-5 --ui
```

The third line is the one people stay for: same files, same conversation prefix, different model
from step 4 onward. The model is the only variable, which is what makes the answer mean anything.

Not on npm yet — [install from source](#install), it takes about a minute.

## Why this exists

Agent debugging today is archaeology. You scroll a terminal, you re-run and get a different
failure, you add print statements to someone else's harness. The tools that exist are
observability tools: they tell you a run cost $4.12 and used 61k tokens, which is not the question
you have. The question you have is *why did it delete my migration file.*

OrcaReplay answers that by giving you the run back.

|  | Observability tools | OrcaReplay |
|---|---|---|
| Tells you what a run cost | ✅ | ✅ |
| Tells you which tool call deleted the file | sometimes | ✅ |
| Runs the agent again and gets the same answer | ❌ | ✅ offline, byte-for-byte |
| Lets you change the model and re-run from step 4 | ❌ | ✅ |
| Needs you to modify your agent | usually an SDK wrapper | ❌ two env vars |
| Works after you close the terminal | ❌ | ✅ it is a file |
| Sees past the model API — shell exit codes, file writes | ❌ | ✅ every turn |
| Records an agent with no API endpoint to redirect | ❌ | ✅ opt-in `--tls-intercept` |

The last two rows are the ones an SDK wrapper structurally cannot reach. Capture happens *below*
the agent — at the process and socket boundary — so it does not matter whether the agent is
yours, whether you can edit it, or whether it even holds an API key: a Codex CLI signed in with
a ChatGPT subscription talks to its own backend over TLS and has no base URL to point anywhere,
and orca can still record it. See
[when the harness will not be redirected](#when-the-harness-will-not-be-redirected).

## How it works

Model APIs are stateless, so on every turn an agent resends the entire conversation — including the
previous turn's tool results. **A proxy in front of the model therefore sees the whole loop**: each
request, each streamed response, every tool call the model emitted, and every tool result the
harness produced. That one property is what the tool is built on, and it is why **OrcaReplay does
not patch your agent** — it stands up a local proxy, sets two environment variables, and gets out of
the way.

Three more layers catch what the protocol cannot see: an exit code, a real duration, which stream a
byte came out of, a file written without telling anyone. A fifth exists for the agents that read no
base-URL variable at all — see [which agents](#which-agents).

```mermaid
%%{init: {'theme':'neutral'}}%%
flowchart LR
    A["<b>your agent</b><br/><i>unmodified</i>"]

    subgraph orca["orca · five capture layers"]
        direction TB
        P["<b>proxy</b><br/>base-URL env var"]
        SH["<b>PATH shim</b><br/>exit code · timing · streams"]
        MC["<b>JSON-RPC tee</b><br/>MCP config rewrite"]
        FS["<b>shadow git index</b><br/>workspace per turn"]
        FH["<b>fetch hook</b><br/>for a hardcoded origin"]
    end

    A --> P & SH & MC & FS & FH
    P -->|"forwarded, auth intact"| U["<b>the model API</b><br/><i>or OrcaRouter · any gateway</i>"]
    orca ==> T[("<b>one trace</b><br/>.orca/runs/run_a1b2c3")]
```

They all land in the same timeline, ordered by when they actually happened rather than when orca
got around to reading them.

### Exact, fork and compare are one thing

They are not three subsystems. They are the same proxy with a **cursor** — the position in the
recorded stream where it stops answering from disk and starts answering from the network.

```mermaid
%%{init: {'theme':'neutral'}}%%
flowchart LR
    subgraph disk["from disk · byte-for-byte · network blocked"]
        direction LR
        T1["turn 1"] --> T2["turn 2"] --> T3["turn 3"] --> T4["turn 4"]
    end
    T4 ==> CUR{{"<b>cursor</b>"}}
    CUR ==> T5
    subgraph net["from the network · any model you name"]
        direction LR
        T5["turn 5"] --> T6["turn 6"] --> T7["…"]
    end
```

| command | where the cursor sits | what you get |
|---|---|---|
| `orca replay last` | at the end | the whole run again, **network blocked** — no tokens, no charge, no variance |
| `orca replay last --from 4 --model X` | at checkpoint 4 | turns up to 4 identical, then a different model takes over |
| `orca compare last --from 4 --models a,b` | at checkpoint 4, several times | one table, one variable — the model |

A **checkpoint** is not recorded; it is *derived* — any point where the conversation prefix is
complete and the workspace was snapshotted. Every fork therefore starts from a state that provably
existed.

## What a bug hunt actually looks like

Your agent was supposed to fix a failing auth test. It exited 0 and the test still fails. Start with
what it actually did:

```console
$ orca show last
run_6473f858b59e  generic-openai@0.1.0  14 events  exit 0

SEQ  KIND   WHAT                                            DETAIL
0    RUN    run started                                     generic-openai
1    SNAP   tree 919d32ba037537b43814c83779963b2cc3023db7   0 changed
2    MODEL  claude-opus-5                                   1 messages
3    MODEL  claude-opus-5                                   stop: tool_use · 100 in · 20 out
4    TOOL   edit_file                                       {"path":"auth.ts",…}
5    SNAP   tree c6af62b75c0c8b8938bd6087328b5148f3dcd534   1 changed
6    FILE   auth.ts                                         modified +1 −3
7    TOOL   edit_file                                       ok
8    MODEL  claude-opus-5                                   3 messages
9    MODEL  claude-opus-5                                   stop: end_turn · 101 in · 5 out
10   SNAP   tree c6af62b75c0c8b8938bd6087328b5148f3dcd534   0 changed
11   SHELL  ["sh","-c","node --check nonexistent-file.ts"]  /tmp/hunt
12   SHELL  shell result                                    exit 1 · 43ms
13   RUN    run ended                                       exit 0

info usage input=201 output=25 cost=$0.004890
```

Three facts the model's own transcript could not have told you, and the run's exit code hid: the
file really changed (seq 6, `+1 −3`), the check the agent ran **failed** (seq 12, `exit 1`), and it
finished anyway. The run exited 0 because the *agent* exited 0.

That last fact is the one worth a command of its own. `orca show` gives you the order things
happened in; `orca graph` gives you what produced what:

```console
$ orca graph last
FROM              TO               KIND      WHY
3 model.response  4 tool.call      recorded  tool_use block in the response
4 tool.call       6 fs.change      inferred  changed path appears in tool input, same or previous turn
4 tool.call       7 tool.result    recorded  tool result answers its call
7 tool.result     8 model.request  recorded  tool_result block in the request
11 shell.exec     12 shell.result  recorded  shell result answers its exec

  1 inferred — derived from this trace, not recorded in it
```

Two kinds of edge, and the difference matters. A **recorded** edge was written when the run
happened, because a `tool_use` block is physically inside the response that emitted it. An
**inferred** edge was worked out just now by the rule it names — a filesystem snapshot is taken
once per turn rather than once per tool call, so attributing a file change to a *particular* call
is a good guess and not a fact. Inferred edges are never written back into the trace, the same way
checkpoints are derived and never recorded, so a field a third-party reader trusts never contains
something orca made up.

`--graph-card` draws the whole run that way — time left to right, kind of thing top to bottom, with
the chain that produced the failure lit against everything else:

![The same run as a causal graph: model, tool and effect lanes across three turns, with the chain to the failing check lit and the inferred hops dashed](docs/graph-card.png)

The shape is the point. A run is one motif repeated — request, response, call, effect, result — so
anything that breaks it is worth a look, and an event with **no edge leaving it** is an absence a
list cannot show at all.

`orca export last --card bug.svg` draws just that chain, which is the version that fits in an issue
or a message:

![One causal chain: a model response, the bash tool call it emitted, the shell command, and its exit 1](docs/chain-card.png)

Nothing picked the subject by hand — `--to` was not passed. The card carries its own legend because
a dashed line travelling without its trace would otherwise launder a guess into a fact, and it
prints the command that reproduces it.

SVG renders in a GitHub issue and almost nowhere else that matters — X will not take it as an
upload, and Slack and Discord give it no preview — so name the file `.png` and you get one, or
`.gif` and the chain builds a hop at a time. That path needs a browser, and orca does not depend on
one: `docs/media/README.md` keeps the render toolchain out of `package.json` so nobody running
`npm ci` pays for a Chromium download, and a picture command is not a reason to reverse that. Ask
for a raster without it and orca says the one line that fixes it; `orca doctor` reports it either
way, and `.svg` never needs anything.

```console
orca export last --card bug.png       # the chain, ready to post
orca export last --card bug.gif       # the same chain, one hop per frame
npm i --no-save playwright-core pngjs gifenc   # only needed for the two above
```

Now reproduce it as often as you like, for nothing:

```console
$ orca replay last
info replay.done reused=2/2 exact=2 divergences=0 unmatched=0 exit=0
```

No network, no tokens, no variance. Then ask the question you actually have — *would a different
model have got this right?*

```console
$ orca compare last --from 5 --models claude-opus-5,claude-haiku-4-5 --verify "npm test"
MODEL             VERDICT  TOKENS  COST       WALL  RUN
claude-opus-5     pass     201/25  $0.004890  0.3s  run_1457b35062ba
claude-haiku-4-5  pass     201/25  $0.000326  0.3s  run_b8ee08479fb6
```

Both pass. One costs **15× less**. Same files, same conversation prefix, same checkpoint — the model
is the only thing that changed, which is the only reason that number means anything.

## The timeline

`orca replay last --ui` (or `orca ui`) opens the run as one self-contained HTML file — no server
to keep running, no network, nothing to install. Filter it, step it, or press space and watch the
run play back at the pace it actually happened.

![The OrcaReplay timeline: filtering a 42-event run down to its tool loop](docs/demo-viewer.gif)

Every layer lands in the same timeline, so you can read the run as one story rather than four:
the model turns and their token counts, each tool call with its arguments and result, the shell
commands with their exit codes and timing, and the filesystem changes with the tree they produced.

`orca export last -o bug.html` writes exactly that page to a single file you can attach to an
issue. It carries no external reference of any kind — CI asserts that — so it renders from a
download folder, on a plane, in five years.

## Same task, different model

`orca compare` forks one recorded run onto several models from the same checkpoint, with the same
files and the same conversation prefix, and grades each one with a command you choose. The model
is the only variable, which is what makes the answer mean anything.

![A comparison table: two models forked from the same checkpoint, both passing, with real token counts and costs](docs/compare-card.png)

```console
orca compare last --from 4 \
  --models claude-sonnet-5,claude-haiku-4-5 \
  --verify "npm test" \
  --share verdict.svg          # the card above, ready to paste into an issue
```

### Pointing it at several models

Comparing models means reaching several providers, and doing that by hand means knowing that
`--upstream-anthropic` and `--upstream-openai` exist, that one gateway can serve both wire formats,
and where the key goes. All of that is real and none of it is discoverable, so there is a command
that asks instead:

```console
$ orca setup
Gateway URL (serves the model APIs) [https://api.orcarouter.ai]:
  get a key at https://www.orcarouter.ai/console/token — OrcaRouter keys start sk-orca-
API key (stored 0600; leave blank for none):
  info config.saved path=~/.config/orca/config.json mode=0600 gateway=https://api.orcarouter.ai auth=stored

  6 models available:
    anthropic/claude-opus-5
    anthropic/claude-haiku-4-5
    openai/gpt-5.2
    ...

$ orca models
MODEL                      $/MTOK IN  $/MTOK OUT
anthropic/claude-opus-5    15         75
anthropic/claude-haiku-4-5 1          5
openai/gpt-5.2             1.25       10
some-local-model           —          —
```

`orca setup` asks the gateway what it actually serves rather than just writing the file, so a wrong
URL or a dead key is an answer now instead of a 401 in the middle of a comparison. It also stores the
models you picked, so after that `orca compare last --verify "npm test"` needs no model list and no
upstream flags at all. `orca models` prices what it recognises and shows a
dash for what it does not, because inventing a number for an unknown model is how a comparison
table ends up quoting a cost that was never real.

[**OrcaRouter**](https://www.orcarouter.ai) is the default answer to that first question — press
Enter and you have one origin and one key serving Claude, GPT, Gemini, Grok, DeepSeek, Qwen and the
rest, which is exactly the shape `orca compare` wants. Its model ids are namespaced by provider
(`anthropic/claude-sonnet-4.6`, `openai/gpt-4o-mini`), which orca handles: the namespace picks the
wire format and is stripped before pricing.

It is a *default*, not a destination: type over it, or pass `--gateway <url>`, and anything that
speaks the OpenAI-compatible `/v1/models` and chat endpoints works just as well — another hosted
gateway, or something you run yourself.

It is also only ever a default for traffic **you** asked to send somewhere. With no gateway
configured, `orca record` proxies your agent's own calls straight to whatever provider it was
already talking to, on the agent's own key. Orca does not reroute a recording you never configured:
that would post your source code to a third party as a side effect of pressing record.

Non-interactive: `orca setup --key <k>` takes the default, `orca setup --gateway <url> --key <k>`
names another, and `--key-env <VAR>` reads the key from the environment rather than keeping a
credential on disk.

The key never reaches a trace. It is attached to the outbound request only, while what gets
recorded is built from the *incoming* request with auth stripped — so it is invisible to the
recording by construction, not by a rule someone has to remember. It is withheld entirely if a flag
sends that traffic somewhere other than the gateway that issued it.

## Which agents

Two things decide whether a harness can be recorded: whether it can be pointed at the proxy, and
whether orca understands the wire format it speaks once it arrives.

| Agent | How it is captured | State |
|---|---|---|
| **Claude Code** | `ANTHROPIC_BASE_URL` | works — validated against a real bug fix, [in detail](docs/validation.md) |
| **Codex CLI** (API key) | `OPENAI_BASE_URL` → Responses API | works |
| **Codex CLI** (ChatGPT login) | `--tls-intercept` → Responses API | works, [with a decision to make](#when-the-harness-will-not-be-redirected) |
| **OpenAI Agents SDK** | `OPENAI_BASE_URL` → Responses API | works |
| **Vercel AI SDK** | fetch hook — `orca record node -- node app.mjs` | works |
| **grok-cli** (and its Telegram bot) | `orca record grok` — `GROK_BASE_URL`, plus the hook for its sub-agents | works |
| **OpenClaw** | `orca record openclaw` — the hook for the gateway, inherited variables for the agents it spawns | works |
| **opencode** | `orca record opencode` | adapter shipped, both origins redirected |
| **LangGraph / LangChain** | `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` | should work — it goes through the official clients, but nothing here tests it yet |
| **Hermes** (Nous Research) | `ORCA_BASE_URL_VARS=… orca record generic-openai -- hermes …` | should work — it overrides per provider; [name the variable](#a-base-url-variable-orca-has-never-heard-of) |
| **anything else** | `orca record generic-openai -- <cmd>` | works if it reads a base-URL variable; `orca record node -- <cmd>` if it does not |

Only Claude Code has been driven end to end against the real harness, and
[it broke four things doing it](docs/validation.md). The rest are held to the adapter contract and
to fixtures that record the exact variables each one sets, so a harness that renames the variable
it reads turns a check red instead of producing an empty trace.

### A gateway that launches the coding agent

OpenClaw does not do the coding: it runs Claude Code, Codex or opencode as child processes and
drives them from a chat app, so one run carries two kinds of model traffic. The gateway's own calls
are caught by the fetch hook. The coding agent's calls are caught by the ordinary variables — not
because OpenClaw reads them, but because **a child process inherits its parent's environment**, so
the Claude Code it spawns sees `ANTHROPIC_BASE_URL` exactly as it would if you had run it yourself.

```console
orca record openclaw
```

That inheritance is a property of the operating system rather than of orca, which is the kind of
thing that stays obviously true right up until some layer in between sanitises the environment. So
it has a test: a gateway fixture that makes no model call of its own, spawns an agent that does, and
is recorded and replayed offline through the grandchild's traffic.

### A base-URL variable orca has never heard of

Enumerating them is hopeless. Hermes overrides per provider, and its own `.env.example` carries
`NOVITA_BASE_URL`, `GLM_BASE_URL`, `KIMI_BASE_URL`, `MINIMAX_BASE_URL`, `HF_BASE_URL`,
`NEBIUS_BASE_URL` and a dozen more. A list baked into orca would be stale the week after it was
written, so name the variable instead:

```console
ORCA_BASE_URL_VARS='OPENROUTER_BASE_URL' orca record generic-openai -- hermes
ORCA_BASE_URL_VARS='GLM_BASE_URL,KIMI_BASE_URL' orca record generic-openai -- my-agent
ORCA_BASE_URL_VARS='SOMETHING_BASE_URL=/' orca record node -- node agent.mjs
```

Each name is pointed at the proxy with `/v1` appended, which is what an OpenAI-compatible override
wants; `=<path>` overrides that, and `=/` gives the bare origin.

If you record an agent this way and it works, an adapter is about twenty lines —
[docs/plugins.md](docs/plugins.md). If it does not, the trace is the most useful thing you can send:
`orca export last -o run.html`.

## When the harness will not be redirected

Base-URL injection captures every harness that reads a base-URL variable, and the fetch hook covers
the Node ones that do not. A Codex CLI signed in with a ChatGPT subscription is neither: it talks to
its own backend over TLS, so there is no origin to rewrite and no `fetch` of ours to reach.
`--tls-intercept` is the answer to that, and it is deliberately a separate decision you have to
make, because it mints a certificate authority.

```console
orca record codex --tls-intercept
orca record codex --tls-intercept --tls-hosts 'api.openai.com,*.chatgpt.com'
```

The CA is unique to the run, trusted only by the agent orca launches — through that child's own
environment, never a system or browser trust store — and deleted when the run ends. Orca will not
offer to install it anywhere. Hosts outside the allowlist are tunnelled unread and recorded as an
address and a byte count, with no path and no body, because orca never held the plaintext. Asking
to intercept everything is refused rather than honoured.

What comes back through it is not a log line. An intercepted request is parsed by the same wire
dialects as any other, so it lands in the trace as an ordinary exchange — replayable offline and
forkable to a different model, on a run that never had an API key of yours in it.

It works on `orca replay --model`, `orca fork` and `orca compare` too, which launch a live agent for
the same reason.

## For an agent, a script, or CI

A trace is a file, which is the one thing an observability dashboard cannot be — so the most useful
question about a failed run is one an *agent* can ask: *replay my last run and tell me what
diverged.* Every command answers as data, and orca serves itself over MCP.

```console
$ orca replay last --json
{"runId":"run_a278eea7b535","mode":"exact","traceRunId":"run_687e3f84b208","matchedExact":2,"divergences":0,"unmatched":0,"liveCalls":0,"exitCode":0}

$ orca show last --json | jq '.events[] | select(.kind == "TOOL")'
$ orca checkpoints last --json | jq '.[-1].seq'
```

One JSON document on stdout, diagnostics on stderr — including the recorded agent's own output, so
the document stays parseable while a run is talking. Failures answer in JSON too, with a non-zero
exit. `--json` covers `list`, `show`, `events`, `checkpoints`, `graph`, `record`, `replay`,
`compare` and `doctor`.

**As tools.** `orca mcp` serves the trace store to an agent over stdio:

```json
{ "mcpServers": { "orca": { "command": "orca", "args": ["mcp"] } } }
```

`orca_list_runs`, `orca_show_run`, `orca_checkpoints`, `orca_graph`, `orca_replay` and
`orca_compare`. Replay is free and offline; `orca_compare` says in its own description that it
spends real tokens, because a model choosing a tool reads that string and nothing else — and
`orca_graph` spends its description saying what `recorded` and `inferred` mean, for the same
reason.

**From code**, if you would rather not shell out:

```ts
import { Orca } from 'orcareplay';

const orca = new Orca({ cwd: process.cwd() });
const { unmatched, divergences } = await orca.replay('last');
const timeline = await orca.show('last');
```

It never writes to your stdout and never calls `process.exit` — both asserted, because a library
that does either cannot be built on.

## Status

Early. `v0` is the walking skeleton of the three commands above. Everything below is exercised by
1,393 tests, the trace-format conformance check and a plugin-API neutrality check, on Node 20 and 22.

| Capability | State |
|---|---|
| Trace format v0 + JSON Schema | working |
| Anthropic / OpenAI-compatible model capture | working |
| OpenAI Responses API capture | working — the format the OpenAI Agents SDK and the Codex CLI default to. Records, replays offline and forks; a fork stays on the wire format the agent speaks |
| Agents that read no base-URL variable | working — `orca record node -- <cmd>` writes a preload into the run directory and redirects `globalThis.fetch` for an allowlist of provider hosts. Node and Bun both, since Bun ignores `--require` in `NODE_OPTIONS`. This is how a Vercel AI SDK agent is captured |
| A call orca cannot read | working — forwarded rather than refused, and recorded as `net.request` / `net.response`: evidence, not a replayable turn. A recording that captured nothing warns instead of exiting clean |
| Machine-readable output (`--json`) | working — one JSON document on stdout, diagnostics on stderr, failures as JSON |
| Causal graph (`orca graph`) | working — what caused what, as a table or as JSON. Every edge says whether the trace recorded it or orca derived it just now, and names the rule either way. `--to N` narrows to the chain that produced one event |
| Shareable cards | working — `orca export --card` draws one causal chain, `--graph-card` draws the whole run with that chain lit, and `compare --share` draws the verdict table. `.svg` always; `.png` and `.gif` when the optional render toolchain is installed, which `orca doctor` reports and `npm ci` never pulls in |
| MCP server (`orca mcp`) | working — six tools over stdio, so an agent can read, explain and replay its own runs |
| Programmatic API (`Orca`) | working — the commands render what it returns, so the terminal is a view of one source of truth |
| Exact replay with divergence reporting | working — restores the recorded filesystem over your working tree, then puts it back; `--worktree` for a scratch copy, `--in-place` to restore nothing. Writes a run of its own recording what the replay *discovered* — divergences, unmatched requests — and points at the parent for what it merely repeated; `--no-trace` to skip |
| Fork replay from a checkpoint | working — a fork records its own filesystem snapshots, so it is a run you can fork again |
| Compare across models | working — `orca setup` stores a gateway (OrcaRouter by default, any URL you name otherwise), key and model list, so `orca compare` needs no flags |
| Filesystem snapshots and diffs | working |
| Single-file HTML export | working |
| MCP call recording | working — opt in with `--mcp-config <path>`. Replay and fork re-instrument from the config the recording used, so the layer does not stop at the fork point |
| Post-hoc scrubbing (`orca scrub`) | working |
| Shell capture (`PATH` shim) | working — exit codes, duration and the stdout/stderr split. `--no-shell` to skip |
| Non-model network capture | working — opt in with `--tls-intercept`; mints a per-run CA the launched agent alone trusts, decrypts an allowlist of hosts, tunnels the rest unread, and deletes the key when the run ends |
| Codex subscription model capture/replay | working — recognizes the `/backend-api/codex/responses` HTTPS fallback, decodes zstd request bodies for matching, and serves the recorded SSE response without opening the origin during replay |
| Validated against a real agent | Claude Code, recording a real fix to a real bug: recorded, replayed offline end to end, forked from a checkpoint and exported. It broke four things no fixture could have produced, all since fixed — [what a real agent found](docs/validation.md) |
| Subscription-auth harnesses | Claude Code works. A Codex CLI signed in with a ChatGPT subscription talks to its own backend, so there is no origin to rewrite: it needs `--tls-intercept`. With an API key it needs nothing special |

## Install

Not on npm yet — the packages are built and verified for it, but nothing has been published, so
today it is from source:

```console
git clone https://github.com/Continuum-AI-Corp/OrcaReplay && cd OrcaReplay
npm ci && npm run build
npm install -g ./packages/cli     # puts `orca` (and `orcareplay`) on PATH
orca doctor                       # checks node, git, and which agents it can find
```

`npm install -g .` from the repository root installs nothing: the root is a workspace with no
binary of its own, and `orca` lives in `packages/cli`.

The moment `v0` is published, `npx orcareplay doctor` is the whole install and this section will say
so instead. The release is a tagged, gated workflow — see [`RELEASING.md`](RELEASING.md).

**Node 20+ to run it** (the CLI's own `engines` says `>=20.0.0`). Contributing needs `^20.19.0 ||
>=22.12.0`, because the test toolchain does; the root `package.json` declares that separately so
`npm ci` tells you up front. No account, no signup, no API key changes.

On Windows, shell capture writes `.cmd` shims and can instrument `sh.exe` or `bash.exe` when a
POSIX shell such as Git for Windows is available. If neither is on `PATH`, `orca doctor` warns and
you can record with `--no-shell`.

## Where your runs are kept

Everything lands in **`.orca/runs/` inside the project you recorded in** — per-project, never a
global store, so a run travels with the checkout it belongs to. One run directory is one
self-describing thing:

```
.orca/
  .gitignore          # just `*` — the store excludes itself, so a trace cannot be committed by accident
  runs/run_d0a2ee7ce615/
    manifest.json     # who, when, which adapter, the git commit, counts, integrity digest
    events.jsonl      # the timeline, one JSON object per line, append-only
    blobs/            # content-addressed payloads over 4 KB, deduplicated
    fs/               # shadow git index: the workspace at every turn
    shell-frames.jsonl
    redactions.json   # what was removed, by rule and count — never by value
```

Finding an old session:

```console
orca list                       # every run here, newest first, with what it was forked from
orca show run_d0a2ee7ce615      # the timeline in the terminal
orca replay last                # `last` = newest recording (it skips replay traces)
orca replay run_d0a2ee7ce615    # or name one outright
orca gc --older-than 7d --dry-run   # what would be reclaimed, before anything is
```

`orca list` reads the run directories directly, so it works on a trace someone sent you: drop it in
`.orca/runs/` and every command sees it. Nothing indexes, and there is no database to corrupt.

## Privacy

Traces are local, mode `0600`, and the recorder makes no network connection of its own. Secrets are
redacted in the write path: environment capture is deny-by-default, auth headers are never written,
and known key shapes plus high-entropy strings are replaced with stable placeholders.

Redaction is best-effort mitigation, not a guarantee. **Treat a trace as sensitive** — roughly as
sensitive as a shell history plus a heap dump.

```console
orca export last -o bug.html          # prints exactly what it is about to write
orca scrub last --match my-hostname   # remove something after the fact
```

`orca scrub` rewrites `events.jsonl`, the manifest and every text blob, re-runs the standard
detectors, refreshes the integrity digest, and leaves binary blobs byte-identical.

It cannot rewrite the filesystem snapshots. Git objects are addressed by the hash of their own
contents, so editing one changes its id, which forces every tree naming it to be rewritten and
every event naming those trees after that — a history rewrite whose failure mode is a run that no
longer restores. So scrub *searches* the snapshot store and tells you when your string is still in
there, rather than reporting a clean trace it could not clean. `--drop-fs` deletes the store
outright, at the cost of being able to fork the run.

## What is open, and what is not

Always open, under Apache-2.0: the trace format, the core, the CLI, the viewer, the adapters, and
the provider interface.

OrcaReplay is built by the people who build [OrcaRouter](https://www.orcarouter.ai), and that shows
up in two places, both of them things you asked for. `orca setup` suggests it when you do not name a
gateway — a default you can see and overtype, on a question you chose to answer, not a route
anything takes on its own. And an artefact you explicitly generate — an export, a `--share` card —
signs itself "built by the OrcaRouter.ai team", the way a chart carries its source.

Every model path stays a plain URL you can point anywhere, there is no code path that treats that
origin differently from any other, and a credit line routes nothing anywhere.

What the vendor does *not* get is privilege. A plugin — OrcaRouter's included — may use only the
public `Provider` interface in `@orcareplay/plugin-api`, with no private API behind it. No vendor
plugin exists yet, so the CI job that enforces this (`scripts/check-neutrality.mjs`) says so and
passes as a no-op; it starts building against the published package rather than workspace source the
moment one lands. If a plugin ever needs a capability, that capability goes into the public
interface first, with a second implementation showing it is not shaped around one vendor.

## Documentation

**Start here if you have a problem right now:**

- [My agent broke something. How do I find out why?](docs/how-to/debug-a-failing-agent-run.md)
- [Why did my agent delete that file?](docs/how-to/why-did-my-agent-delete-my-file.md)
- [Would a different model have got this right?](docs/how-to/compare-models-on-the-same-failure.md)

**Reference:**

- [`spec/orca-trace-v0.md`](spec/orca-trace-v0.md) — the normative trace format
- [`docs/architecture.md`](docs/architecture.md) — how capture, replay and fork actually work
- [`docs/validation.md`](docs/validation.md) — what broke the first time this met a real agent
- [`docs/launch-path.md`](docs/launch-path.md) — what is built, what is not, and what is next
- [`docs/plugins.md`](docs/plugins.md) — writing an adapter or a provider
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — five-minute dev loop
- [Good first issues](docs/good-first-issues.md) — twelve of them, with the file to start in

## Help wanted

The format is v0 and the walking skeleton works, which is the interesting point in a project's life:
the decisions are still cheap to change and there is a lot of obvious work with the file to start in
already written down.

- **[Twelve good first issues](docs/good-first-issues.md)**, each naming the file and the test.
- **Write an adapter.** One file, one fixture. If your harness reads a base-URL variable it is
  about twenty lines — [docs/plugins.md](docs/plugins.md). If it does not, `node` may already cover
  it; a recording that comes back empty from a harness not listed [above](#which-agents) is worth
  an issue either way.
- **Prove LangGraph.** It should work through the official clients and nothing here tests it. An
  end-to-end test against a stub upstream would turn a "should" into a row that CI can turn red.
- **Reimplement the reader.** The spec is CC BY 4.0 on purpose. There is already a Python reader;
  Go and Rust are open.
- **Break the replay.** The matching ladder is the heart of this and the fastest way to improve it
  is a real recording it gets wrong. Open an issue with `orca export last -o bug.html` attached — it
  is one self-contained file, and `orca scrub` is there for anything you need out of it first.

If it saved you an afternoon, a ⭐ helps other people find it.

## License

Apache-2.0 for the code. The trace specification is CC BY 4.0, so anyone may reimplement it.

---

<sub>
Built by the OrcaRouter team ·
<a href="https://www.orcarouter.ai">orcarouter.ai</a> ·
<a href="https://www.orcarouter.ai/models">all models</a> ·
<a href="https://www.orcarouter.ai/code-review">OrcaCode Review</a> ·
<a href="https://x.com/OrcaRouter">X</a> ·
<a href="https://huggingface.co/orcarouter">Hugging Face</a>
</sub>
