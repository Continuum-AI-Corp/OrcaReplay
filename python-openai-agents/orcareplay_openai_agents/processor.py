"""A `TracingProcessor` that writes the OpenAI Agents SDK's run structure where orca can read it.

## What this is for, and what it is not for

orca records model traffic at a proxy, and that is where every claim about capture comes from. This
package does not change that and is not needed for it: a run recorded without it is complete in the
sense the rest of the project means. What it adds is the part a proxy structurally cannot see.

Measured on a two-agent run with a handoff and a guardrail — the same script recorded twice, once
with this processor and once without:

| the trace can answer                | without | with |
|-------------------------------------|---------|------|
| which agent a turn belonged to       | no      | yes  |
| that a handoff happened, and from whom | no    | yes  |
| that a guardrail ran                 | no      | yes  |

The middle row is the sharp one. The SDK implements a handoff as a function tool called
`transfer_to_<agent>`, so the proxy records an ordinary tool call and an ordinary next request. A
rule could *guess* a handoff from the tool name — but a user tool may be called that too, and the
agent it came **from** never reaches the wire at all. `orca graph` already distinguishes what a
trace records from what a rule infers; this moves handoffs from the second column to the first.

`ResponseSpanData` and `GenerationSpanData` are deliberately dropped. The proxy already has those
exchanges, byte for byte, and writing them again would put a second, worse copy of the model
conversation in the trace.

## How it is installed

Not by editing your agent. `orca record` puts this on `PYTHONPATH` with a `sitecustomize` that
registers it, the same way the Node adapter installs a fetch hook through `NODE_OPTIONS`. Calling
`install()` yourself is supported for anyone who would rather be explicit.

Because it runs before your first statement, it *replaces* the processor list rather than appending
to it — at that moment the list holds only the SDK's own exporter, which ships traces to OpenAI, and
a second egress out of a run being recorded is rarely what anyone wants. Anything you register
afterwards is added on top and keeps working. See `install` for the reasoning and the escape hatch.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import asdict, is_dataclass
from typing import Any

# The path orca hands us. Absent means orca is not recording this run, and then this package does
# nothing at all — which is what makes it safe to leave installed.
SPANS_ENV = "ORCA_AGENT_SPANS"

#: The span types orca turns into events, and the only fields it reads from each.
#:
#: A whitelist, not a blocklist, and the reason is the one rule this package cannot bend.
#: CONTRIBUTING: "Secrets never reach disk or a TTY. Redaction lives in the write path. If you add a
#: new sink, it goes through the redactor." This file *is* a new sink, and the redactor lives in the
#: TypeScript write path — `python/README.md` says why there is no second one: "a second writer
#: means a second redaction implementation, which is how a secret leaks."
#:
#: So nothing here may write a payload a user put there. `FunctionSpanData.export()` is
#: `{name, input, output}` — a tool's arguments and its result, which is where an `Authorization`
#: header or a returned credential lives. `MCPToolCallSpanData` carries `arguments` and `result`.
#: `CustomSpanData` is whatever the agent passed to `custom_span(data=...)`. The same bytes are
#: scrubbed in `events.jsonl`, and `orca scrub` does not rewrite this file, so a credential written
#: here survives a scrub that reports success.
#:
#: Everything below is a name, a count or a boolean the agent's author chose as an identifier, and
#: the three types are exactly what `eventForSpan` maps. A fourth type is added by listing its
#: fields here — never by widening this to the whole export.
KEEP: dict[str, tuple[str, ...]] = {
    "AgentSpanData": ("name", "handoffs", "tools", "output_type"),
    "HandoffSpanData": ("from_agent", "to_agent"),
    "GuardrailSpanData": ("name", "triggered"),
}


def _plain(value: Any) -> Any:
    """Whatever survives JSON, without pretending a rich object is simple.

    Every branch is guarded, including the `repr` fallback. That is not paranoia about hypothetical
    objects: a span payload is whatever the agent put in it, `asdict` walks arbitrary user types, and
    an object whose `__repr__` raises would otherwise take the run down from inside a debugging aid.
    A value we cannot describe becomes a placeholder; the run continues.
    """
    try:
        if is_dataclass(value) and not isinstance(value, type):
            return {k: _plain(v) for k, v in asdict(value).items()}
        if isinstance(value, dict):
            return {str(k): _plain(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [_plain(v) for v in value]
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        return repr(value)
    except Exception:  # noqa: BLE001 - see the docstring: never raise out of here
        return "<unrepresentable>"


def _read(obj: Any, name: str) -> Any:
    """One attribute, or None.

    `getattr` looks free and is not: an SDK is entitled to make any of these a property, and a
    property is user code. `_plain` guards what it is *handed*, which is no help when the raise
    happens while building the argument list — that is the shape of the bug this replaced, where a
    `ValueError` from `export()` escaped `on_span_end` and, because the SDK calls it synchronously
    from `Span.finish()`, surfaced as the user's own `Runner.run()` raising. A debugger that ends
    the run it is watching is worse than one that records nothing.
    """
    try:
        return getattr(obj, name, None)
    except Exception:  # noqa: BLE001 - same posture as `_plain`: never raise out of here
        return None


def _kept(data: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    """The whitelisted fields of a span's own export, and nothing else. See `KEEP`.

    `export()` is the call that walks the user's payload, so it is the one most likely to raise:
    `CustomSpanData.export()` JSON-encodes whatever was handed to `custom_span(data=...)` and raises
    on a circular reference, and a pydantic-backed export raises on a field it cannot serialise.
    """
    try:
        export = getattr(data, "export", None)
        exported = export() if callable(export) else {}
    except Exception:  # noqa: BLE001 - never raise out of here
        return {}
    if not isinstance(exported, dict):
        return {}
    return {k: _plain(exported[k]) for k in fields if k in exported}


class OrcaTracingProcessor:
    """Writes one JSON object per span to the file orca named, and nothing else.

    Not a subclass of `agents.tracing.TracingProcessor`: importing the SDK to define this class
    would make the module unimportable without it, and the whole point is that it is inert when the
    SDK is absent. The SDK checks the methods, not the base class.
    """

    def __init__(self, path: str | None = None) -> None:
        self._path = path or os.environ.get(SPANS_ENV)
        self._lock = threading.Lock()
        self._dropped = 0

    @property
    def active(self) -> bool:
        """False when orca is not recording, which is when this must do nothing."""
        return bool(self._path)

    def _write(self, record: dict[str, Any]) -> None:
        if not self._path:
            return
        try:
            line = json.dumps(record, ensure_ascii=False)
        except Exception:  # noqa: BLE001 - a span that will not serialise must not end the run
            self._dropped += 1
            return
        try:
            with self._lock, open(self._path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:  # noqa: BLE001 - same: a debugger must not be able to fail a run
            self._dropped += 1

    # ── the SDK's interface ───────────────────────────────────────────────────
    def on_trace_start(self, trace: Any) -> None:
        self._write(
            {
                "kind": "trace.start",
                "trace_id": getattr(trace, "trace_id", None),
                "name": getattr(trace, "name", None),
            }
        )

    def on_trace_end(self, trace: Any) -> None:
        self._write({"kind": "trace.end", "trace_id": getattr(trace, "trace_id", None)})

    def on_span_start(self, span: Any) -> None:
        # Nothing worth keeping yet: the payload is filled in by the time the span ends, and writing
        # both halves would double the file for no added fact.
        return None

    def on_span_end(self, span: Any) -> None:
        data = _read(span, "span_data")
        fields = KEEP.get(type(data).__name__ if data is not None else "unknown")
        if fields is None:
            return
        self._write(
            {
                "kind": "span",
                "type": type(data).__name__,
                "span_id": _read(span, "span_id"),
                "parent_id": _read(span, "parent_id"),
                "trace_id": _read(span, "trace_id"),
                "started_at": _read(span, "started_at"),
                "ended_at": _read(span, "ended_at"),
                "error": _plain(_read(span, "error")),
                "data": _kept(data, fields),
            }
        )

    def shutdown(self) -> None:
        return None

    def force_flush(self) -> None:
        return None


#: Set by the caller to keep the SDK's own exporter alongside ours. See `install`.
KEEP_ENV = "ORCA_AGENT_SPANS_KEEP_EXPORT"


def install(path: str | None = None) -> bool:
    """Register the processor with the SDK. Returns whether it actually did.

    False, quietly, in the two cases that are not errors: the SDK is not installed, or orca is not
    recording this run. Both are the normal state of a machine that merely has this package on it.

    **Replaces rather than appends, and only because of when it runs.** orca installs this through
    `sitecustomize`, so it executes before the user's first statement — at which point the only
    processor registered is the SDK's own exporter, which ships traces to OpenAI. Replacing there
    removes exactly that and nothing else:

      - a user who later calls `add_trace_processor` still gets theirs, appended to ours
      - a user who later calls `set_trace_processors` replaces ours, which is their explicit choice

    Appending instead would leave a second egress running through every recorded run, and on a
    machine without a real key it also fills the output with `Tracing client error 401`. Set
    `ORCA_AGENT_SPANS_KEEP_EXPORT=1` to keep it.
    """
    processor = OrcaTracingProcessor(path)
    if not processor.active:
        return False
    try:
        from agents import add_trace_processor, set_trace_processors
    except Exception:  # noqa: BLE001 - the SDK is not here; that is not a failure
        return False
    if os.environ.get(KEEP_ENV) == "1":
        add_trace_processor(processor)
    else:
        set_trace_processors([processor])
    return True
