"""Reading one recorded run.

Two tolerances are mandated by spec §2 and both are deliberate: a run that crashed mid-write
leaves a partial final line, and a trace written by a newer Orca carries event types this build
has never heard of. Neither may take down the whole trace. Neither is hidden either — everything
skipped, and everything that violates the spec without being skippable, shows up in
:meth:`TraceReader.problems`, because a reader that quietly drops events produces evaluation
datasets with holes nobody can see.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from .models import (
    EVENT_TYPES,
    BlobRef,
    Manifest,
    OrcaTraceError,
    TraceEvent,
    TraceFormatError,
)

__all__ = [
    "BlobIntegrityError",
    "BlobNotFoundError",
    "NotATraceError",
    "TraceReader",
]

_HASH_CHUNK: Final = 1 << 20
_SHA256_PREFIX: Final = "sha256:"
_HEX64_LENGTH: Final = 64


class NotATraceError(OrcaTraceError):
    """The directory is not a readable Orca run."""


class BlobNotFoundError(OrcaTraceError, FileNotFoundError):
    """A payload references a blob that is not in the store."""


class BlobIntegrityError(OrcaTraceError):
    """A blob's content does not hash to the name it is stored under."""


def _bare_digest(ref: BlobRef | str) -> str:
    """The 64-char hex digest of `ref`, whatever form it arrived in.

    Digests come out of a file on disk, so this is also the path-traversal guard: nothing that
    is not 64 hex characters is ever joined onto the blob root.
    """
    raw = ref.digest if isinstance(ref, BlobRef) else ref
    if not isinstance(raw, str):
        raise TraceFormatError(f"invalid blob digest: {raw!r}")
    hexdigest = raw[len(_SHA256_PREFIX) :] if raw.startswith(_SHA256_PREFIX) else raw
    if len(hexdigest) != _HEX64_LENGTH or any(c not in "0123456789abcdef" for c in hexdigest):
        raise TraceFormatError(f"invalid blob digest: {raw!r}")
    return hexdigest


@dataclass(frozen=True, slots=True)
class _Line:
    number: int
    text: str


class TraceReader:
    """Read-only view of a run directory (spec §1).

    There is no writer here on purpose. The TypeScript implementation owns the write path, and a
    second writer would mean a second redaction implementation — which is how a secret leaks.
    """

    def __init__(self, run_dir: Path, manifest: Manifest) -> None:
        self._run_dir = run_dir
        self._events_path = run_dir / "events.jsonl"
        self._manifest = manifest
        self._problems: list[str] = []
        self._expected_seq: int | None = 0
        self._has_read = False

    @classmethod
    def open(cls, run_dir: str | Path) -> TraceReader:
        """Open `run_dir`, validating its manifest.

        The manifest is read once and trusted from then on — every later answer depends on it —
        so unlike events.jsonl it is validated up front rather than tolerated.
        """
        directory = Path(run_dir)
        path = directory / "manifest.json"
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise NotATraceError(f"not an orca run: cannot read {path}") from exc
        try:
            parsed = json.loads(raw)
        except ValueError as exc:
            raise NotATraceError(f"invalid manifest: {path} is not JSON") from exc
        return cls(directory, Manifest.from_json(parsed))

    def __repr__(self) -> str:
        return f"TraceReader({self._manifest.run_id!r}, {str(self._run_dir)!r})"

    @property
    def run_dir(self) -> Path:
        return self._run_dir

    @property
    def events_path(self) -> Path:
        return self._events_path

    @property
    def manifest(self) -> Manifest:
        return self._manifest

    def problems(self) -> list[str]:
        """Everything the last read pass could not use, or could not vouch for.

        Reads the trace first if nobody has yet, because returning an empty list for an unread
        trace would hide precisely what this method exists to surface.
        """
        if not self._has_read:
            for _ in self.stream():
                pass
        return list(self._problems)

    def events(self) -> list[TraceEvent]:
        """Every valid event, in log order. Loads the whole trace; see :meth:`stream` for big ones."""
        return list(self.stream())

    def stream(self) -> Iterator[TraceEvent]:
        """Yield events one at a time, holding at most two lines in memory.

        A trace can be hundreds of megabytes because every model turn resends the conversation,
        so the reader that turns traces into datasets must never need the file resident.

        One line is held back so the last one can be told apart from the rest: only the final
        line may legitimately be half-written (spec §2). A pass resets :meth:`problems`, so run
        one pass at a time.
        """
        self._problems = []
        self._expected_seq = 0
        self._has_read = True

        if not self._events_path.is_file():
            self._problems.append(f"events.jsonl: missing at {self._events_path}")
            return

        held: _Line | None = None
        # errors="replace" rather than "strict": a crash can cut a multi-byte character in half,
        # and that line should be reported like any other bad line instead of ending the read.
        with self._events_path.open("r", encoding="utf-8", errors="replace") as handle:
            for number, text in enumerate(handle, start=1):
                if not text.strip():
                    continue
                if held is not None:
                    event = self._parse(held, last=False)
                    if event is not None:
                        yield event
                held = _Line(number, text)
            if held is not None:
                event = self._parse(held, last=True)
                if event is not None:
                    yield event

    def blob(self, ref: BlobRef | str, *, verify: bool = False) -> bytes:
        """The bytes of a content-addressed payload (spec §2.2).

        `verify` re-hashes the content. It is off by default so that an unverified read returns
        exactly what the TypeScript reader returns; the spec makes integrity checking a duty for
        `events.jsonl` (§6) but never states one for blobs, so silently differing here would be
        a worse failure than a corrupt byte.
        """
        hexdigest = _bare_digest(ref)
        path = self._run_dir / "blobs" / hexdigest[:2] / hexdigest
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise BlobNotFoundError(
                f"blob not found: {_SHA256_PREFIX}{hexdigest} (looked in {path})"
            ) from exc
        if verify:
            actual = hashlib.sha256(data).hexdigest()
            if actual != hexdigest:
                raise BlobIntegrityError(
                    f"blob {path} does not match its digest: expected {hexdigest}, got {actual}"
                )
        return data

    def payload(self, event: TraceEvent) -> Any:
        """The event's payload: the inline value, or the blob read back and decoded.

        Undecodable content comes back as `bytes` rather than raising. Callers building datasets
        sweep every event in a trace, and one binary diff should not abort the sweep — the type
        of the return value already says what happened.
        """
        ref = event.blob
        if ref is None:
            return event.payload
        data = self.blob(ref)
        if ref.media_type is not None and "json" not in ref.media_type.lower():
            return data
        try:
            return json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return data

    def verify_integrity(self) -> tuple[bool, str, str]:
        """(ok, expected, actual) over events.jsonl. Spec §6: report a mismatch, never repair it.

        `expected` is empty for a run that was never sealed — a crashed run has no integrity root,
        which is not the same as failing one, so `ok` is False and the caller can tell them apart.
        """
        expected = self._manifest.events_sha256 or ""
        digest = hashlib.sha256()
        try:
            with self._events_path.open("rb") as handle:
                while chunk := handle.read(_HASH_CHUNK):
                    digest.update(chunk)
        except OSError:
            return False, expected, ""
        actual = digest.hexdigest()
        return bool(expected) and expected == actual, expected, actual

    def _report(self, line: int, reason: str) -> None:
        self._problems.append(f"line {line}: {reason}")

    def _parse(self, line: _Line, *, last: bool) -> TraceEvent | None:
        try:
            value = json.loads(line.text)
        except ValueError:
            self._report(line.number, "truncated final line" if last else "malformed JSON")
            # The lost line's seq is unknowable, so density resynchronises on the next one
            # rather than blaming it for a gap this line already accounts for.
            self._expected_seq = None
            return None

        if not isinstance(value, Mapping):
            self._report(line.number, "not a JSON object")
            self._expected_seq = None
            return None

        self._check_density(line, value)

        event_type = value.get("type")
        if not isinstance(event_type, str) or event_type not in EVENT_TYPES:
            # Spec §2.3: adding a type is a MINOR bump, so an unknown one is a newer writer,
            # not a broken trace.
            self._report(
                line.number,
                f"unknown event type {event_type!r} — skipped for forward compatibility",
            )
            return None

        try:
            event = TraceEvent.from_json(value)
        except TraceFormatError as exc:
            self._report(line.number, str(exc))
            return None

        self._check_causes(line, event)
        return event

    def _check_density(self, line: _Line, value: Mapping[str, Any]) -> None:
        """Spec §2.1: seq is a dense total order starting at 0. A hole means a lost event."""
        seq = value.get("seq")
        if isinstance(seq, bool) or not isinstance(seq, int):
            return  # the envelope check reports the real problem
        if self._expected_seq is not None and seq != self._expected_seq:
            self._report(
                line.number,
                f"seq {seq} breaks the dense order — expected {self._expected_seq}",
            )
        self._expected_seq = seq + 1

    def _check_causes(self, line: _Line, event: TraceEvent) -> None:
        """Spec §2.1 requires every cause < seq, but the JSON Schema does not encode it.

        Reported rather than enforced: dropping the event would make this reader disagree with
        the TypeScript one about what a trace contains, which is a worse outcome than a noted
        edge that points the wrong way.
        """
        forward = [c for c in event.causes if c >= event.seq]
        if forward:
            self._report(
                line.number,
                f"causes {forward} do not precede seq {event.seq} (spec §2.1)",
            )
