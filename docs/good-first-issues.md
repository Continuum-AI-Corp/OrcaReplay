# Good first issues

Real work, scoped so the first PR is a few hours rather than a weekend. Each one names the file to
start in and how you will know it worked.

The four categories are ordered by how much they help the project: an adapter brings a whole
agent's userbase, a provider unlocks a model nobody could fork onto, a redaction rule protects
everyone, and an analyzer proves the trace format is useful to people who did not write it.

## Adapters — support an agent we don't cover

**Start:** `packages/adapters/src/generic-openai.ts` is the smallest complete example.
**Done when:** `checkAdapterContract` passes and `packages/adapters/fixtures/harness/<id>.json`
records the env vars you verified against.

1. **Aider adapter.** Python-based; check whether it reads `OPENAI_API_BASE`.
2. **Continue adapter.** VS Code extension — the interesting question is where its model config
   lives and whether a base URL can be injected per-process.
3. **Cline adapter.** Same shape as Continue; both may need the opt-in CA mode instead.
4. **Goose adapter.** Block's agent; confirm its provider configuration path.

**Before writing one, answer one question:** does the agent respect a base-URL environment
variable? That single fact decides whether this is an afternoon or a week. Put the answer in the
issue even if you write no code — it is genuinely useful on its own.

## Providers — a model you can't currently fork onto

**Start:** `packages/providers/src/openai.ts`. Most APIs are OpenAI-shaped and need only a new
entry in `pricing.ts` plus a registry line.
**Done when:** round-trip translation tests pass and `priceFor` resolves your model's real id.

5. **Google Gemini provider.** The one major API that is not OpenAI-shaped; needs real translation.
6. **AWS Bedrock provider.** Model id resolution is the interesting part — `pricing.ts` already
   handles the `us.anthropic.…-v1:0` form, so start there.
7. **Pricing table refresh.** `MODEL_PRICING` will drift. A PR that updates figures and cites the
   source pages is welcome and easy to review.

## Redaction rules — a secret shape we miss

**Start:** `packages/core/src/redaction.ts`.
**Done when:** a test proves the shape is caught *and* a test proves a realistic near-miss is not.

8. **More key shapes.** Stripe (`sk_live_`), Twilio, SendGrid, npm tokens, Postgres connection
   strings with inline credentials.
9. **False-positive hunting.** The entropy rule already needed a mixed-alphabet guard because
   `getUserAuthenticationTokenFromRequestHeaders` scores 4.08 bits/char. Traces are mostly source
   code, so a PR that adds realistic code samples the redactor must *not* touch is as valuable as
   one that adds a rule.

## Analyzers — read a trace, find something useful

**Start:** `detectLoops` in `packages/viewer/src/render.ts` — about forty lines, no privileged
access, the model to copy.
**Done when:** it runs against `examples/traces/` and finds the thing it claims to find.

10. **Cost attribution by turn.** Which turn of a run actually spent the money.
11. **Thrash detector.** A file edited three or more times across turns with the tree returning to
    an earlier state — a loop the current detector misses because the tree is not identical.
12. **Context growth analyzer.** Plot input tokens per turn; a run that grows superlinearly is
    usually re-reading the same files.

## Before you start

Read [CONTRIBUTING.md](../CONTRIBUTING.md). The short version: write the failing test first and
watch it fail for the reason you expect, no new runtime dependencies without discussion, and if
you change the trace format, change `spec/orca-trace-v0.md` in the same PR.

Say hello on the issue before starting something large — we would rather have the conversation
early than have you guess.
