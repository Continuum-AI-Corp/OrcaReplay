---
name: Provider request
about: Ask for a model API you cannot currently fork onto
labels: provider, good first issue
---

## Which model API

Name, docs link, and whether it is OpenAI-shaped (`/chat/completions` with `messages`) or its own
thing. Most are OpenAI-shaped, and those are an afternoon.

## What you want to do with it

Usually one of: fork a recorded run onto this model, or compare it against models you already have.

## Want to write it yourself?

A provider is three methods — `models`, `invoke`, `price`. See `docs/plugins.md` and
`packages/providers/src/openai.ts`.

One rule worth knowing before you start: `price()` returns `null` for a model you do not have real
figures for. Never guess. A confidently wrong cost ends up in a comparison table someone makes a
decision from, which is worse than an absent one.
