"""Cross-implementation conformance against the checked-in trace.

THIS IS THE MOST IMPORTANT TEST IN THE PACKAGE. It reads
`examples/traces/run_9f2c14a03b71/` — a trace produced by the TypeScript writer — and asserts
that this reader agrees with the TypeScript reader and graph about what that trace *means*.

If it fails, do not adjust the expectations. A failure means Python and TypeScript disagree about
a trace neither of them wrote today, and at that moment the "format" is not a format: it is a
TypeScript library with a document next to it. The right response is to fix the spec, then fix
whichever implementation the spec says is wrong.

The golden values below were produced by `packages/core/src/graph.ts` (via its compiled
`dist/graph.js`) over this same file, not by this package.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from orca_trace import (
    ACTORS,
    EVENT_TYPES,
    INLINE_PAYLOAD_LIMIT,
    RUN_ID_PATTERN,
    SCHEMA_VERSION,
    BlobRef,
    TraceReader,
    causal_chain,
    derive_checkpoints,
    snap_to_checkpoint,
    turns_of,
)

#: Every seq that satisfies spec §3 for this trace, per deriveCheckpoints() in TypeScript.
GOLDEN_CHECKPOINT_SEQS = [1, 13, 14, 15, 16, 17, 18, 21, 24, 25, 26]

#: (turn, startSeq, endSeq) per turnsOf() in TypeScript.
GOLDEN_TURN_SPANS = [(0, 0, 1), (1, 2, 4), (2, 5, 8), (3, 9, 18), (4, 19, 21), (5, 22, 26)]

#: causalChain(events, 17) in TypeScript — the failing test, traced back to its first request.
GOLDEN_CHAIN_TO_17 = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 17]

GOLDEN_EVENT_COUNT = 27


@pytest.fixture
def reader(example_run: Path) -> TraceReader:
    return TraceReader.open(example_run)


class TestTheTraceItself:
    def test_run_id_matches_the_directory_and_the_pattern(
        self, reader: TraceReader, example_run: Path
    ) -> None:
        assert reader.manifest.run_id == example_run.name
        assert RUN_ID_PATTERN.match(reader.manifest.run_id)

    def test_schema_version_is_the_one_this_sdk_implements(self, reader: TraceReader) -> None:
        assert reader.manifest.schema_version == SCHEMA_VERSION

    def test_integrity_verifies(self, reader: TraceReader) -> None:
        """Spec §6. A mismatch here means the checked-in example was edited by hand."""
        ok, expected, actual = reader.verify_integrity()
        assert ok, f"events.jsonl hashes to {actual}, manifest claims {expected}"

    def test_reads_every_event_with_nothing_skipped(self, reader: TraceReader) -> None:
        events = reader.events()
        assert len(events) == GOLDEN_EVENT_COUNT
        assert reader.problems() == [], "a valid trace must produce no problems"

    def test_event_count_matches_the_manifest(self, reader: TraceReader) -> None:
        assert reader.manifest.counts is not None
        assert reader.manifest.counts["events"] == GOLDEN_EVENT_COUNT == len(reader.events())

    def test_every_event_type_and_actor_is_known(self, reader: TraceReader) -> None:
        """An unknown value here is either a spec change nobody told Python about, or drift."""
        for event in reader.events():
            assert event.type in EVENT_TYPES, f"seq {event.seq}: unknown type {event.type}"
            assert event.actor in ACTORS, f"seq {event.seq}: unknown actor {event.actor}"

    def test_seq_is_dense_and_starts_at_zero(self, reader: TraceReader) -> None:
        assert [e.seq for e in reader.events()] == list(range(GOLDEN_EVENT_COUNT))

    def test_the_run_is_bracketed_by_start_and_end(self, reader: TraceReader) -> None:
        events = reader.events()
        assert events[0].type == "run.start"
        assert events[-1].type == "run.end"
        assert [e.type for e in events].count("run.start") == 1
        assert [e.type for e in events].count("run.end") == 1

    def test_every_cause_precedes_its_event(self, reader: TraceReader) -> None:
        for event in reader.events():
            assert all(c < event.seq for c in event.causes), f"seq {event.seq}"

    def test_mono_us_never_goes_backwards(self, reader: TraceReader) -> None:
        """Spec §2.1: mono_us is authoritative for duration, so it must be monotonic."""
        values = [e.mono_us for e in reader.events()]
        assert values == sorted(values)


class TestBlobs:
    def test_every_referenced_blob_resolves_and_matches_its_digest(
        self, reader: TraceReader
    ) -> None:
        refs = [e.blob for e in reader.events() if e.blob is not None]
        assert refs, "the example trace is supposed to exercise the blob store"
        for ref in refs:
            data = reader.blob(ref, verify=True)
            assert len(data) == ref.bytes, f"{ref.digest} declares {ref.bytes} bytes"

    def test_blob_count_matches_the_manifest(self, reader: TraceReader, example_run: Path) -> None:
        stored = [p for p in (example_run / "blobs").rglob("*") if p.is_file()]
        assert reader.manifest.integrity is not None
        assert len(stored) == reader.manifest.integrity["blob_count"]

    def test_blobs_are_sharded_by_their_first_two_hex_characters(self, example_run: Path) -> None:
        """Spec §2.2 fixes the layout, so a reader in any language can find a blob by digest."""
        for path in (example_run / "blobs").rglob("*"):
            if path.is_file():
                assert path.parent.name == path.name[:2]

    def test_no_payload_over_the_inline_limit_was_left_inline(self, reader: TraceReader) -> None:
        """Spec §2.2: writers MUST spill anything over 4096 bytes so jq and rg still work."""
        for event in reader.events():
            if isinstance(event.payload, BlobRef) or event.payload is None:
                continue
            serialized = json.dumps(event.payload, separators=(",", ":"))
            assert len(serialized.encode("utf-8")) <= INLINE_PAYLOAD_LIMIT, f"seq {event.seq}"

    def test_a_json_payload_round_trips_to_a_python_value(self, reader: TraceReader) -> None:
        request = next(e for e in reader.events() if e.type == "model.request" and e.blob)
        assert isinstance(reader.payload(request), (dict, list))

    def test_a_non_json_payload_comes_back_as_bytes(self, reader: TraceReader) -> None:
        diff = next(
            e
            for e in reader.events()
            if e.blob is not None and e.blob.media_type == "text/x-diff"
        )
        assert isinstance(reader.payload(diff), bytes)


class TestCheckpointsAgreeWithTypeScript:
    def test_checkpoint_sequence_numbers_match_exactly(self, reader: TraceReader) -> None:
        """The one that matters: a fork of this run must land on the same seq in both languages."""
        assert [c.seq for c in derive_checkpoints(reader.events())] == GOLDEN_CHECKPOINT_SEQS

    def test_checkpoints_carry_the_governing_tree(self, reader: TraceReader) -> None:
        checkpoints = derive_checkpoints(reader.events())
        assert checkpoints[0].fs_tree == "3ab77f19c4e2a58d0b6f1e93c72d4a80b5e6f712"
        assert {c.fs_tree for c in checkpoints[1:]} == {"9c1e4bd7f0a3821e5c94b6d2087fa31c4e5b9d63"}

    def test_every_checkpoint_has_a_snapshot_at_or_before_it_in_its_turn(
        self, reader: TraceReader
    ) -> None:
        """Re-derives condition 1 of spec §3 independently of derive_checkpoints itself."""
        events = reader.events()
        snapshots = [(e.seq, e.turn) for e in events if e.type == "fs.snapshot"]
        for checkpoint in derive_checkpoints(events):
            assert any(
                seq <= checkpoint.seq and turn == checkpoint.turn for seq, turn in snapshots
            ), f"checkpoint {checkpoint.seq} has no governing snapshot"

    def test_the_derived_checkpoints_include_the_recorded_checkpoint_event(
        self, reader: TraceReader
    ) -> None:
        """This trace also carries a live `checkpoint` event; derivation must agree with it."""
        recorded = [e.seq for e in reader.events() if e.type == "checkpoint"]
        derived = {c.seq for c in derive_checkpoints(reader.events())}
        assert recorded and set(recorded) <= derived

    def test_snapping_a_non_checkpoint_target_moves_back_and_says_so(
        self, reader: TraceReader
    ) -> None:
        checkpoints = derive_checkpoints(reader.events())
        checkpoint, snapped = snap_to_checkpoint(checkpoints, 20)
        assert (checkpoint.seq, snapped) == (18, True)
        assert snap_to_checkpoint(checkpoints, 13) == (checkpoints[1], False)

    def test_turn_spans_match(self, reader: TraceReader) -> None:
        spans = [(t.turn, t.start_seq, t.end_seq) for t in turns_of(reader.events())]
        assert spans == GOLDEN_TURN_SPANS

    def test_causal_chain_matches(self, reader: TraceReader) -> None:
        events = reader.events()
        assert [e.seq for e in causal_chain(events, 17)] == GOLDEN_CHAIN_TO_17


class TestReadingIsRepeatableAndReadOnly:
    def test_streaming_and_bulk_reads_agree(self, reader: TraceReader) -> None:
        assert list(reader.stream()) == reader.events()

    def test_reading_the_example_trace_does_not_touch_it(self, example_run: Path) -> None:
        before = {
            str(p): (p.stat().st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest())
            for p in sorted(example_run.rglob("*"))
            if p.is_file()
        }
        reader = TraceReader.open(example_run)
        events = reader.events()
        for event in events:
            reader.payload(event)
        derive_checkpoints(events)
        reader.verify_integrity()
        after = {
            str(p): (p.stat().st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest())
            for p in sorted(example_run.rglob("*"))
            if p.is_file()
        }
        assert after == before
