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

## TLS interception

Capture is normally base-URL injection: point an environment variable at a local origin server and
the agent's traffic arrives in plaintext. A harness that reads no such variable is invisible to
that mechanism — a Codex CLI signed in with a ChatGPT subscription is the concrete case, because it
talks to its own backend over TLS it established itself.

`orca record --tls-intercept` closes that gap. It is the most invasive thing this tool does, so
here is exactly what it does and does not do.

**Off by default, and per run.** There is no global switch and no persistent install. Off is the
absence of a `CONNECT` listener rather than a branch inside one, so a proxy that was not asked to
intercept cannot be talked into it. The run says out loud that interception is on, which hosts it
will decrypt, and where the CA lives, before the agent starts.

**The CA is ephemeral and local.** Generated per run into `<run>/tls/` — key `0600`, directory
`0700` — and deleted when the run ends, including when the run fails, is interrupted, or the agent
binary does not exist. It expires 24 hours after minting regardless. It is **never** installed into
a system or browser trust store, and orca will not offer to.

**The key never reaches a trace.** Not `events.jsonl`, not a blob, not the manifest. `RunCa` does
not expose it — it is a private field, and the file is the only place it exists. A test copies the
real key material out while a run is live and then greps the entire run directory for it.

**The child trusts it, and nothing else does.** `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
`REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `AWS_CA_BUNDLE` and `DENO_CERT` are set on that process
alone. Note that `SSL_CERT_FILE` *replaces* a trust store rather than adding to it, so the bundle
those variables point at is the run CA **plus** the public roots — otherwise every host orca
deliberately does not intercept would stop working.

**Only the allowlist is decrypted.** The default is model API hosts and nothing else.
`auth.openai.com` and other sign-in origins are deliberately excluded: that flow carries the
credential itself, and decrypting it would capture the thing we are trying not to record.
Everything else is tunnelled opaquely — orca records the host, port, byte counts and duration, and
nothing of the contents. `--tls-hosts` overrides the list. A bare `*` is refused, because it is a
request to decrypt everything.

**Origin verification is never disabled.** The re-encrypt leg to the real origin verifies its
certificate, and an origin that cannot be verified is refused rather than downgraded.
`ORCA_TLS_UPSTREAM_CA` *adds* roots, for a machine already behind a TLS-inspecting middlebox.
Nothing removes the check.

**Auth is handled exactly as on the base-URL path.** Headers are forwarded upstream so the agent
can authenticate, and dropped before the writer. `set-cookie` is dropped from recorded response
headers.

Two things it will not do, both failing loudly rather than silently: HTTP/2 (ALPN is pinned to
`http/1.1`, and a client offering only h2 fails the handshake with a named warning) and WebSocket
upgrades inside an intercepted session (refused with a 501 that names the reason — take the host
off the allowlist and the whole connection tunnels untouched).

The general advice stands regardless of whether we ever build it: if a tool asks you to install its
CA system-wide, refusing is reasonable — including if some future version of this one asks.
