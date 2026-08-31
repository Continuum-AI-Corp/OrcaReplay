# Launch path: v0 to a demo people can run

> **Status.** W3.1, W3.2, W3.3 and W3.4 are shipped, and so is a fifth block that was missing
> from this plan entirely — the agent-native surface in section 5 — see the commits on this branch. The Responses
> API is recorded, replayed offline and forkable; a call orca cannot read is forwarded rather
> than refused; and a run that captured nothing says so. The table below is updated to match.
> Everything else is still as written.

Four blockers stand between the current repository and a launch that converts. Three are
distribution problems with the engineering already done. One is a real hole, and it is not the
one it looks like from the outside.

This document is a build plan, not a roadmap: every item names what it is, why it comes when it
does, and the observation that says it is finished.

## The correction to the brief

The concept rates well and the traction does not, which reads as a marketing problem. It mostly
is — `release.yml` already runs the full gate, tag-matches the version and publishes every
workspace in dependency order with provenance, so getting on npm is a token and a tag.

But recording an **OpenAI Agents SDK** app or a **Codex CLI** run today does not merely capture
nothing. It breaks the agent outright, and that has to be fixed before a video invites anyone to
try it — because the first thing a viewer does after watching is point it at their own stack.

## What actually happens today, per framework

| Target | Base-URL redirect | Wire format | Result under `orca record` |
|---|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL` | `/v1/messages` | **Works.** Adapter shipped, validated against a real bug-fix run. |
| OpenAI Agents SDK | `OPENAI_BASE_URL` ✓ | `/v1/responses` | **Works** *(was: broke on turn one)*. Recorded, replayed offline, forkable. |
| Codex CLI | `OPENAI_BASE_URL` ✓ | `/v1/responses` | **Works** *(was: broke on turn one)*. On a ChatGPT subscription it still needs `--tls-intercept` first. |
| LangGraph / LangChain | `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` | chat completions | **Should work.** Goes through the official clients, which read both. Still never tested, still undocumented — W3.5. |
| Vercel AI SDK | none — redirected at `globalThis.fetch` | chat completions / `/v1/responses` | **Works** *(was: silent)*. `orca record node -- node app.mjs` installs a fetch hook; recorded, replayed offline. |

Two failure modes, and the quiet one is worse in the long run.

`packages/proxy/src/server.ts` rejected any path no dialect claimed, and `dialects.ts` claimed
exactly two shapes: `/v1/messages`, and anything ending `/chat/completions`. Nothing in the
repository handled `/v1/responses` outside two prose comments. So a developer who read the README,
installed, and typed `orca record codex` watched their agent die on the first turn.

Verified rather than reasoned about: an agent that speaks the Responses API, run against a build
of commit `897657d` in a worktree, is handed `404 from …/v1/responses` and exits 3 with zero
exchanges recorded. Against this branch the same agent records twelve events and replays offline
at `reused=2/2 exact=2 divergences=0 unmatched=0`.

The Vercel AI SDK failure is quieter: the agent runs, exits 0, and writes a trace with zero model
exchanges. `packages/adapters/src/contract.ts` names this exact shape as the thing it exists to
prevent — "every run still *looks* fine … nothing to see until a user files a confusing bug." The
contract checks catch it in adapters; nothing caught it at the end of a real run. It does now — and the
traffic is captured too, through the runtime hook in W3.4.

## 1. One-command install

The cheapest blocker on the list. What is missing is the npm name, a token and a tag.

The README says "Not on npm yet" twice in the first screen. For a tool asking to sit inside an
agent loop, that line costs more trust than the install friction it explains.

| | Work | Done when |
|---|---|---|
| **W1.1** | Publish v0.1.0 — claim `orcareplay` and the `@orcareplay` scope, add `NPM_TOKEN`, run the workflow's dry run, tag. | `npx orcareplay@latest doctor` runs on a clean machine. |
| **W1.2** | Bundle the CLI into one tarball. It pins ten internal packages at exact versions, so `npx` resolves eleven tarballs before printing anything; `esbuild` is already a dev dependency. | Cold `npx orcareplay` starts in under five seconds. |
| **W1.3** | `orca quickstart` — ships a sample project and a recorded failing trace, then runs the whole story against them offline: show, replay, fork, viewer. No key, no agent installed, no network. | A stranger with only Node 20 sees the fork produce a passing test. |
| **W1.4** | Rewrite the install section. Three commands at the top become `npx orcareplay quickstart`; source install moves to Contributing. | The first code block a visitor sees is runnable. |

W1.3 is what turns a video watcher into a user, and it is the call to action the video ends on.

## 2. A demo with a failure in it

The existing hero GIF runs record, replay, compare — and the comparison table ends `pass / pass`.
It is honest and it is not a story. The five-beat narrative needs something visibly, gradeably
wrong: **record, failure, offline replay, fork at the failure, a different model fixes it.**

**Build the demo as a trace, not as a live run.** This is the important decision. A demo that
re-records live rots the week a model updates, and it cannot be re-shot without the failure
reappearing on cue. Record the failing run once, commit it under `examples/traces/`, and let the
video, the quickstart and the docs all replay that artifact offline. The product's own guarantee
becomes the production pipeline for its own marketing.

| | Work | Done when |
|---|---|---|
| **W2.1** | The scenario repo: a bug a weak model reliably gets wrong and a strong one reliably gets right, graded by `npm test`, under ten turns. Candidates that behave this way: a DST boundary in date arithmetic, an off-by-one in pagination, a validator that passes only the happy path. | The fork verdict is fail → pass on the same checkpoint, ten times running. |
| **W2.2** | Record it, scrub it, validate it in CI beside the existing conformance job. It is the demo asset, the quickstart fixture and a permanent replay regression test at once. | `orca replay` of it reports `unmatched=0` in CI. |
| **W2.3** | Three cuts from one shoot: 15s silent captioned loop, 60s README and landing hero, 3min narrated walkthrough. Keep `docs/media/README.md`'s rule — every frame traceable to real captured output. | The 15s cut reads without audio and without pausing. |

### Beat sheet, 60-second cut

| Time | Beat |
|---|---|
| 0:00 | The claim, as a problem: "Your agent said it fixed the test. The test is still red." |
| 0:06 | `orca record claude` — the agent works, announces the fix, exits 0. |
| 0:14 | `npm test` — red. The beat the current GIF is missing entirely. |
| 0:20 | `orca show last` — the timeline names the moment: a SHELL event at `exit 1` the agent ran and ignored. Hold on that row. |
| 0:30 | `orca replay last`, network cut, on screen. Same failure byte for byte, zero tokens. |
| 0:40 | `orca replay last --from 4 --model <stronger>`. Same files, same prefix, one variable. Green. |
| 0:52 | `orca compare` — fail/pass with the cost column, one second of the share card. |
| 0:57 | `npx orcareplay quickstart`, alone on screen. |

## 3. Integrations beyond raw CLI capture

The only blocker with substantial engineering in it. Ordered so the things that *break* agents
land before the things that merely miss them.

| | Work | Done when |
|---|---|---|
| **W3.1** ✅ | **Shipped.** Never `404` an unknown path — forward and record it opaquely instead. An unrecognised endpoint should degrade to "captured but not replayable", never to a dead agent. Makes every future integration fail softly. | An agent posting to an unknown path completes its run, and the trace says why that turn cannot be replayed. |
| **W3.2** ✅ | **Shipped.** Warn at the end of `orca record` when zero model exchanges were captured, with the likely cause. The empty-trace failure must never be silent. | Recording an unconfigured Vercel AI SDK app produces a warning, not a clean exit. |
| **W3.3** ✅ | **Shipped.** A Responses API dialect: matches `/v1/responses`, translators in `providers/src/translate/`, SSE delta parsing, `withModel` so forks work. Unblocks the OpenAI Agents SDK and Codex at once. The dialect interface is already built for exactly this — the proxy is handed a list and knows nothing about which exist. | A Codex run records, replays offline and forks. |
| **W3.4** ✅ | **Shipped.** `@orcareplay/node-instrument`: a Node `--import` hook rewriting provider origins on `globalThis.fetch`, injected by `orca record` through `NODE_OPTIONS`. Environment variables cannot reach the Vercel AI SDK, so reach the runtime. Covers every JS agent that hardcodes a base URL — a class, not a vendor. | An unmodified `@ai-sdk/openai` app records and replays. |
| **W3.5** | Prove LangGraph rather than assuming it: a `langgraph` adapter id, an end-to-end test against a stub upstream, a how-to. Check its thread and checkpoint ids survive redaction — the entropy sweep has already eaten round-tripping protocol identifiers twice. | A two-node graph records, replays and forks in CI. |
| **W3.6** | Run `checkAdapterContract` as a per-integration matrix job and generate the README support table from the result. | "We support X" is a check, not a sentence. |

## 4. Proof that replay is reliable and traces are safe

The machinery is already unusually good: allowlist-only environment capture, one shared
auth-header list, an entropy sweep with protocol-identifier exemptions, a policy version that
bumps when rules change, `orca scrub`, an integrity digest — and a genuinely honest limitation,
where scrub *searches* the filesystem snapshots and reports what it could not clean rather than
claiming a clean trace.

What is missing is not mechanism. It is published numbers. Every claim is currently prose, and
prose does not clear a security review.

| | Work | Done when |
|---|---|---|
| **W4.1** | Replay fidelity scoreboard: a corpus of real recordings, one per supported harness, replayed in CI with assertions on `unmatched=0` and a divergence budget. Generate `docs/fidelity.md` and a badge from the run. | "Replay is reliable" is a number that regresses visibly. |
| **W4.2** | Redaction benchmark covering every rule plus the hard cases — keys split across SSE chunks, `.env` dumps in tool output, credentials inside git diffs, JWTs in shell stderr. Report recall per class and false-positive rate, and publish what still leaks. Publishing the misses is the credibility. | `docs/redaction-benchmark.md` ships with real numbers and a known-gaps list. |
| **W4.3** | `orca verify` — scan a trace and report what a detector can still find. Gate `orca export` on a clean scan or an explicit `--force`. The README asks users to send traces; make that ask safe to accept. | Exporting a trace containing a planted key refuses without `--force`. |
| **W4.4** | Assert the offline guarantee at the socket level in CI with DNS blackholed, and cite the test by name in the README. | The README's offline claim links to a test. |
| **W4.5** | Extend `SECURITY.md` with a trace threat model: what a trace contains, what redaction catches and provably does not, the snapshot limitation, and a decision guide for "can I attach this to a public issue?" | A security reviewer can answer their questions without opening the source. |

## 5. Agent-native surface

Not in the original four blockers, and it should have been. OrcaReplay was a human CLI with an
agent-readable file format: `TraceReader` and the Python reader make a trace easy to *read* from
code, but nothing let anything drive orca. `orca show` computed a timeline and formatted it away,
`orca list` returned `void`, and there was no `--json` anywhere — so a script, a CI job, or an
agent debugging its own failure had to scrape `info replay.done reused=2/2 exact=2 divergences=0`
out of stdout. The MCP shim in this repo is a *tee* that records an agent's own MCP traffic; it
never let an agent ask orca a question.

That is backwards for this product in particular. "Replay my last run and tell me what diverged"
is the most useful thing an agent could ask a replay debugger, and it is a question no
observability tool can answer — because a trace is a file, so an agent can fork it.

| | Work | Done when |
|---|---|---|
| **W5.1** ✅ | **Shipped.** An `Orca` class returning the work as data — list, show, events, checkpoints, record, replay, compare, export. The commands render what it returns, so the terminal is a view of one source of truth. Asserted: nothing writes to an embedding process's stdout, nothing calls `process.exit`. | `new Orca({cwd}).replay('last')` returns the numbers. |
| **W5.2** ✅ | **Shipped.** `--json`: one document on stdout, diagnostics on stderr, failures as JSON too. | `orca show last --json \| jq .events` works with nothing in front of it. |
| **W5.3** ✅ | **Shipped.** `orca mcp` — a stdio MCP server exposing `orca_list_runs`, `orca_show_run`, `orca_checkpoints`, `orca_replay`, `orca_compare`. Built on the framer the MCP shim already has, so no runtime dependency. `orca_compare` says in its own description that it spends real tokens. | An agent's MCP config can point at `{"command": "orca", "args": ["mcp"]}`. |

Two bugs the tests found here, both of which would have reached users:

- **`ReplayResult` never carried `unmatched`.** It has been in the `replay.done` line since the
  beginning and returned to no one, so every non-terminal caller had to scrape it back out — while
  `exitCode` folds it into a single bit. It is the number that says whether a replay reproduced
  the run.
- **Under `--json`, the recorded agent's own stdout landed in the middle of the document.**
  `stdio: 'inherit'` means the file descriptor, not the `process.stdout.write` an in-process test
  can replace, so seven assertions passed while `orca record --json | jq` would have choked. Both
  `record` and `replay` now route the agent's stdout to stderr under `--json`, keeping stdin and
  stderr inherited so a harness that prompts still can.

## Sequencing

The ordering is dependency, not preference. The video's call to action has to work, so publishing
precedes filming. The integrations have to stop breaking agents, because the first thing a viewer
does is point it at their own stack.

| Days | Phase |
|---|---|
| 1–2 | **Get on npm.** W1.1, W1.2, W1.4 — the highest-leverage two days available, mostly waiting on a token. |
| 2–5 | **Build the demo asset.** W2.1, W2.2, W1.3 — one artifact serving three purposes. |
| 3–8 | **Stop breaking agents.** W3.1, W3.2, then W3.3. Parallel with the demo work; the Responses dialect is the long pole. |
| 6–8 | **Shoot.** W2.3 — three cuts, one session, every frame from real output. |
| 8–12 | **Widen the surface.** W3.4, W3.5, W3.6. |
| 9–14 | **Publish the evidence.** W4.1 through W4.5. |
| 15 | **Launch gate.** |

Ship only if all four hold: `npx orcareplay quickstart` works cold; the video shows a real
fail-to-pass fork; no named integration `404`s; fidelity and redaction numbers are published.

## What not to build before launch

- **More README translations.** Eight languages ship before a single npm publish. Keep them,
  freeze them until v0.2.
- **A hosted service or dashboard.** "It is a file, and it works on a plane" is the whole
  differentiator against observability tools. A server undercuts the pitch.
- **More adapters for niche harnesses.** Five named integrations working beats twelve claimed;
  the generic adapter plus the runtime hook covers the tail.
- **Broadening `--tls-intercept`.** The current posture — per-run CA, agent-only trust,
  allowlisted hosts, refusing to intercept everything — is a security asset, not a limitation.
- **Reader ports to Go and Rust.** Good contributor work, zero launch impact. Leave them as good
  first issues.

## What to measure afterwards

| Signal | Target | Why this one |
|---|---|---|
| Time to first replay | < 90s | Landing on the repo to seeing a fork go green. The only funnel number that matters. |
| Quickstart completions | 40% of installs | Separates "starred it" from "ran it". |
| Traces filed as bug reports | > 5/week | Someone sending one has recorded a real agent on real work — the strongest adoption signal available, and it improves the matcher. |
| Non-Claude-Code recordings | > 30% | Tests whether the integrations landed, or whether this is still a Claude Code tool. |
| npm weekly downloads | trend | Lagging and gameable. Watch it, do not steer by it. |

---

The framework behaviours in the table above were checked against the proxy's dialect matching and
the adapter sources in this repository. The Vercel AI SDK finding tracks an open upstream request
for `OPENAI_BASE_URL` support and should be re-checked against the version you target before it
ships in user-facing docs.
