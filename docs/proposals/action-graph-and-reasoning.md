# Proposal: the action graph, and an export that produces a picture

Status: scoped. Read against `d20d471`.

Three additions were suggested together: an action/causal graph over a run, the model's private
chain-of-thought, and an artefact with a UI. **The scope is now the first and the third — the graph,
and a picture export — with reasoning deferred.** Sections 1 and 3 are the plan; section 2 is kept
for why deferring it is the right call.

The two compose: the graph is what makes a picture worth taking, since a screenshot of a timeline
list is a screenshot of a list. And the expensive half of both is already in the repository — the
trace format already declares a causal DAG, and `scripts/` already contains a working GIF encoder.

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

## 2. The model's private reasoning — deferred

Cut from the first build, and the cut buys more than it costs: reasoning is the entire privacy
blocker in this plan, and it would land in exactly the artefact section 3 is about to make
easier to share. Building the sharing path first means it is hardened before anything sensitive
travels down it. Nothing is lost by waiting.

It is the closest to done of the three. Reasoning is parsed into `{ type: 'thinking', text }` by
all three translators and then never becomes an event — `derive()` collects tool uses out of the
canonical response and nothing else. The extraction is roughly fifteen lines next to
`collectToolUses()`: `thinking_chars` and `thinking_blocks` in `attrs`, the text to a blob, which
the 4 KB spill rule already handles.

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

## 3. A picture, not just a page

The export already is a self-contained artefact — one HTML file, no external reference of any kind,
CI-asserted. That property is why it renders from a download folder, on a plane, in five years, and
it survives all of this. What it is not is a *picture*, and a picture is what travels.

### The repository has already decided this once

`scripts/render-demo.mjs` renders the README hero, and its header comment answers the format
question outright:

> A GIF rather than an animated SVG because GitHub, X and HN all render a GIF the same way, and a
> README that only animates in some places is worse than one that animates nowhere.

So this is not a new decision. The encoder is about thirty lines of `gifenc` with one quantised
palette built from the final frame, and it already uses the technique a chain animation needs —
**one frame per state change, with the hold expressed as that frame's delay**, because 107
near-identical PNGs made a 5.5 MB GIF and 22 self-timed frames said the same thing
(`render-demo.mjs:97`).

The constraint is stated just as plainly in `docs/media/README.md`: `playwright-core`, `pngjs` and
`gifenc` are *deliberately* not in `package.json`, so `npm ci` stays lean for everyone not
regenerating README art. That policy is the real design constraint here, and it should be kept.

### Which format

| Where it lands | SVG | PNG | GIF |
|---|---|---|---|
| GitHub issue / README | renders | renders | animates |
| X | not an accepted upload | renders | animates |
| Slack / Discord | no reliable inline preview | renders | animates |

`packages/cli/src/share-card.ts` proves the cheap path works — 118 lines, no dependencies,
monochrome, explicitly built to "survive being dropped into an issue, a README, a chat window, or a
dark-mode client". But SVG is the one raster-free format, and the places that spread things want a
raster.

**So: SVG is the source, PNG and GIF are the shareable outputs, and the rasterizer is the only new
dependency.** Keep SVG dependency-free so the command always works; make PNG and GIF opt-in, and
have `orca doctor` report whether the render toolchain is present — the same way it already warns
about a missing POSIX shell and lets you carry on with `--no-shell`.

Worth doing in the same slice: `compare --share` already produces the best shareable asset in the
project and produces it *only* as SVG, the one format X will not take. A PNG output on that existing
flag is a handful of lines against an encoder already in the tree.

### What the picture shows

One chain ending at the thing that went wrong — which is exactly what `causalChain()` returns, and
why section 1 has to land first. From the README's own bug hunt:

```
Why did this run exit 0 when its own check failed?
run_6473f858b59e · claude-opus-5 · causal chain, 6 events

 seq 3   model.response   stop: tool_use
 seq 4   tool.call        edit_file auth.ts
 seq 6   fs.change        auth.ts +1 −3                    (inferred edge)
 seq 11  shell.exec       node --check nonexistent-file.ts (inferred edge)
 seq 12  shell.result     EXIT 1
 seq 13  run.end          exit 0 — the agent's code, not the check's

dashed = inferred, not recorded
```

Two deliberate choices. The title states the claim as a *question*, because a card people forward
has to carry its own context. And the legend ships on the card, because a dashed edge in a picture
that travels without its trace launders a guess into a fact — the same discipline that makes
`renderCompareCard` print the verify command next to the costs.

**Picking the chain is the hard part**, and it *is* the feature. A defensible default: the chain
ending at the run's most interesting event — a non-zero `shell.result`, an `error`, a `divergence`,
else the last `fs.change` — with `--seq N` to name one outright. When nothing stands out, refuse
rather than draw an arbitrary chain; a bad card gets screenshotted anyway.

### The animation

Render the card with hops revealed one at a time, screenshot once per state, carry the hold in each
frame's delay. Roughly eight frames: title, one per hop, the failing hop held long, the full card
held longest before it loops. A 720×322 monochrome card quantised to 32 colours lands well under a
couple of hundred kilobytes — the existing hero GIF is a far busier scene through the same encoder.

**What not to build:** a GIF of `orca ui` playing the run back. That exists as a docs asset because
it is a scripted, hand-trimmed *demo of the product*. Generated automatically from an arbitrary
400-event run it is a long scroll with no climax, and nobody watches a forty-second GIF in an issue
thread.

## Does this make the project spread?

Two things get conflated. *Screenshot-worthy* is having something surprising to show. *Spreadable*
is a third party opening it with nothing installed. A causal chain from a prompt to a deleted
migration file, in five hops, is a far more compelling image than a cost table — and as a PNG or GIF
it is finally postable where people post.

This does not fully solve distribution: a card is still an image someone has to attach, not a link
someone can click, and `orca share` remains the larger question. But it is the cheap two-thirds of
the answer, it reuses an encoder already in the tree, and it carries no privacy decision — which is
exactly why it is the right thing to build before reasoning.

## Build order

1. **The two observed edges, `runGraph()`, and `orca graph --json`.** No format change, no version
   bump — `causes` is already normative and already optional. Gives the MCP server a "what caused
   seq N" tool and `causalChain()` its first caller. Everything below depends on it.
   Touches `core/graph.ts`, `cli/exchange-events.ts`, `cli/commands/record.ts`.
2. **`renderChainCard()` — SVG, zero dependencies.** Same idiom and same file as
   `renderCompareCard`. `orca export last --card chain.svg`. This is the artefact that has to exist;
   everything after it is a format conversion. Touches `cli/share-card.ts`, `cli/commands/inspect.ts`.
3. **PNG output, for both cards.** Promote the rasterizer out of `scripts/` into a real module, keep
   it opt-in, and have `orca doctor` report whether it is present. Do `compare --share --png` in the
   same slice.
4. **GIF — the chain resolving, one frame per hop.** The encoder exists and the technique is proven
   at `render-demo.mjs:97`. The smallest slice of the four, once step 3 has settled the dependency
   question.

Deferred: reasoning extraction and the viewer's graph pane. Neither blocks the above, and the first
carries a privacy decision better made after the sharing path is hardened.

## Risks

- **The wrong chain.** Auto-selection is the whole feature. A card showing an arbitrary chain is
  worse than no card, because it gets screenshotted anyway. Refuse rather than guess.
- **Inferred edges written into `causes`,** or drawn on a card with no legend. Either launders a
  guess into a fact, and the second does it in public.
- **The render toolchain creeping into `package.json`.** `docs/media/README.md` is explicit that it
  stays out so `npm ci` stays lean. Degrade to SVG and let `doctor` explain, rather than reversing
  that quietly.
- **Staleness with no test.** The existing note is blunt: "a GIF has no test." Generated cards are
  per-run rather than checked in, but the *renderer* needs a snapshot test or the card drifts from
  what the commands actually print.
