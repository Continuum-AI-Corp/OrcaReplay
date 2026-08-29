# orca-trace

Read-only Python reader for the [Orca trace format v0](../spec/orca-trace-v0.md).

OrcaReplay's core is TypeScript, but the people who turn traces into evaluation datasets work in
Python. This package makes a recorded run readable from pandas, PyTorch, or a notebook without
shelling out to `orca` and parsing its output — and it is the evidence that v0 is a format rather
than a TypeScript library with a document next to it.

- **No third-party dependencies.** Python 3.10+ standard library only, so it can be dropped into
  an environment with an already-pinned scientific stack.
- **Read-only, deliberately.** There is no writer here and there will not be one. The TypeScript
  implementation owns the write path, and a second writer means a second redaction
  implementation — which is how a secret leaks.
- **Fully typed**, ships `py.typed`.

## Install

```bash
pip install -e python/            # from an OrcaReplay checkout
# or, since there is nothing to build:
export PYTHONPATH="$PWD/python:$PYTHONPATH"
```

## Worked example

```python
from orca_trace import TraceReader, derive_checkpoints, snap_to_checkpoint

reader = TraceReader.open("examples/traces/run_9f2c14a03b71")

reader.manifest.run_id          # 'run_9f2c14a03b71'
reader.manifest.adapter_id      # 'claude-code'
reader.verify_integrity()       # (True, '1a4bf78f…', '1a4bf78f…')   spec §6

events = reader.events()        # list[TraceEvent], or reader.stream() for a 500 MB trace
len(events)                     # 27
reader.problems()               # []  — everything skipped, and why. Empty means nothing was.

# Large payloads are spilled to content-addressed blobs (spec §2.2); .payload() reads them back.
request = next(e for e in events if e.type == "model.request" and e.blob)
reader.payload(request)         # {'messages': [...]}  — decoded JSON
diff = next(e for e in events if e.type == "fs.change")
reader.payload(diff)            # b'--- a/src/auth.ts\n…'  — bytes for non-JSON media types

# Checkpoints are derived from the log, never recorded (spec §3).
checkpoints = derive_checkpoints(events)
[c.seq for c in checkpoints]    # [1, 13, 14, 15, 16, 17, 18, 21, 24, 25, 26]

# A fork target that is not a checkpoint moves — and the reader tells you it moved.
snap_to_checkpoint(checkpoints, 20)
# (Checkpoint(seq=18, turn=3, fs_tree='9c1e4bd7…'), True)
```

Run the full example, which answers real questions from a trace:

```console
$ python3 python/examples/analyze.py
run_9f2c14a03b71  adapter=claude-code  exit=1
integrity: OK
27 events, 6 turns, 11 checkpoints, 0 problems

tokens by model
  claude-opus-5      in   40350  out    934  calls   5

filesystem churn by turn
  turn 3   +18/-4  1 file(s)  src/auth.ts

fork targets
  seq 17  -> checkpoint 17 (exact), tree 9c1e4bd7f0a3821e5c94b6d2087fa31c4e5b9d63
  seq 20  -> checkpoint 18 (snapped back from 20), tree 9c1e4bd7f0a3821e5c94b6d2087fa31c4e5b9d63
```

## API

| | |
|---|---|
| `TraceReader.open(run_dir)` | Open a run directory; validates `manifest.json` up front. |
| `.manifest` | `Manifest` — run metadata and the integrity root. |
| `.events()` / `.stream()` | All events, or an iterator that never holds the file in memory. |
| `.blob(ref, *, verify=False)` | Bytes of a content-addressed payload. |
| `.payload(event)` | Inline value, decoded JSON blob, or `bytes` for anything else. |
| `.verify_integrity()` | `(ok, expected, actual)` over `events.jsonl` (spec §6). |
| `.problems()` | Lines skipped and rules broken, as strings. Never silent. |
| `derive_checkpoints(events)` | Forkable points, per spec §3. |
| `snap_to_checkpoint(cps, target)` | `(checkpoint, snapped)` — never rounds forward. |
| `turns_of(events)` / `causal_chain(events, seq)` | Turn grouping; transitive `causes` walk. |

Models: `TraceEvent`, `Manifest`, `BlobRef`, `Checkpoint`, `Turn` — all frozen dataclasses.
Constants: `EVENT_TYPES`, `ACTORS`, `SCHEMA_VERSION`, `RUN_ID_PATTERN`, `INLINE_PAYLOAD_LIMIT`.

## What the reader tolerates, and what it tells you

Spec §2 makes two tolerances mandatory, and this reader treats both as *reportable*, not silent:

| Situation | Result |
|---|---|
| Truncated final line (the writer crashed) | skipped, reported in `problems()`, no exception |
| Unknown `type` from a newer Orca | skipped, reported — this is what lets the format grow |
| `seq` gap, repeat, or a log not starting at 0 | event still returned, gap reported |
| Malformed `$blob` payload | event skipped — spec §2.2 makes it an invalid event, not opaque data |
| `causes` entry ≥ `seq` | event still returned, violation reported |
| Integrity mismatch | reported by `verify_integrity()`; nothing is ever repaired |

## Conformance

`tests/test_conformance.py` reads `examples/traces/run_9f2c14a03b71/` — written by the TypeScript
implementation — and asserts this reader derives the same checkpoints, turns, and causal chains as
`packages/core/src/graph.ts`. If that test ever fails, the disagreement is the bug: fix the spec
first, then whichever implementation it says is wrong.

```bash
python3 -m pytest python/ -q
```

## Notes for anyone writing a third implementation

Places where v0 left real room, and what this reader chose (see the tests for each):

- `format: date-time` is an annotation in JSON Schema by default; the reference implementation
  asserts it via `ajv-formats`, so this reader asserts it too and rejects `ts` without an offset.
- `causes[i] < seq` is prose in §2.1 but is not encoded in the schema, so it is reported rather
  than enforced — dropping the event would make the two readers disagree about a trace's contents.
- §2.1 calls `seq` dense but no artifact checks it; this reader reports gaps and resynchronises.
- §3's "conversation prefix up to *n*" is inclusive: an unanswered `model.request` is itself a
  checkpoint, matching the TypeScript implementation — it is the point you want to retry.
- §6 defines integrity for `events.jsonl` only, so blob digests are checked on request
  (`verify=True`), not by default.

## Licence

Apache-2.0.
