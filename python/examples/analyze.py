#!/usr/bin/env python3
"""Answer three questions about a recorded run, using nothing but the SDK and the standard library.

    python3 python/examples/analyze.py [run_dir]

1. What did the tokens go on? (per model, paired back to the request that named it)
2. Which turn churned the filesystem most?
3. If I want to retry from the failure, where does a fork actually land?

Question 3 is the one that needs the SDK rather than `jq`: checkpoints are derived from the log
(spec §3), not recorded in it, and a fork target that is not a checkpoint silently moves.
"""

from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from orca_trace import TraceReader, derive_checkpoints, snap_to_checkpoint, turns_of  # noqa: E402

DEFAULT_RUN = Path(__file__).resolve().parents[2] / "examples" / "traces" / "run_9f2c14a03b71"


def main(run_dir: Path) -> int:
    reader = TraceReader.open(run_dir)
    manifest = reader.manifest
    events = reader.events()
    by_seq = {e.seq: e for e in events}

    ok, expected, actual = reader.verify_integrity()
    checkpoints = derive_checkpoints(events)

    print(f"{manifest.run_id}  adapter={manifest.adapter_id}  exit={manifest.exit_code}")
    # Unsealed is not mismatched. A run whose recorder was killed has no digest at all, and
    # printing "MISMATCH expected  got <hash>" accuses a file that nothing touched.
    if ok:
        integrity = "OK"
    elif not expected:
        integrity = f"UNSEALED (never finished; events.jsonl is {actual})"
    else:
        integrity = f"MISMATCH expected {expected} got {actual}"
    print(f"integrity: {integrity}")
    print(
        f"{len(events)} events, {len(turns_of(events))} turns, "
        f"{len(checkpoints)} checkpoints, {len(reader.problems())} problems"
    )

    # 1. Tokens per model. A model.response carries the token counts but not the model name, so
    # follow `causes` back to the request that chose it — that edge is why the DAG is recorded.
    tokens: dict[str, dict[str, int]] = defaultdict(lambda: {"in": 0, "out": 0, "calls": 0})
    for event in events:
        if event.type != "model.response":
            continue
        request = next((by_seq[c] for c in event.causes if c in by_seq), None)
        model = str((request.attrs if request else event.attrs).get("model", "unknown"))
        row = tokens[model]
        row["in"] += int(event.attrs.get("input_tokens", 0))
        row["out"] += int(event.attrs.get("output_tokens", 0))
        row["calls"] += 1

    print("\ntokens by model")
    for model, row in sorted(tokens.items(), key=lambda kv: -kv[1]["in"] - kv[1]["out"]):
        print(f"  {model:<18} in {row['in']:>7}  out {row['out']:>6}  calls {row['calls']:>3}")

    # 2. Filesystem churn per turn, from fs.change attrs.
    churn: dict[int, dict[str, int]] = defaultdict(lambda: {"+": 0, "-": 0, "files": 0})
    paths: dict[int, set[str]] = defaultdict(set)
    for event in events:
        if event.type != "fs.change":
            continue
        row = churn[event.turn]
        row["+"] += int(event.attrs.get("insertions", 0))
        row["-"] += int(event.attrs.get("deletions", 0))
        paths[event.turn].add(str(event.attrs.get("path", "?")))
        row["files"] = len(paths[event.turn])

    print("\nfilesystem churn by turn")
    if not churn:
        print("  (no fs.change events — the run recorded no diffs)")
    for turn, row in sorted(churn.items(), key=lambda kv: -(kv[1]["+"] + kv[1]["-"])):
        touched = ", ".join(sorted(paths[turn]))
        print(f"  turn {turn:<3} +{row['+']}/-{row['-']}  {row['files']} file(s)  {touched}")

    # 3. Where a fork of the first failure would actually resume.
    failure = next((e for e in events if e.type == "error"), None)
    print("\nfork targets")
    if failure is None:
        print("  (this run recorded no error to retry)")
    elif not checkpoints:
        print("  (no checkpoints: the run recorded no fs.snapshot, so nothing is forkable)")
    else:
        # One target that is a checkpoint and one that is not, so both behaviours show. The second
        # is *found* rather than guessed at with an offset: which seqs are checkpoints depends on
        # the trace, and an arithmetic guess quietly stops demonstrating anything the day it lands
        # on one.
        exact = {c.seq for c in checkpoints}
        between = next((e.seq for e in events if e.seq > failure.seq and e.seq not in exact), None)
        for target in (failure.seq, between):
            if target is None:
                continue
            checkpoint, snapped = snap_to_checkpoint(checkpoints, target)
            moved = f"snapped back from {target}" if snapped else "exact"
            print(f"  seq {target:<3} -> checkpoint {checkpoint.seq} ({moved}), tree {checkpoint.fs_tree}")

    for problem in reader.problems():
        print(f"\nproblem: {problem}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_RUN))
