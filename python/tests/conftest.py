"""Shared fixtures: the repo's checked-in example trace, and builders for synthetic ones."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

EXAMPLE_RUN_ID = "run_9f2c14a03b71"


def repo_root() -> Path | None:
    """The OrcaReplay checkout containing this package, when it is present.

    The SDK is publishable on its own, so tests that read repo fixtures must be able to tell
    that they are running outside the repo rather than fail confusingly.
    """
    for parent in Path(__file__).resolve().parents:
        if (parent / "spec" / "orca-trace-v0.md").is_file():
            return parent
    return None


@pytest.fixture
def example_run() -> Path:
    root = repo_root()
    if root is None:
        pytest.skip("not running inside an OrcaReplay checkout")
    run = root / "examples" / "traces" / EXAMPLE_RUN_ID
    if not run.is_dir():
        pytest.skip(f"missing example trace {run}")
    return run


def write_trace(
    directory: Path,
    events: list[dict[str, Any]],
    *,
    manifest: dict[str, Any] | None = None,
    trailing: str = "",
    seal: bool = True,
    blobs: dict[str, bytes] | None = None,
) -> Path:
    """Write a minimal but schema-valid run directory, plus whatever damage a test asks for.

    `trailing` is appended verbatim after the last newline, which is how a crashed writer's
    half-line is reproduced (spec §2).
    """
    directory.mkdir(parents=True, exist_ok=True)
    body = "".join(json.dumps(e, separators=(",", ":")) + "\n" for e in events) + trailing
    events_path = directory / "events.jsonl"
    events_path.write_text(body, encoding="utf-8")

    for digest, payload in (blobs or {}).items():
        shard = directory / "blobs" / digest[:2]
        shard.mkdir(parents=True, exist_ok=True)
        (shard / digest).write_bytes(payload)

    doc: dict[str, Any] = {
        "schema_version": "0.1.0",
        "run_id": "run_abc123",
        "created_at": "2026-08-29T10:00:00.000Z",
        "orca_version": "0.1.0",
        "adapter": {"id": "test-adapter"},
        "argv": ["agent"],
        "cwd": "/work",
    }
    if seal:
        doc["integrity"] = {
            "events_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
            "blob_count": len(blobs or {}),
        }
    if manifest is not None:
        doc.update(manifest)
    (directory / "manifest.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")
    return directory


def event(seq: int, type_: str = "note", **over: Any) -> dict[str, Any]:
    """One schema-valid envelope. Mirrors the `ev()` helper in packages/core/test."""
    base: dict[str, Any] = {
        "seq": seq,
        "ts": "2026-08-29T10:00:00.000Z",
        "mono_us": seq * 1000,
        "turn": 0,
        "type": type_,
        "actor": "orca",
    }
    base.update(over)
    return base


def blob_of(data: bytes) -> tuple[str, str]:
    """(bare hex digest, `sha256:` ref) for content a test wants in the blob store."""
    hexdigest = hashlib.sha256(data).hexdigest()
    return hexdigest, f"sha256:{hexdigest}"
