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
- Auth material (`authorization`, `x-api-key`, `cookie`, `proxy-authorization`) is forwarded
  upstream — an agent that cannot authenticate cannot run — and dropped at the proxy before the
  exchange reaches the writer. It is never written at all, redacted or otherwise.
- Everything that *is* written goes through the redactor: known key shapes (private key blocks,
  JWTs, `sk-`, `gh[posur]_`, `AKIA…`, `xox[baprs]-`, `AIza…`) and high-entropy tokens become
  `<secret:kind:hash8>`, hashed with a per-run salt that is never persisted. The same secret always
  yields the same placeholder, so replay still matches structurally and repeated occurrences still
  compare equal, while the secret itself is not recoverable from the trace.
- Filesystem capture excludes `.env*`, `.ssh/`, `.aws/`, `.netrc`, `*.pem`, `*.key`, `id_rsa*` and
  `id_ed25519*`, along with `.git/`, `node_modules/` and `.orca/`. That is a fixed list, not a rule
  that generalises: `id_ecdsa` is not on it. A shape we miss is a bug worth filing — there is an
  issue template for exactly that.
- Trace files and blobs are written mode `0600`, run directories `0700`.
- The recorder opens no network connection of its own and sends no telemetry. It passes through
  only what your agent was already sending.
- The recording proxy binds `127.0.0.1`, and the local viewer binds loopback only — it refuses any
  other host outright rather than warning about it.
- Trace content is treated as untrusted input by the viewer and is escaped before rendering.

**What we do not promise:** redaction is best-effort mitigation, not a guarantee. Treat a trace as
sensitive material.

`orca scrub` is the second pass, for what the write path missed and for the internal hostname that
is only sensitive in your organisation. It rewrites `events.jsonl`, `manifest.json` and every text
blob in place, then refreshes the integrity digest. Two things it cannot do, and says out loud
rather than papering over:

- An event line whose scrubbed form would no longer parse or validate is **put back unchanged**.
  Scrub warns per event (`scrub_reverted`) that what it matched is still on disk, and does not
  count it as removed. A scrubber that under-reports is disappointing; one that hands you a false
  all-clear is worse than no scrubber.
- The shadow filesystem store (`<run>/fs`) **cannot be rewritten**. Its objects are addressed by the
  hash of their own contents, so editing one changes its id, every tree naming it, and every
  `fs.snapshot` event naming those trees. Scrub searches the store instead and reports how many
  objects still hold the material; `--drop-fs` deletes the store outright for anyone who would
  rather lose the snapshots than keep what is in them.

`orca export` prints what it is about to write before it writes it.

## TLS interception: not implemented

Capture is base-URL injection, and only base-URL injection. **There is no CA mode.** Nothing in the
tree generates a certificate, terminates TLS or touches a trust store, so there is no per-run CA to
find in a run directory and nothing to audit. If you came here after reading that one exists — in
an older copy of this file, an issue, or a doc that has since been corrected — it does not.

It is worth stating what would gate one, because the gap it would close is real: a harness that
ignores base-URL variables is not captured at all, and a Codex CLI signed in with a ChatGPT
subscription is the concrete example. Anything built here would have to generate its key per run,
keep it in the run directory at mode `0600`, never write to a system trust store, and be opt-in per
run rather than a global install. If such a mode ever ships and misses any of those, that is worth
reporting through the process above.

The general advice stands regardless of whether we ever build it: if a tool asks you to install its
CA system-wide, refusing is reasonable — including if some future version of this one asks.
