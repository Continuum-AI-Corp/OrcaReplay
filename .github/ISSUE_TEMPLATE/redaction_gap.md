---
name: Redaction gap
about: A secret shape OrcaReplay failed to redact — or wrongly redacted
labels: security, redaction
---

> **Do not paste the actual secret.** Describe its *shape*, or use an obviously fake example of the
> same form. If a real credential of yours reached a trace, rotate it first.

## Which case

- [ ] A secret shape that was **not** redacted (missed)
- [ ] Ordinary content that **was** redacted (false positive)

## The shape

e.g. `xyz_live_` followed by 32 base62 characters. A link to the issuing service's documented token
format is ideal.

## For a false positive

Paste the content that was wrongly redacted, if it is not sensitive. These matter as much as
misses: traces are mostly source code, and the entropy rule already needed a mixed-alphabet guard
because `getUserAuthenticationTokenFromRequestHeaders` scores 4.08 bits per character. Corrupting
the payload the trace exists to preserve is its own kind of bug.

## Environment

- `orca --version`:
- Where it appeared (model request, shell output, file contents, environment):
