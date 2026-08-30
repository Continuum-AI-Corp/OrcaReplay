# Proposal: the action graph, the model's reasoning, and a shareable artefact

Status: assessment, no code. Read against `d20d471`.

Three additions were suggested together: an action/causal graph over a run, the model's private
chain-of-thought, and an artefact with a UI. This is what each would actually cost, and what each
would actually buy.

The short version: the expensive half of all three is already in the repository, and the thing that
would make the project spread is none of them.

## What is already here

| Piece | Where | State |
|---|---|---|
| `causes` — a normative causal DAG on every event | `spec/orca-trace-v0.md:40` | shipped |
| `causalChain()` — transitive backward walk | `packages/core/src/graph.ts:117` | written, tested, **no caller** |
| `thinking` block in the canonical IR | `packages/plugin-api/src/canonical.ts:12` | parsed, then dropped |
| Reasoning read in all three wire dialects | `translate/anthropic.ts:140`, `openai.ts:320`, `openai-responses.ts:117` | shipped |
| Thinking signature survives redaction so forks replay | `packages/core/src/redaction.ts:131` | shipped |
| Single-file HTML export, zero external references | `packages/viewer/src/export.ts` | shipped, CI-asserted |

A format that can express causality, and translators that can read reasoning out of three different
protocols, are the hard parts. What is missing is the code that connects them to a reader.

## 1. The action / causal graph

`causes` is populated in exactly three places today: a tool result points back at its call
(`cli/src/commands/record.ts:193`), a shell result at its exec (`:312`), and a network response at
its request (`cli/src/tls-capture.ts:180`). That is enough to pair things up and not enough to
answer *why did it delete my migration file* in one hop.

Four edges are missing, and they are two different kinds of missing.

### Observed — write them into `causes`

These are not inferences. A `tool_use` block is physically inside the response that emitted it, and
a `tool_result` block is physically inside the request that carried it back. `ExchangeEventDeriver`
holds both and simply does not record the relationship.

- **`model.response` → `tool.call`.** The loop at `cli/src/exchange-events.ts:117` already iterates
  the response's tool uses. The `persist()` loop in `record.ts:190` needs to remember the seq of the
  `model.response` it just appended — the same seq-patch-back shape as `markPending()`, a few lines
  away.
- **`tool.result` → `model.request`.** Results are derived *before* the request in the same batch
  (`exchange-events.ts:60`), so their seqs are known by the time the request event is written. The
  edge goes on the request, naming the results.

### Inferred — derive them, never write them

Attributing a file change or a shell command to a *specific* tool call is guesswork. Snapshots are
taken once per turn (`cli/src/fs-events.ts:50`), not once per tool call, and shell frames are
drained after the agent exits and bucketed into turns by wall clock (`record.ts`, `turnAt()`).
Matching a changed path against a tool call's `input.path`, or an argv against a Bash call's
command, is right most of the time and wrong exactly when a run is interesting.

**The rule to hold:** recorded edges go in `causes`; inferred edges are derived at read time and
never written — the same discipline already applied to checkpoints, which spec §3 defines as derived
and never recorded. A normative field that sometimes contains a guess is a field no third-party
reader can trust.

### Where it lands

Extend `packages/core/src/graph.ts` with `runGraph(events)` returning nodes plus typed edges
(`recorded` | `inferred`, with the inference rule named on each). Expose `orca graph <run> --json`
alongside the other `--json` commands, add it to the MCP tool set so an agent can ask what caused
seq N, and render it in the viewer. `causalChain()` finally gets a caller.

No format change and no version bump: `causes` is already normative and already optional.

## 2. The model's private reasoning

The closest to done. Reasoning is parsed into `{ type: 'thinking', text }` by all three translators
and then never becomes an event — `derive()` collects tool uses out of the canonical response and
nothing else. The extraction is roughly fifteen lines next to `collectToolUses()`: `thinking_chars`
and `thinking_blocks` in `attrs`, the text to a blob, which the 4 KB spill rule already handles.

The raw provider bytes are recorded regardless, so **every trace already on disk contains this**. It
is a read-path feature, not a capture-path one.

### What "private" honestly means, per provider

| Source | What comes back | Fidelity |
|---|---|---|
| Anthropic extended thinking | Full thinking text plus a signature over it | verbatim |
| Chat-completions `reasoning_content` (DeepSeek, Qwen, GLM) | Full reasoning text | verbatim |
| OpenAI Responses `reasoning` items | Only the `summary` parts — `openai-responses.ts:117` | summary only |
| `redacted_thinking` / encrypted reasoning | Opaque ciphertext, no canonical home | unreadable |

Label this per turn in the UI. A capability row that says "private chain-of-thought: works" is the
row that ends up being the thing that is wrong — the same reason `orca models` prints a dash rather
than inventing a price.

### The payoff

The interesting artefact is not the reasoning on its own. It is the reasoning set against what the
harness actually did and what the terminal actually showed, and orca is the only layer holding all
three: *the model said it would verify the fix; the transcript never showed a verification; seq 12
says the check exited 1 and the run exited 0.*

### The privacy consequence

Reasoning is the highest-density source region in a trace — verbatim code, real paths, and the model
restating the task in the clear. The README already says to treat a trace as a shell history plus a
heap dump; this raises that bar, and it lands in exactly the artefact people are encouraged to
attach to public issues.

So: capture by default (local, `0600`, no change in posture), but **strip it from `orca export` by
default** behind `--include-thinking`, extend `orca scrub` to cover thinking blobs, and keep the
existing behaviour where export prints exactly what it is about to write. The signature handling at
`redaction.ts:131` is the precedent — that care has to extend to the new blob, or forks of thinking
turns break.

## 3. The artefact with a UI

The export already is a self-contained artefact: one HTML file, no external reference of any kind,
CI-asserted. That property is why it renders from a download folder, on a plane, in five years, and
it has to survive this.

- **A graph pane beside the timeline.** Select an event, its causal chain highlights — precisely
  what `causalChain()` already returns. Inferred edges render dashed, so the reader can see which
  links the trace vouches for.
- **A reasoning lane.** Collapsed per model turn, expandable, tagged with the fidelity above, and
  simply absent when export stripped it rather than shown as an empty panel.
- **No library.** Layout plus inline SVG covers both. A graph library would either break the
  zero-external-reference guarantee or inflate a bug report to megabytes.

Scope trap: a graph pane that draws all 400 events of a real run is a hairball, and strictly worse
than the list beside it. Default to one turn plus the selected chain, and let the timeline stay the
index.

## Does this make the project spread?

Two things get conflated. *Screenshot-worthy* is having something surprising to show.
*Spreadable* is a third party opening it with nothing installed. These features make orca good at
the first and leave the second untouched.

A causal chain from a prompt to a deleted migration file, in five hops, is a more compelling image
than a cost table, and the reasoning panel is better still — "here is what the model was actually
thinking when it did that" is something no dashboard can show and most engineers have never seen for
their own agent.

But `orca export last -o bug.html` produces a *file*. Files get attached to issues; links get
posted, quoted and reshared. Every developer tool that spread on the back of an artefact — a shared
flamegraph, a trace permalink, a REPL link — spread on a URL a stranger could click.

And the fix cuts against two stated principles: the zero-external-reference guarantee, and treating
a trace as sensitive. So it has to be built the way `orca setup` already handles its gateway
default. The offline file stays the default; `orca share` is opt-in, runs scrub, strips reasoning
unless explicitly asked, prints exactly what it will upload, and returns a link. A default you can
see and overtype, on a question you chose to answer.

Ranked by leverage:

| Surface | What it drives | Leverage |
|---|---|---|
| A pasteable link to a run | reach — a stranger opens it with nothing installed | highest |
| Private reasoning vs. what the harness showed | acquisition — the surprising screenshot | high |
| `compare --share verdict.svg` (already shipped) | acquisition — "both pass, one costs 15× less" | high, underused |
| Causal graph | retention — makes a 400-event run navigable | moderate |

Worth noticing before adding two more features to promote: the most viral thing in the repository
may already be built. A card showing two models passing the same test with a 15× cost gap is a post,
and it currently ships as an SVG flag on a subcommand.

## Build order

1. **The two observed edges, `runGraph()`, and `orca graph --json`.** No format change, no version
   bump. Gives the MCP server a "what caused seq N" tool and `causalChain()` its first caller.
   Touches `core/graph.ts`, `cli/exchange-events.ts`, `cli/commands/record.ts`.
2. **Reasoning extraction, with export stripping it by default.** Fifteen lines of extraction and
   rather more privacy work: the export default, the scrub coverage, the signature care. Works
   retroactively on traces already on disk. Touches `cli/exchange-events.ts`, `core/redaction.ts`,
   `cli/commands/scrub.ts`, `viewer/export.ts`.
3. **Viewer: graph pane and reasoning lane.** The largest chunk, and product design rather than
   plumbing. Inline SVG only, so the single-file guarantee holds.
4. **`orca share`.** A product and privacy decision before it is a coding one, and the step that
   actually moves the virality needle. Hosting anything means the project holds other people's
   traces.

## Risks

- **Inferred edges written into `causes`.** That makes a normative field lie, and every third-party
  reader of the spec inherits the lie.
- **Reasoning leaking through a shared artefact.** The feature that makes the artefact worth sharing
  is the same one that makes sharing it dangerous. Default off in export.
- **Promising "private chain-of-thought" flatly.** Responses gives summaries and encrypted reasoning
  gives nothing. Label fidelity per turn.
- **A graph that is a hairball.** Scope to one turn plus the selected chain.
