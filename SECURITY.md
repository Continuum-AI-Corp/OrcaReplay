# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/Continuum-AI-Corp/OrcaReplay/security/advisories/new)
rather than a public issue. We aim to acknowledge within three working days.

## The threat model, stated plainly

An OrcaReplay trace contains full model requests, tool results, shell output, file contents and
selected environment. **That is a near-perfect credential harvester if we get it wrong**, so
redaction is in the write path from the first commit rather than bolted on later.

What we do:

- Environment capture is **deny-by-default** — nothing is recorded unless allowlisted. The inverse
  is unshippable, because the interesting secrets are always the ones nobody thought of.
- Auth material (`authorization`, `x-api-key`, `cookie`, `proxy-authorization`) is never written,
  even redacted in place. It is replaced with a salted, stable placeholder so replay still matches
  structurally and repeated occurrences still compare equal.
- Known key shapes and high-entropy strings are replaced by the same mechanism.
- Filesystem capture excludes `.env*`, `.ssh/`, `.aws/`, `.netrc`, `*.pem`, `*.key`, `id_*`.
- Trace files are written mode `0600`.
- The recorder opens no network connection of its own and sends no telemetry. It passes through
  only what your agent was already sending.
- The local viewer binds `127.0.0.1` only.
- Trace content is treated as untrusted input by the viewer and is escaped before rendering.

**What we do not promise:** redaction is best-effort mitigation, not a guarantee. Treat a trace as
sensitive material. `orca scrub` removes material after the fact; `orca export` prints what it is
about to write.

## The MITM capture mode

Base-URL injection is the default and covers every supported agent. The optional CA mode exists for
harnesses that ignore base-URL environment variables. When used, the CA is generated per run, lives
in the run directory, and is **never installed into a system trust store**. If a tool ever asks you
to install its CA system-wide, that is worth refusing — including this one.
