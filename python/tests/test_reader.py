"""TraceReader: the tolerances spec §2 mandates, and the reporting that keeps them honest."""

from __future__ import annotations

import hashlib
import json
import tracemalloc
from pathlib import Path

import pytest
from conftest import blob_of, event, write_trace

from orca_trace import BlobRef, TraceEvent, TraceFormatError
from orca_trace.reader import BlobIntegrityError, BlobNotFoundError, NotATraceError, TraceReader


def files_in(directory: Path) -> dict[str, tuple[int, bytes]]:
    """Every file's mtime and content — the fixture for proving nothing was written."""
    out = {}
    for path in sorted(directory.rglob("*")):
        if path.is_file():
            out[str(path.relative_to(directory))] = (path.stat().st_mtime_ns, path.read_bytes())
    return out


class TestOpen:
    def test_opens_a_run_directory_and_parses_its_manifest(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0, "run.start")], manifest={"run_id": "run_9f2c14a03b71"})
        reader = TraceReader.open(tmp_path)
        assert reader.manifest.run_id == "run_9f2c14a03b71"
        assert reader.manifest.adapter_id == "test-adapter"
        assert reader.run_dir == tmp_path

    def test_accepts_a_string_path(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0, "run.start")])
        assert TraceReader.open(str(tmp_path)).manifest.schema_version == "0.1.0"

    def test_refuses_a_directory_with_no_manifest(self, tmp_path: Path) -> None:
        with pytest.raises(NotATraceError, match="manifest.json"):
            TraceReader.open(tmp_path)

    def test_refuses_a_manifest_that_is_not_json(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [])
        (tmp_path / "manifest.json").write_text("{not json", encoding="utf-8")
        with pytest.raises(NotATraceError, match="not JSON"):
            TraceReader.open(tmp_path)

    def test_refuses_a_manifest_that_violates_the_schema(self, tmp_path: Path) -> None:
        """A manifest is opened once and trusted afterwards, so it is validated, not tolerated."""
        write_trace(tmp_path, [], manifest={"run_id": "nope"})
        with pytest.raises(TraceFormatError, match="run_id"):
            TraceReader.open(tmp_path)


class TestEvents:
    def test_reads_every_event_in_order(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(i) for i in range(5)])
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0, 1, 2, 3, 4]
        assert all(isinstance(e, TraceEvent) for e in reader.events())
        assert reader.problems() == []

    def test_stream_yields_the_same_events_as_events(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(i) for i in range(5)])
        reader = TraceReader.open(tmp_path)
        assert list(reader.stream()) == reader.events()

    def test_stream_does_not_load_the_file_into_memory(self, tmp_path: Path) -> None:
        """A trace can be hundreds of MB; taking the first event must not cost the whole file."""
        write_trace(tmp_path, [event(i, attrs={"pad": "x" * 500}) for i in range(4000)])
        size = (tmp_path / "events.jsonl").stat().st_size
        assert size > 2_000_000, "fixture too small to prove anything"
        reader = TraceReader.open(tmp_path)

        tracemalloc.start()
        try:
            stream = reader.stream()
            first = next(stream)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        stream.close()

        assert first.seq == 0
        assert peak < size // 8, f"peak {peak} for a {size} byte trace — the file was buffered"

    def test_ignores_blank_lines(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0), event(1)])
        path = tmp_path / "events.jsonl"
        path.write_text(path.read_text(encoding="utf-8").replace("\n", "\n\n"), encoding="utf-8")
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0, 1]
        assert reader.problems() == []

    def test_tolerates_windows_line_endings(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0), event(1)])
        path = tmp_path / "events.jsonl"
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0, 1]

    def test_reports_a_missing_events_file_without_raising(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0)])
        (tmp_path / "events.jsonl").unlink()
        reader = TraceReader.open(tmp_path)
        assert reader.events() == []
        assert any("events.jsonl" in p and "missing" in p for p in reader.problems())


class TestTruncatedFinalLine:
    """Spec §2: readers MUST tolerate a truncated final line — a crash during write."""

    def test_skips_it_reports_it_and_does_not_raise(self, tmp_path: Path) -> None:
        write_trace(
            tmp_path,
            [event(0, "run.start"), event(1)],
            trailing='{"seq":2,"ts":"2026-08-29T10:00:00.000Z","mono_us":2000,"tur',
        )
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0, 1]
        problems = reader.problems()
        assert len(problems) == 1
        assert "truncated final line" in problems[0]
        assert "line 3" in problems[0]

    def test_a_run_that_crashed_before_run_end_is_still_readable(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0, "run.start")], trailing="{", seal=False)
        reader = TraceReader.open(tmp_path)
        assert [e.type for e in reader.events()] == ["run.start"]

    def test_a_complete_final_line_without_a_newline_is_not_a_casualty(self, tmp_path: Path) -> None:
        """Tolerating truncation must not mean distrusting the last line."""
        write_trace(tmp_path, [event(0), event(1)])
        path = tmp_path / "events.jsonl"
        path.write_text(path.read_text(encoding="utf-8").rstrip("\n"), encoding="utf-8")
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0, 1]
        assert reader.problems() == []

    def test_an_unknown_type_on_the_final_line_is_reported_as_unknown_not_truncated(
        self, tmp_path: Path
    ) -> None:
        write_trace(tmp_path, [event(0), event(1, "gpu.allocate")])
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0]
        assert any("gpu.allocate" in p for p in reader.problems())
        assert not any("truncated" in p for p in reader.problems())

    def test_a_malformed_line_that_is_not_last_is_reported_as_malformed(self, tmp_path: Path) -> None:
        """Only the final line gets the benefit of the doubt; an earlier one is corruption."""
        write_trace(tmp_path, [event(0), event(1), event(2)])
        path = tmp_path / "events.jsonl"
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
        lines[1] = "{oh no\n"
        path.write_text("".join(lines), encoding="utf-8")
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0, 2]
        problems = reader.problems()
        assert any("malformed JSON" in p and "line 2" in p for p in problems)
        assert not any("truncated" in p for p in problems)


class TestUnknownEventType:
    """Spec §2: readers MUST skip unknown `type` values rather than failing.

    This is the rule that lets the format add an event type in a MINOR release without
    invalidating every existing reader.
    """

    def test_is_skipped_and_reported_not_raised(self, tmp_path: Path) -> None:
        fabricated = event(1, "gpu.allocate")  # a type from some future Orca
        write_trace(tmp_path, [event(0, "run.start"), fabricated, event(2, "run.end")])
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0, 2]
        assert any("gpu.allocate" in p and "line 2" in p for p in reader.problems())

    def test_does_not_manufacture_a_seq_gap(self, tmp_path: Path) -> None:
        """The skipped event's own seq is still known, so density is intact."""
        write_trace(tmp_path, [event(0), event(1, "gpu.allocate"), event(2)])
        reader = TraceReader.open(tmp_path)
        reader.events()
        assert not any("seq" in p for p in reader.problems())

    def test_a_non_string_type_is_skipped_too(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0), {**event(1), "type": 7}])
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0]
        assert len(reader.problems()) == 1


class TestSeqDensity:
    """Spec §2.1: `seq` is a dense total order, strictly increasing, starting at 0."""

    def test_reports_a_gap(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0), event(1), event(5)])
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0, 1, 5]
        assert any("seq 5" in p and "2" in p for p in reader.problems())

    def test_reports_a_log_that_does_not_start_at_zero(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(3), event(4)])
        reader = TraceReader.open(tmp_path)
        reader.events()
        assert len(reader.problems()) == 1

    def test_reports_a_repeated_seq(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0), event(1), event(1)])
        reader = TraceReader.open(tmp_path)
        assert len(reader.events()) == 3, "the events are still returned; the reader only reports"
        assert any("seq 1" in p for p in reader.problems())

    def test_a_gap_does_not_stop_the_read(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0), event(7), event(8)])
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0, 7, 8]
        assert len(reader.problems()) == 1, "one gap, reported once, then resynchronised"


class TestInvalidEvents:
    def test_skips_an_event_that_violates_the_envelope(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0), {**event(1), "actor": "robot"}, event(2)])
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0, 2]
        assert any("actor" in p for p in reader.problems())

    def test_skips_an_event_whose_blob_reference_is_malformed(self, tmp_path: Path) -> None:
        """Spec §2.2: a corrupt digest must not be silently accepted as opaque inline data."""
        bad = {**event(1), "payload": {"$blob": "sha256:xyz", "bytes": 3}}
        write_trace(tmp_path, [event(0), bad, event(2)])
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0, 2]
        assert any("$blob" in p for p in reader.problems())

    def test_reports_a_forward_causal_edge_but_keeps_the_event(self, tmp_path: Path) -> None:
        """Spec §2.1 requires causes < seq, but the JSON Schema does not encode it.

        Dropping the event would make this reader disagree with the TypeScript one about the
        contents of a trace, so the violation is reported instead.
        """
        write_trace(tmp_path, [event(0), event(1, causes=[9])])
        reader = TraceReader.open(tmp_path)
        assert [e.seq for e in reader.events()] == [0, 1]
        assert any("causes" in p for p in reader.problems())


class TestBlobs:
    def build(self, tmp_path: Path) -> tuple[TraceReader, BlobRef]:
        body = b'{"messages": [{"role": "user", "content": "hi"}]}'
        hexdigest, ref = blob_of(body)
        payload = {"$blob": ref, "bytes": len(body), "media_type": "application/json"}
        write_trace(
            tmp_path,
            [event(0, "model.request", actor="agent", payload=payload)],
            blobs={hexdigest: body},
        )
        reader = TraceReader.open(tmp_path)
        return reader, BlobRef.from_json(payload)

    def test_reads_a_blob_by_reference(self, tmp_path: Path) -> None:
        reader, ref = self.build(tmp_path)
        assert reader.blob(ref).startswith(b'{"messages"')

    def test_reads_a_blob_by_prefixed_or_bare_digest(self, tmp_path: Path) -> None:
        reader, ref = self.build(tmp_path)
        assert reader.blob(ref.digest) == reader.blob(ref.hex) == reader.blob(ref)

    def test_reports_a_missing_blob_with_the_path_it_looked_in(self, tmp_path: Path) -> None:
        reader, ref = self.build(tmp_path)
        (tmp_path / "blobs" / ref.shard / ref.hex).unlink()
        with pytest.raises(BlobNotFoundError, match=ref.hex):
            reader.blob(ref)

    def test_refuses_a_digest_that_is_not_a_digest(self, tmp_path: Path) -> None:
        """Digests reach us from a file on disk, so this check is also the traversal guard."""
        reader, _ = self.build(tmp_path)
        for bad in ["../../etc/passwd", "sha256:zz", "", "sha256:" + "9f" * 31]:
            with pytest.raises(ValueError):
                reader.blob(bad)

    def test_verify_detects_a_blob_whose_content_no_longer_matches_its_name(
        self, tmp_path: Path
    ) -> None:
        reader, ref = self.build(tmp_path)
        (tmp_path / "blobs" / ref.shard / ref.hex).write_bytes(b"tampered")
        assert reader.blob(ref) == b"tampered", "unverified reads stay byte-for-byte like the TS reader"
        with pytest.raises(BlobIntegrityError, match="digest"):
            reader.blob(ref, verify=True)


class TestPayload:
    def test_returns_none_when_there_is_no_payload(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0)])
        reader = TraceReader.open(tmp_path)
        assert reader.payload(reader.events()[0]) is None

    def test_returns_an_inline_payload_unchanged(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0, payload={"kind": "inline", "n": 3})])
        reader = TraceReader.open(tmp_path)
        assert reader.payload(reader.events()[0]) == {"kind": "inline", "n": 3}

    def make(self, tmp_path: Path, body: bytes, media_type: str | None) -> TraceReader:
        hexdigest, ref = blob_of(body)
        payload: dict = {"$blob": ref, "bytes": len(body)}
        if media_type is not None:
            payload["media_type"] = media_type
        write_trace(tmp_path, [event(0, payload=payload)], blobs={hexdigest: body})
        return TraceReader.open(tmp_path)

    def test_decodes_a_json_blob(self, tmp_path: Path) -> None:
        reader = self.make(tmp_path, b'{"role": "user"}', "application/json")
        assert reader.payload(reader.events()[0]) == {"role": "user"}

    def test_decodes_a_blob_with_no_declared_media_type_as_json_when_it_parses(
        self, tmp_path: Path
    ) -> None:
        reader = self.make(tmp_path, b"[1, 2, 3]", None)
        assert reader.payload(reader.events()[0]) == [1, 2, 3]

    def test_returns_bytes_for_a_non_json_media_type(self, tmp_path: Path) -> None:
        """A dataset builder can branch on the type; a raise would abort the whole build."""
        reader = self.make(tmp_path, b"--- a/src/auth.ts\n+++ b/src/auth.ts\n", "text/x-diff")
        assert reader.payload(reader.events()[0]) == b"--- a/src/auth.ts\n+++ b/src/auth.ts\n"

    def test_returns_bytes_when_a_blob_claims_json_but_is_not(self, tmp_path: Path) -> None:
        reader = self.make(tmp_path, b"\x00\x01 not json", "application/json")
        assert reader.payload(reader.events()[0]) == b"\x00\x01 not json"

    def test_propagates_a_missing_blob(self, tmp_path: Path) -> None:
        reader = self.make(tmp_path, b"{}", "application/json")
        for path in (tmp_path / "blobs").rglob("*"):
            if path.is_file():
                path.unlink()
        with pytest.raises(BlobNotFoundError):
            reader.payload(reader.events()[0])


class TestVerifyIntegrity:
    """Spec §6: readers SHOULD verify the root and MUST report, not repair, a mismatch."""

    def test_verifies_a_sealed_run(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0), event(1)])
        ok, expected, actual = TraceReader.open(tmp_path).verify_integrity()
        assert ok is True
        assert expected == actual == hashlib.sha256((tmp_path / "events.jsonl").read_bytes()).hexdigest()

    def test_reports_a_mismatch_and_repairs_nothing(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0), event(1)])
        path = tmp_path / "events.jsonl"
        before = files_in(tmp_path)
        path.write_text(path.read_text(encoding="utf-8").replace('"turn":0', '"turn":9'), encoding="utf-8")
        tampered = path.read_bytes()

        ok, expected, actual = TraceReader.open(tmp_path).verify_integrity()
        assert ok is False
        assert expected != actual
        assert expected == hashlib.sha256(before["events.jsonl"][1]).hexdigest()
        assert actual == hashlib.sha256(tampered).hexdigest()
        assert path.read_bytes() == tampered, "the reader must not repair the file"

    def test_reports_an_unsealed_run_rather_than_claiming_success(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0)], seal=False)
        ok, expected, actual = TraceReader.open(tmp_path).verify_integrity()
        assert ok is False
        assert expected == ""
        assert len(actual) == 64

    def test_reports_a_missing_events_file(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0)])
        (tmp_path / "events.jsonl").unlink()
        ok, _expected, actual = TraceReader.open(tmp_path).verify_integrity()
        assert ok is False
        assert actual == ""


class TestProblems:
    def test_are_populated_without_an_explicit_read_pass(self, tmp_path: Path) -> None:
        """Returning [] for a trace nobody has read yet would hide exactly what this reports."""
        write_trace(tmp_path, [event(0), event(1, "gpu.allocate")])
        assert len(TraceReader.open(tmp_path).problems()) == 1

    def test_do_not_accumulate_across_reads(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0, "gpu.allocate")])
        reader = TraceReader.open(tmp_path)
        reader.events()
        reader.events()
        assert len(reader.problems()) == 1

    def test_are_returned_as_a_copy(self, tmp_path: Path) -> None:
        write_trace(tmp_path, [event(0, "gpu.allocate")])
        reader = TraceReader.open(tmp_path)
        reader.problems().clear()
        assert len(reader.problems()) == 1


class TestReadOnly:
    def test_reading_a_trace_never_writes_to_it(self, tmp_path: Path) -> None:
        """The read-only boundary is the reason this SDK exists in a second language at all."""
        body = b'{"a": 1}'
        hexdigest, ref = blob_of(body)
        write_trace(
            tmp_path,
            [
                event(0, "run.start"),
                event(1, "fs.snapshot", attrs={"tree": "t0"}),
                event(2, payload={"$blob": ref, "bytes": len(body), "media_type": "application/json"}),
            ],
            blobs={hexdigest: body},
        )
        before = files_in(tmp_path)

        reader = TraceReader.open(tmp_path)
        events = reader.events()
        list(reader.stream())
        reader.payload(events[2])
        reader.blob(ref)
        reader.verify_integrity()
        reader.problems()

        assert files_in(tmp_path) == before

    def test_exposes_no_write_api(self) -> None:
        forbidden = {"write", "append", "put", "record", "redact", "fork", "delete"}
        assert forbidden.isdisjoint(dir(TraceReader))
