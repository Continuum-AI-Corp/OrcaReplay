---
name: Adapter request
about: Ask for support for an agent harness we do not cover
labels: adapter, good first issue
---

## Which agent

Name, repo link, and how you install it.

## How it talks to a model

Does it respect `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `OPENAI_API_BASE`? If you know, say so —
that single fact decides whether an adapter is an afternoon or a week.

## Want to write it yourself?

An adapter is two methods (`detect` and `prepare`). See `docs/plugins.md` and the existing ones in
`packages/adapters/src/`. We will review quickly and help.
