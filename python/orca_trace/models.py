"""Frozen mirrors of the Orca trace v0 JSON Schema.

The schema in `packages/schema/schema/` is normative and these types are *verified against* it,
never the reverse — `tests/test_models.py` asserts the enums here equal the schema's enums, which
is the same drift protection the TypeScript package gets from its schema-parity test.

Validation lives here rather than in the reader because "is this a well-formed event" is a
question about the format, and a second implementation that answers it differently from the first
is how a format quietly becomes two formats.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from collections.abc import Mapping, Sequence
from typing import Any, Final, NoReturn

__all__ = [
    "ACTORS",
    "BLOB_REF_PATTERN",
    "EVENT_TYPES",
    "INLINE_PAYLOAD_LIMIT",
    "RUN_ID_PATTERN",
    "SCHEMA_VERSION",
    "BlobRef",
    "Checkpoint",
    "Manifest",
    "OrcaTraceError",
    "TraceEvent",
    "TraceFormatError",
]

SCHEMA_VERSION: Final = "0.1.0"

#: Spec §2.3. Adding a type is a MINOR bump, so a reader that meets an unknown one skips the
#: event rather than failing the trace — see `TraceReader.problems`.
EVENT_TYPES: Final[frozenset[str]] = frozenset(
    {
        "run.start",
        "run.end",
        "model.request",
        "model.response",
        "tool.call",
        "tool.result",
        "mcp.request",
        "mcp.response",
        "shell.exec",
        "shell.result",
        "fs.snapshot",
        "fs.change",
        "net.request",
        "net.response",
        "error",
        "divergence",
        "checkpoint",
        "fork",
        "route.decision",
        "note",
    }
)

ACTORS: Final[frozenset[str]] = frozenset(
    {"agent", "harness", "model", "orca", "gateway", "tool", "user"}
)

RUN_ID_PATTERN: Final = re.compile(r"^run_[0-9a-f]{6,32}$")
BLOB_REF_PATTERN: Final = re.compile(r"^sha256:[0-9a-f]{64}$")

#: Spec §2.2. Writers spill anything larger; readers only need it to explain a surprise.
INLINE_PAYLOAD_LIMIT: Final = 4096

# RFC3339 with a mandatory offset, matching what ajv-formats asserts for `format: date-time`
# on the TypeScript side. JSON Schema treats `format` as an annotation by default, so this is a
# place where two conforming implementations can legitimately differ; we chose to agree with the
# reference implementation rather than with the default.
_RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$"
)


# Property sets, kept at module scope: a `Final` annotation inside a slotted dataclass would be
# collected as a field, not a class constant.
_BLOB_KEYS: Final = frozenset({"$blob", "bytes", "media_type"})
_EVENT_KEYS: Final = frozenset(
    {"seq", "ts", "mono_us", "turn", "type", "actor", "causes", "attrs", "payload", "redacted"}
)
_EVENT_REQUIRED: Final = ("seq", "ts", "mono_us", "turn", "type", "actor")
_MANIFEST_KEYS: Final = frozenset(
    {
        "schema_version",
        "run_id",
        "created_at",
        "ended_at",
        "orca_version",
        "adapter",
        "argv",
        "cwd",
        "env_allowlisted",
        "git",
        "platform",
        "counts",
        "redaction",
        "parent_run",
        "fork_point",
        "fork_model",
        "exit_code",
        "integrity",
    }
)
_MANIFEST_REQUIRED: Final = (
    "schema_version",
    "run_id",
    "created_at",
    "orca_version",
    "adapter",
    "argv",
    "cwd",
)
_SHA256_HEX: Final = re.compile(r"^[0-9a-f]{64}$")


class OrcaTraceError(Exception):
    """Base class for everything this SDK raises, so callers can catch one thing."""


class TraceFormatError(OrcaTraceError, ValueError):
    """A value does not conform to the normative schema."""


def _fail(path: str, message: str) -> NoReturn:
    raise TraceFormatError(f"{path} {message}")


def _mapping(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _fail(path, "must be an object")
    return value


def _string(value: Any, path: str, *, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str):
        _fail(path, "must be a string")
    if pattern is not None and pattern.match(value) is None:
        _fail(path, f"must match {pattern.pattern}")
    return value


def _timestamp(value: Any, path: str) -> str:
    text = _string(value, path)
    if _RFC3339.match(text) is None:
        _fail(path, "must be an RFC3339 date-time with an offset")
    return text


def _integer(value: Any, path: str, *, minimum: int | None = None) -> int:
    # bool is a subclass of int in Python but not an integer in JSON, and `"bytes": true`
    # sailing through as 1 would corrupt a blob length.
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(path, "must be an integer")
    if minimum is not None and value < minimum:
        _fail(path, f"must be >= {minimum}")
    return value


def _sequence(value: Any, path: str) -> Sequence[Any]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        _fail(path, "must be an array")
    return value


def _strings(value: Any, path: str) -> tuple[str, ...]:
    return tuple(_string(v, f"{path}/{i}") for i, v in enumerate(_sequence(value, path)))


def _integers(value: Any, path: str, *, minimum: int | None = None) -> tuple[int, ...]:
    return tuple(
        _integer(v, f"{path}/{i}", minimum=minimum) for i, v in enumerate(_sequence(value, path))
    )


def _closed(raw: Mapping[str, Any], allowed: frozenset[str], path: str) -> None:
    """Enforce `additionalProperties: false`, which the schema sets on every object it defines."""
    extra = sorted(set(raw) - allowed)
    if extra:
        _fail(path, f"has unexpected propert{'y' if len(extra) == 1 else 'ies'} {', '.join(extra)}")


def _require(raw: Mapping[str, Any], names: Sequence[str], path: str) -> None:
    for name in names:
        if name not in raw:
            _fail(path, f"is missing required property {name}")


@dataclass(frozen=True, slots=True)
class BlobRef:
    """A reference to a content-addressed payload. Spec §2.2.

    `$blob` is not a Python identifier, so the digest is exposed as `digest`; the wire name is
    kept for `bytes` and `media_type` so the mapping back to the JSON stays obvious.
    """

    digest: str
    bytes: int
    media_type: str | None = None

    @property
    def hex(self) -> str:
        """The bare 64-character digest, which is also its path under `blobs/`."""
        return self.digest.split(":", 1)[1]

    @property
    def shard(self) -> str:
        """First two hex characters — the directory a blob lives in (spec §2.2)."""
        return self.hex[:2]

    @staticmethod
    def looks_like(value: Any) -> bool:
        """True for any object carrying `$blob`.

        Spec §2.2 makes the mere presence of the key decisive: such an object MUST be a
        well-formed reference, so a malformed one is an invalid event rather than opaque data.
        Recognition therefore cannot depend on the rest of the object being valid.
        """
        return isinstance(value, Mapping) and "$blob" in value

    @classmethod
    def from_json(cls, raw: Any, path: str = "/payload") -> BlobRef:
        obj = _mapping(raw, path)
        _require(obj, ("$blob", "bytes"), path)
        _closed(obj, _BLOB_KEYS, path)
        media = obj.get("media_type")
        return cls(
            digest=_string(obj["$blob"], f"{path}/$blob", pattern=BLOB_REF_PATTERN),
            bytes=_integer(obj["bytes"], f"{path}/bytes", minimum=0),
            media_type=None if media is None else _string(media, f"{path}/media_type"),
        )


@dataclass(frozen=True, slots=True)
class TraceEvent:
    """One line of events.jsonl. Spec §2.1.

    `mono_us` is authoritative for duration; `ts` is a wall clock and wall clocks lie.
    """

    seq: int
    ts: str
    mono_us: int
    turn: int
    type: str
    actor: str
    causes: tuple[int, ...] = ()
    attrs: dict[str, Any] = field(default_factory=dict)
    payload: Any = None
    redacted: tuple[str, ...] = ()

    @classmethod
    def from_json(cls, raw: Any, path: str = "") -> TraceEvent:
        obj = _mapping(raw, path or "/")
        _require(obj, _EVENT_REQUIRED, path or "/")
        _closed(obj, _EVENT_KEYS, path or "/")

        event_type = _string(obj["type"], f"{path}/type")
        if event_type not in EVENT_TYPES:
            _fail(f"{path}/type", f"is not a known event type: {event_type!r}")
        actor = _string(obj["actor"], f"{path}/actor")
        if actor not in ACTORS:
            _fail(f"{path}/actor", f"is not a known actor: {actor!r}")

        attrs = obj.get("attrs")
        payload = obj.get("payload")
        return cls(
            seq=_integer(obj["seq"], f"{path}/seq", minimum=0),
            ts=_timestamp(obj["ts"], f"{path}/ts"),
            mono_us=_integer(obj["mono_us"], f"{path}/mono_us", minimum=0),
            turn=_integer(obj["turn"], f"{path}/turn", minimum=0),
            type=event_type,
            actor=actor,
            causes=() if "causes" not in obj else _integers(obj["causes"], f"{path}/causes", minimum=0),
            attrs={} if attrs is None else dict(_mapping(attrs, f"{path}/attrs")),
            payload=BlobRef.from_json(payload, f"{path}/payload")
            if BlobRef.looks_like(payload)
            else payload,
            redacted=() if "redacted" not in obj else _strings(obj["redacted"], f"{path}/redacted"),
        )

    @property
    def blob(self) -> BlobRef | None:
        """The payload's blob reference, or None when the payload is inline or absent."""
        return self.payload if isinstance(self.payload, BlobRef) else None


@dataclass(frozen=True, slots=True)
class Manifest:
    """Run metadata and the integrity root. Spec §1 and §6.

    Nested objects stay as plain dicts: they are open-ended metadata, and a reader that pins them
    into dataclasses gains nothing but a new way to reject a trace a newer writer produced.
    """

    schema_version: str
    run_id: str
    created_at: str
    orca_version: str
    adapter: dict[str, Any]
    argv: tuple[str, ...]
    cwd: str
    ended_at: str | None = None
    env_allowlisted: dict[str, str] = field(default_factory=dict)
    git: dict[str, Any] | None = None
    platform: dict[str, Any] | None = None
    counts: dict[str, int] | None = None
    redaction: dict[str, Any] | None = None
    parent_run: str | None = None
    fork_point: int | None = None
    fork_model: str | None = None
    exit_code: int | None = None
    integrity: dict[str, Any] | None = None

    @property
    def adapter_id(self) -> str:
        return str(self.adapter["id"])

    @property
    def events_sha256(self) -> str | None:
        """The integrity root, or None for a run that was never sealed (it crashed)."""
        return None if self.integrity is None else str(self.integrity["events_sha256"])

    @property
    def is_fork(self) -> bool:
        return self.parent_run is not None

    @classmethod
    def from_json(cls, raw: Any, path: str = "") -> Manifest:
        obj = _mapping(raw, path or "/")
        _require(obj, _MANIFEST_REQUIRED, path or "/")
        _closed(obj, _MANIFEST_KEYS, path or "/")

        adapter = _mapping(obj["adapter"], f"{path}/adapter")
        _require(adapter, ("id",), f"{path}/adapter")
        _closed(adapter, frozenset({"id", "version", "harness_version"}), f"{path}/adapter")
        _string(adapter["id"], f"{path}/adapter/id")

        integrity = obj.get("integrity")
        if integrity is not None:
            integrity = _mapping(integrity, f"{path}/integrity")
            _require(integrity, ("events_sha256", "blob_count"), f"{path}/integrity")
            _closed(integrity, frozenset({"events_sha256", "blob_count"}), f"{path}/integrity")
            _string(
                integrity["events_sha256"],
                f"{path}/integrity/events_sha256",
                pattern=_SHA256_HEX,
            )
            _integer(integrity["blob_count"], f"{path}/integrity/blob_count", minimum=0)

        env = obj.get("env_allowlisted")
        if env is not None:
            env = _mapping(env, f"{path}/env_allowlisted")
            for key, value in env.items():
                _string(value, f"{path}/env_allowlisted/{key}")

        for name, keys in (
            ("git", frozenset({"head", "branch", "dirty"})),
            ("platform", frozenset({"os", "arch", "node"})),
            ("counts", frozenset({"events", "blobs"})),
            ("redaction", frozenset({"policy_version", "rules_fired"})),
        ):
            value = obj.get(name)
            if value is not None:
                _closed(_mapping(value, f"{path}/{name}"), keys, f"{path}/{name}")
        if obj.get("platform") is not None:
            _require(obj["platform"], ("os", "arch", "node"), f"{path}/platform")
        if obj.get("redaction") is not None:
            _require(obj["redaction"], ("policy_version",), f"{path}/redaction")

        parent = obj.get("parent_run")
        return cls(
            schema_version=_string(obj["schema_version"], f"{path}/schema_version"),
            run_id=_string(obj["run_id"], f"{path}/run_id", pattern=RUN_ID_PATTERN),
            created_at=_timestamp(obj["created_at"], f"{path}/created_at"),
            orca_version=_string(obj["orca_version"], f"{path}/orca_version"),
            adapter=dict(adapter),
            argv=_strings(obj["argv"], f"{path}/argv"),
            cwd=_string(obj["cwd"], f"{path}/cwd"),
            ended_at=None
            if obj.get("ended_at") is None
            else _timestamp(obj["ended_at"], f"{path}/ended_at"),
            env_allowlisted={} if env is None else dict(env),
            git=None if obj.get("git") is None else dict(obj["git"]),
            platform=None if obj.get("platform") is None else dict(obj["platform"]),
            counts=None if obj.get("counts") is None else dict(obj["counts"]),
            redaction=None if obj.get("redaction") is None else dict(obj["redaction"]),
            parent_run=None
            if parent is None
            else _string(parent, f"{path}/parent_run", pattern=RUN_ID_PATTERN),
            fork_point=None
            if obj.get("fork_point") is None
            else _integer(obj["fork_point"], f"{path}/fork_point", minimum=0),
            fork_model=None
            if obj.get("fork_model") is None
            else _string(obj["fork_model"], f"{path}/fork_model"),
            exit_code=None
            if obj.get("exit_code") is None
            else _integer(obj["exit_code"], f"{path}/exit_code"),
            integrity=None if integrity is None else dict(integrity),
        )


@dataclass(frozen=True, slots=True)
class Checkpoint:
    """A forkable point in a run. Derived from the log, never recorded (spec §3).

    `fs_tree` is the TypeScript `fsTree`, renamed for Python. It is absent when the governing
    `fs.snapshot` recorded no tree id.
    """

    seq: int
    turn: int
    fs_tree: str | None = None
