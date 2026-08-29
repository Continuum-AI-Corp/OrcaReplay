# Orca Trace Format — v0

Status: **Draft**. Schema version `0.1.0`.

This document is normative. The JSON Schema files in `packages/schema/schema/` are the
machine-readable form of this document and take precedence where they disagree with the prose.
TypeScript and Python types are *generated from or verified against* the schema, never the reverse.

Licensed CC BY 4.0 so that other implementations may quote it freely.

## 1. Layout

```
.orca/runs/<run_id>/
├── manifest.json      # run metadata, integrity root, schema version
├── events.jsonl       # append-only, totally ordered event log
├── blobs/<ab>/<sha256>  # content-addressed payloads
├── fs/                # shadow git object store (optional)
└── redactions.json    # what was removed, by rule, with stable placeholders
```

`run_id` MUST match `^run_[0-9a-f]{6,32}$`.

## 2. events.jsonl

One JSON object per line, UTF-8, `\n`-terminated. Readers MUST tolerate a truncated final line
(a crash during write) and MUST skip unknown `type` values rather than failing. Writers MUST NOT
rewrite or reorder previously written lines.

### 2.1 Envelope

| Field      | Type              | Required | Meaning |
|------------|-------------------|----------|---------|
| `seq`      | integer ≥ 0       | yes      | Dense total order. Strictly increasing, starts at 0. |
| `ts`       | RFC3339 string    | yes      | Wall clock. Informational only — wall clocks lie. |
| `mono_us`  | integer ≥ 0       | yes      | Microseconds since run start. Authoritative for duration. |
| `turn`     | integer ≥ 0       | yes      | Groups events into model turns. |
| `type`     | string            | yes      | See §2.3. |
| `actor`    | string            | yes      | `agent`, `harness`, `model`, `orca`, `gateway`, `tool`, `user`. |
| `causes`   | integer[]         | no       | Causal DAG over the total order. Each entry MUST be < `seq`. |
| `attrs`    | object            | no       | Type-specific scalar data. Kept small and greppable. |
| `payload`  | value \| BlobRef  | no       | Large or opaque data. See §2.2. |
| `redacted` | string[]          | no       | Identifiers of removed material. Never the material itself. |

### 2.2 Payloads and blobs

A payload is either an inline JSON value or a blob reference:

```json
{ "$blob": "sha256:9f2c14…", "bytes": 20481, "media_type": "text/plain" }
```

Any object carrying a `$blob` key MUST be a well-formed blob reference; a malformed one is not
merely an unrecognised payload, it is an invalid event. This keeps a corrupt digest from being
silently accepted as opaque inline data.

Writers MUST spill any payload whose serialized form exceeds **4096 bytes** to a blob, so that
`events.jsonl` stays readable with `jq` and `rg`. Blobs are stored at
`blobs/<first two hex chars>/<full hex digest>` and are immutable.

Because every model turn resends the whole conversation, content addressing is what keeps a trace
`O(n)` in new content rather than `O(n²)` in turns. Implementations MUST NOT store duplicate blobs.

### 2.3 Event types

| Type | Emitted when |
|------|--------------|
| `run.start` / `run.end` | Bracket the run. Exactly one of each. |
| `model.request` / `model.response` | A model API exchange, captured at the proxy. |
| `tool.call` / `tool.result` | A tool invocation, usually reconstructed from the protocol. |
| `mcp.request` / `mcp.response` | An MCP JSON-RPC exchange seen by the shim. |
| `shell.exec` / `shell.result` | A shell command, from the PATH shim. |
| `fs.snapshot` / `fs.change` | A workspace tree id, and a diff against the previous tree. |
| `net.request` / `net.response` | Non-model HTTP seen by the proxy. |
| `error` | A failure derived from another event or reported by the harness. |
| `divergence` | Replay matched inexactly. See §4. |
| `checkpoint` | A forkable point. Derived, not recorded live. See §3. |
| `fork` | A run forked from this point into a child run. |
| `route.decision` | A gateway chose a model. **Generic** — any gateway may emit it. |
| `note` | Derived annotation from an analyzer (e.g. loop detection). |

Adding a type is a MINOR version bump. Removing or changing the meaning of one is MAJOR.

## 3. Checkpoints

A checkpoint is **derived**, not recorded. `seq` *n* is a checkpoint when both hold:

1. a `fs.snapshot` exists at or before *n* within the same `turn`; and
2. the conversation prefix up to *n* is complete — every `model.request` before *n* has a
   matching `model.response`.

A fork target that is not a checkpoint MUST snap to the nearest preceding checkpoint, and the
implementation MUST report that it did so rather than silently forking from different state.

## 4. Divergence

Replay of a nondeterministic client will not always see byte-identical requests. Implementations
MUST match using this ladder and MUST record which rung matched:

| Rung | Strategy | Result |
|------|----------|--------|
| 1 | Canonical hash of the normalized request | exact — no event |
| 2 | Same turn index and message count, structural distance under threshold | `divergence` level `minor` |
| 3 | Identical trailing message, different prefix (typical after compaction) | `divergence` level `major` |
| 4 | No match | halt and report; `--loose` continues live instead |

Redaction (§5) makes rung 1 unreachable for any request that contained a secret: the placeholder's
digest is salted per run, so the same value becomes a different placeholder on replay. Implementations
MUST therefore put both sides in the same representation before comparing — redacting the incoming
request with the same policy — and MUST compare the *kind* of secret rather than its digest, which
is the most a trace can know about a value it deliberately destroyed. A request that is equal only
after that fold is a rung 2 `minor` divergence, never rung 1.

Distance MUST be measured per field rather than over the serialized body as a whole. A whole-body
longest-common-prefix-and-suffix measure counts everything between two distant edits as changed, so
two drifting identifiers in a large prompt score as a total rewrite and no request can reach rung 2.

**Replay MUST NOT silently approximate.** Every inexact match is an event in the trace.

## 5. Redaction

Redaction happens in the write path, before bytes reach disk. Implementations MUST:

- capture environment variables by **allowlist only**;
- never write auth material (`authorization`, `x-api-key`, `cookie`, `proxy-authorization`),
  substituting a stable placeholder `<secret:kind:hash8>` derived from a per-run salt, so that
  replay still matches structurally and repeat occurrences remain equal;
- record removals in `redactions.json` by rule and identifier, never by value.

High-entropy detection MUST additionally require a **mixed alphabet** — the token must contain
both a digit and a letter. Shannon entropy alone has false positives on ordinary source code
(`getUserAuthenticationTokenFromRequestHeaders` scores 4.08 bits/char), and since agent traces are
mostly source code, an unguarded rule corrupts exactly the payloads the trace exists to preserve.
Recall is essentially unaffected: random base64url of 20+ characters contains a digit with
probability ≈0.98.

Redaction is best-effort mitigation, not a guarantee. A trace is sensitive material.

## 6. Integrity

`manifest.json.integrity.events_sha256` is the SHA-256 of `events.jsonl` at the moment the run
ended. Readers SHOULD verify it and MUST report, not repair, a mismatch.
