"""Read-only Python SDK for the Orca trace format v0.

Read-only is a boundary, not a missing feature: the TypeScript writer is the one implementation
of the write path, and a second writer would mean a second redaction implementation — which is
how a secret leaks. Everything here reads a trace someone else recorded.

    from orca_trace import TraceReader, derive_checkpoints

    reader = TraceReader.open(".orca/runs/run_9f2c14a03b71")
    events = reader.events()
    checkpoints = derive_checkpoints(events)
"""

from __future__ import annotations

from .graph import Turn, causal_chain, derive_checkpoints, snap_to_checkpoint, turns_of
from .models import (
    ACTORS,
    BLOB_REF_PATTERN,
    EVENT_TYPES,
    INLINE_PAYLOAD_LIMIT,
    RUN_ID_PATTERN,
    SCHEMA_VERSION,
    BlobRef,
    Checkpoint,
    Manifest,
    OrcaTraceError,
    TraceEvent,
    TraceFormatError,
)
from .reader import BlobIntegrityError, BlobNotFoundError, NotATraceError, TraceReader

__version__ = "0.1.0"

__all__ = [
    "ACTORS",
    "BlobIntegrityError",
    "BlobNotFoundError",
    "BLOB_REF_PATTERN",
    "EVENT_TYPES",
    "INLINE_PAYLOAD_LIMIT",
    "RUN_ID_PATTERN",
    "SCHEMA_VERSION",
    "BlobRef",
    "Checkpoint",
    "Manifest",
    "NotATraceError",
    "OrcaTraceError",
    "TraceEvent",
    "TraceReader",
    "TraceFormatError",
    "Turn",
    "__version__",
    "causal_chain",
    "derive_checkpoints",
    "snap_to_checkpoint",
    "turns_of",
]
