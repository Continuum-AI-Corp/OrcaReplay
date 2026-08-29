"""The Python types must say exactly what the JSON Schema says, or the SDK is guessing."""

from __future__ import annotations

import json

import pytest
from conftest import repo_root

from orca_trace.models import (
    ACTORS,
    EVENT_TYPES,
    SCHEMA_VERSION,
    BlobRef,
    Checkpoint,
    Manifest,
    TraceEvent,
    TraceFormatError,
)


TS = "2026-08-29T10:00:00.000Z"


def schema(name: str) -> dict:
    root = repo_root()
    if root is None:
        pytest.skip("not running inside an OrcaReplay checkout")
    path = root / "packages" / "schema" / "schema" / name
    if not path.is_file():
        pytest.skip(f"missing {path}")
    return json.loads(path.read_text(encoding="utf-8"))


class TestSchemaParity:
    """Drift between these constants and the schema is drift between implementations."""

    def test_event_types_match_the_schema_enum(self) -> None:
        assert EVENT_TYPES == frozenset(schema("event.schema.json")["properties"]["type"]["enum"])

    def test_actors_match_the_schema_enum(self) -> None:
        assert ACTORS == frozenset(schema("event.schema.json")["properties"]["actor"]["enum"])

    def test_constants_are_frozensets_so_a_caller_cannot_edit_them(self) -> None:
        assert isinstance(EVENT_TYPES, frozenset)
        assert isinstance(ACTORS, frozenset)

    def test_required_event_fields_match_the_schema(self) -> None:
        required = set(schema("event.schema.json")["required"])
        assert required == {"seq", "ts", "mono_us", "turn", "type", "actor"}

    def test_schema_version_matches_the_example_manifest(self) -> None:
        assert SCHEMA_VERSION == "0.1.0"


class TestBlobRef:
    def test_parses_a_well_formed_reference(self) -> None:
        digest = "sha256:" + "9f" * 32
        ref = BlobRef.from_json({"$blob": digest, "bytes": 20481, "media_type": "text/plain"})
        assert ref.digest == digest
        assert ref.bytes == 20481
        assert ref.media_type == "text/plain"
        assert ref.hex == "9f" * 32

    def test_media_type_is_optional(self) -> None:
        ref = BlobRef.from_json({"$blob": "sha256:" + "ab" * 32, "bytes": 0})
        assert ref.media_type is None

    def test_is_frozen(self) -> None:
        ref = BlobRef.from_json({"$blob": "sha256:" + "ab" * 32, "bytes": 1})
        with pytest.raises(Exception):
            ref.bytes = 2  # type: ignore[misc]

    @pytest.mark.parametrize(
        "bad",
        [
            {"$blob": "sha256:nothex", "bytes": 1},
            {"$blob": "9f" * 32, "bytes": 1},  # missing the algorithm prefix
            {"$blob": "sha256:" + "9F" * 32, "bytes": 1},  # uppercase is out of pattern
            {"$blob": "sha256:" + "9f" * 32},  # bytes is required
            {"$blob": "sha256:" + "9f" * 32, "bytes": -1},
            {"$blob": "sha256:" + "9f" * 32, "bytes": True},  # bool is not an integer here
            {"$blob": "sha256:" + "9f" * 32, "bytes": 1, "extra": 1},  # additionalProperties false
        ],
    )
    def test_rejects_a_malformed_reference(self, bad: dict) -> None:
        """Spec §2.2: a malformed $blob is an invalid event, not opaque inline data."""
        with pytest.raises(TraceFormatError):
            BlobRef.from_json(bad)

    def test_hex_tolerates_a_hand_built_reference_without_the_prefix(self) -> None:
        assert BlobRef(digest="ab" * 32, bytes=1).hex == "ab" * 32
        assert BlobRef(digest="ab" * 32, bytes=1).shard == "ab"

    def test_recognises_a_reference_by_its_blob_key(self) -> None:
        assert BlobRef.looks_like({"$blob": "anything"})
        assert not BlobRef.looks_like({"text": "hello"})
        assert not BlobRef.looks_like("a string payload")
        assert not BlobRef.looks_like(None)


class TestTraceEvent:
    def test_parses_the_envelope(self) -> None:
        e = TraceEvent.from_json(
            {
                "seq": 3,
                "ts": "2026-08-29T10:13:43.600Z",
                "mono_us": 5600000,
                "turn": 1,
                "type": "model.response",
                "actor": "model",
                "causes": [2],
                "attrs": {"stop_reason": "tool_use"},
                "redacted": ["header.x-api-key"],
            }
        )
        assert (e.seq, e.turn, e.type, e.actor) == (3, 1, "model.response", "model")
        assert e.causes == (2,)
        assert e.attrs["stop_reason"] == "tool_use"
        assert e.redacted == ("header.x-api-key",)
        assert e.payload is None

    def test_optional_fields_default_to_empty(self) -> None:
        e = TraceEvent.from_json({"seq": 0, "ts": TS, "mono_us": 0, "turn": 0, "type": "note", "actor": "orca"})
        assert e.causes == ()
        assert e.attrs == {}
        assert e.redacted == ()

    def test_keeps_an_inline_payload_as_is(self) -> None:
        e = TraceEvent.from_json(
            {"seq": 0, "ts": TS, "mono_us": 0, "turn": 0, "type": "note", "actor": "orca", "payload": [1, "two"]}
        )
        assert e.payload == [1, "two"]

    def test_parses_a_blob_payload_into_a_ref(self) -> None:
        digest = "sha256:" + "1b" * 32
        e = TraceEvent.from_json(
            {
                "seq": 0,
                "ts": TS,
                "mono_us": 0,
                "turn": 0,
                "type": "note",
                "actor": "orca",
                "payload": {"$blob": digest, "bytes": 167},
            }
        )
        assert isinstance(e.payload, BlobRef)
        assert e.payload.digest == digest

    def test_rejects_a_malformed_blob_payload(self) -> None:
        with pytest.raises(TraceFormatError):
            TraceEvent.from_json(
                {
                    "seq": 0,
                    "ts": TS,
                    "mono_us": 0,
                    "turn": 0,
                    "type": "note",
                    "actor": "orca",
                    "payload": {"$blob": "sha256:short", "bytes": 1},
                }
            )

    @pytest.mark.parametrize("missing", ["seq", "ts", "mono_us", "turn", "type", "actor"])
    def test_rejects_a_missing_required_field(self, missing: str) -> None:
        raw = {"seq": 0, "ts": TS, "mono_us": 0, "turn": 0, "type": "note", "actor": "orca"}
        del raw[missing]
        with pytest.raises(TraceFormatError) as excinfo:
            TraceEvent.from_json(raw)
        assert missing in str(excinfo.value)

    @pytest.mark.parametrize(
        "bad",
        [
            {"seq": -1},
            {"seq": 1.5},
            {"seq": True},  # bool passes isinstance(int) in Python; the schema says integer
            {"mono_us": -1},
            {"turn": "0"},
            {"actor": "robot"},
            {"type": "note.unknown"},
            {"ts": 17},
            {"ts": "2026-08-29"},  # date alone is not a date-time
            {"ts": "2026-08-29T10:00:00"},  # ajv-formats requires a zone; so do we
            {"ts": "not a timestamp"},
            {"causes": [1, "2"]},
            {"causes": "1"},
            {"attrs": [1, 2]},
            {"redacted": [1]},
            {"nope": 1},  # additionalProperties false
        ],
    )
    def test_rejects_envelope_violations(self, bad: dict) -> None:
        raw = {"seq": 0, "ts": TS, "mono_us": 0, "turn": 0, "type": "note", "actor": "orca"}
        raw.update(bad)
        with pytest.raises(TraceFormatError):
            TraceEvent.from_json(raw)

    def test_accepts_a_forward_causal_edge_because_the_schema_does(self) -> None:
        """Spec §2.1 says each cause MUST be < seq, but the JSON Schema does not encode it.

        Dropping the event here would make this reader disagree with the TypeScript one about
        which events a trace contains. The violation is reported by TraceReader.problems()
        instead; see test_reader.py.
        """
        raw = {"seq": 2, "ts": TS, "mono_us": 0, "turn": 0, "type": "note", "actor": "orca", "causes": [5]}
        assert TraceEvent.from_json(raw).causes == (5,)


class TestManifest:
    def test_parses_a_minimal_manifest(self) -> None:
        m = Manifest.from_json(
            {
                "schema_version": "0.1.0",
                "run_id": "run_9f2c14a03b71",
                "created_at": "2026-08-29T10:13:38.000Z",
                "orca_version": "0.1.0",
                "adapter": {"id": "claude-code"},
                "argv": ["claude"],
                "cwd": "/home/dev/api",
            }
        )
        assert m.run_id == "run_9f2c14a03b71"
        assert m.adapter_id == "claude-code"
        assert m.argv == ("claude",)
        assert m.events_sha256 is None
        assert m.ended_at is None

    def test_exposes_the_integrity_root(self) -> None:
        m = Manifest.from_json(
            {
                "schema_version": "0.1.0",
                "run_id": "run_abc123",
                "created_at": TS,
                "orca_version": "0.1.0",
                "adapter": {"id": "a"},
                "argv": [],
                "cwd": "/",
                "integrity": {"events_sha256": "ab" * 32, "blob_count": 5},
            }
        )
        assert m.events_sha256 == "ab" * 32
        assert m.integrity is not None and m.integrity["blob_count"] == 5

    def test_parses_a_forked_run(self) -> None:
        m = Manifest.from_json(
            {
                "schema_version": "0.1.0",
                "run_id": "run_abc123",
                "created_at": TS,
                "orca_version": "0.1.0",
                "adapter": {"id": "a"},
                "argv": [],
                "cwd": "/",
                "parent_run": "run_9f2c14a03b71",
                "fork_point": 18,
                "fork_model": "claude-opus-5",
            }
        )
        assert m.is_fork
        assert (m.parent_run, m.fork_point, m.fork_model) == ("run_9f2c14a03b71", 18, "claude-opus-5")

    def test_a_plain_run_is_not_a_fork(self) -> None:
        m = Manifest.from_json(
            {
                "schema_version": "0.1.0",
                "run_id": "run_abc123",
                "created_at": TS,
                "orca_version": "0.1.0",
                "adapter": {"id": "a"},
                "argv": [],
                "cwd": "/",
            }
        )
        assert not m.is_fork

    @pytest.mark.parametrize(
        "bad",
        [
            {"run_id": "9f2c14a03b71"},  # missing the run_ prefix
            {"run_id": "run_XYZ"},
            {"run_id": "run_ab"},  # under the 6 hex minimum
            {"argv": "claude"},
            {"adapter": {"version": "1"}},  # adapter.id is required
            {"counts": {"events": "27"}},
            {"platform": {"os": "linux", "arch": "x64"}},  # node is required
            {"git": {"dirty": "yes"}},
            {"redaction": {"policy_version": "1"}},
            {"redaction": {"policy_version": 1, "rules_fired": {"auth_header": "12"}}},
            {"env_allowlisted": {"TERM": 5}},
            {"integrity": {"events_sha256": "ab" * 32}},  # blob_count is required
            {"fork_point": -1},
        ],
    )
    def test_rejects_manifest_violations(self, bad: dict) -> None:
        raw = {
            "schema_version": "0.1.0",
            "run_id": "run_abc123",
            "created_at": TS,
            "orca_version": "0.1.0",
            "adapter": {"id": "a"},
            "argv": [],
            "cwd": "/",
        }
        raw.update(bad)
        with pytest.raises(TraceFormatError):
            Manifest.from_json(raw)

    @pytest.mark.parametrize("missing", ["schema_version", "run_id", "created_at", "orca_version", "adapter", "argv", "cwd"])
    def test_rejects_a_missing_required_field(self, missing: str) -> None:
        raw = {
            "schema_version": "0.1.0",
            "run_id": "run_abc123",
            "created_at": TS,
            "orca_version": "0.1.0",
            "adapter": {"id": "a"},
            "argv": [],
            "cwd": "/",
        }
        del raw[missing]
        with pytest.raises(TraceFormatError):
            Manifest.from_json(raw)


class TestCheckpoint:
    def test_is_a_frozen_record_of_seq_turn_and_tree(self) -> None:
        cp = Checkpoint(seq=13, turn=3, fs_tree="9c1e")
        assert (cp.seq, cp.turn, cp.fs_tree) == (13, 3, "9c1e")
        with pytest.raises(Exception):
            cp.seq = 14  # type: ignore[misc]

    def test_tree_is_optional_because_a_snapshot_may_not_record_one(self) -> None:
        assert Checkpoint(seq=0, turn=0).fs_tree is None
