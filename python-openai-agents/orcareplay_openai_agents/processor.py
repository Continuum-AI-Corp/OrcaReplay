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

#: What gets written, per span type: the span types `eventForSpan` turns into events, and for each
#: one only the fields it reads.
#:
#: An allow-list rather than the skip-list this began as. Skipping `ResponseSpanData` and
#: `GenerationSpanData` — the two the proxy already has byte for byte — kept the file from being a
#: second copy of the model conversation, but it let through every *other* span type and every field
#: of each: `FunctionSpanData`'s `input`/`output`/`mcp_data`, `CustomSpanData`'s arbitrary user
#: payload, `MCPListToolsSpanData`, the transcription and speech spans with their base64 audio. That
#: is the material the write-path redactor exists to strip, and the reader threw all of it away
#: anyway: `eventForSpan` maps three span types and returns `undefined` for the rest.
#:
#: So the rule is that this file carries what something reads, and nothing else. A sink that writes a
#: superset of what anything consumes is a sink that has to be protected for no benefit.
WRITTEN: dict[str, tuple[str, ...]] = {
    "AgentSpanData": ("name", "handoffs", "tools", "output_type"),
    "HandoffSpanData": ("from_agent", "to_agent"),
    "GuardrailSpanData": ("name", "triggered"),
}


def _kept(data: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    """The listed fields of a span's payload, and only those.

    Read off `export()` where the SDK offers one, because that is the shape the reader was written
    against; `getattr` is the fallback for a payload object that does not implement it. A field that
    is absent is omitted rather than written as `null`, so a reader cannot tell "the SDK did not
    provide it" from "we chose not to write it" — it never had to.
    """
    export = getattr(data, "export", None)
    source: Any = {}
    if callable(export):
        try:
            source = export() or {}
        except Exception:  # noqa: BLE001 - a payload that will not export must not end the run
            source = {}
    out: dict[str, Any] = {}
    for field in fields:
        value = source.get(field) if isinstance(source, dict) else None
        if value is None:
            value = getattr(data, field, None)
        if value is not None:
            out[field] = _plain(value)
    return out


#: Ceilings on what one payload may become. A span the SDK produces is a handful of nodes a few
#: levels deep; these are orders of magnitude above that and still bound the worst case.
_MAX_NODES = 10_000
_MAX_DEPTH = 32


def _plain(
    value: Any,
    _budget: list[int] | None = None,
    _stack: set[int] | None = None,
    _depth: int = 0,
) -> Any:
    """Whatever survives JSON, without pretending a rich object is simple.

    Every branch is guarded, including the `repr` fallback. That is not paranoia about hypothetical
    objects: a span payload is whatever the agent put in it, `asdict` walks arbitrary user types, and
    an object whose `__repr__` raises would otherwise take the run down from inside a debugging aid.
    A value we cannot describe becomes a placeholder; the run continues.

    **Bounded in three ways, and the node budget is the one that matters.** This used to walk every
    *path* through a payload rather than every node, so a structure with shared sub-objects — no
    cycle required, just a diamond repeated — cost 2^n. Measured: forty shared diamonds did not
    return in twenty seconds, and `on_span_end` hung with no error and no output inside the agent's
    own process, which is exactly what this module's docstrings promise cannot happen. Doing nothing
    would have been safer: `json.dumps` rejects a circular reference in microseconds.

    A visited set alone does not fix it. Even with each node rendered once, the *result* is a tree,
    and `json.dumps` writes a shared node once per path it appears under — so the output explodes
    even when the walk does not. Only a ceiling on how many nodes are produced bounds both, which is
    what `_budget` is. `_stack` catches the cycle separately, because "this payload refers back to
    itself" is worth saying plainly rather than reporting as truncation.

    Truncation is visible: `<truncated>`, `<too deep>` and `<circular>` all reach the trace, so a
    reader sees a payload that was abridged rather than one that quietly lost a field.
    """
    budget = [_MAX_NODES] if _budget is None else _budget
    stack = set() if _stack is None else _stack
    try:
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        if budget[0] <= 0:
            return "<truncated>"
        budget[0] -= 1
        if _depth >= _MAX_DEPTH:
            return "<too deep>"
        marker = id(value)
        if marker in stack:
            return "<circular>"
        stack.add(marker)
        try:
            if is_dataclass(value) and not isinstance(value, type):
                return {
                    k: _plain(v, budget, stack, _depth + 1) for k, v in asdict(value).items()
                }
            if isinstance(value, dict):
                return {
                    str(k): _plain(v, budget, stack, _depth + 1) for k, v in value.items()
                }
            if isinstance(value, (list, tuple)):
                return [_plain(v, budget, stack, _depth + 1) for v in value]
            return repr(value)
        finally:
            stack.discard(marker)
    except Exception:  # noqa: BLE001 - see the docstring: never raise out of here
        return "<unrepresentable>"


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
            # `default=str` so that a value JSON cannot take costs that field and nothing else.
            # Without it the failure is total and invisible: `json.dumps` raises on the whole
            # record, the except below swallows it, and a run captures no spans at all while
            # `trace.start` and `trace.end` keep landing, so the file looks healthy. Every field
            # here is a string or a scalar today, and `_plain` already renders the payload — this
            # is about what a future SDK version puts on a span, which is not ours to choose.
            line = json.dumps(record, ensure_ascii=False, default=str)
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

    @staticmethod
    def _iso(value: Any) -> Any:
        """The SDK's timestamps as the reader expects them, whatever the SDK hands over.

        `SpanImpl` stores `util.time_iso()`, which is `datetime.now(timezone.utc).isoformat()` —
        a string — and the reader parses it with `Date.parse`. That is what every supported version
        does today, and it is not a guarantee: the attribute is read off an object this package does
        not own, and `str(datetime)` is *not* the same text (a space where the `T` belongs), so
        `default=str` alone would hand the reader something subtly different rather than nothing.
        Asking the value for its own ISO form costs one `getattr` and settles both cases.
        """
        to_iso = getattr(value, "isoformat", None)
        if callable(to_iso):
            try:
                return to_iso()
            except Exception:  # noqa: BLE001 - a timestamp must not be able to end a run either
                return value
        return value

    def on_span_end(self, span: Any) -> None:
        data = getattr(span, "span_data", None)
        type_name = type(data).__name__ if data is not None else "unknown"
        fields = WRITTEN.get(type_name)
        if fields is None:
            return
        self._write(
            {
                "kind": "span",
                "type": type_name,
                "span_id": getattr(span, "span_id", None),
                "parent_id": getattr(span, "parent_id", None),
                "trace_id": getattr(span, "trace_id", None),
                "started_at": self._iso(getattr(span, "started_at", None)),
                "ended_at": self._iso(getattr(span, "ended_at", None)),
                # No `error`. The SDK's `SpanError` carries a free-form `data` dict — a tool's
                # input, an API error echoed back, a guardrail's `output_info` — and `_plain` walks
                # it deeply, so writing it puts exactly the payload here that `WRITTEN` exists to
                # keep out. Nothing read it either: `eventForSpan` maps three types and their listed
                # fields, and `AgentSpan.error` on the reader side is declared and never used. If
                # "this span failed" is ever wanted, whitelist a derived scalar rather than the SDK's
                # object — a field nothing reads is how the payload got in.
                "data": _kept(data, fields),
            }
        )

    def shutdown(self) -> None:
        """Say how many records were lost, if any were.

        `_dropped` was counted from the start and read by nothing, so the two failures `_write`
        deliberately swallows — a payload `json.dumps` will not take, and a file it cannot append
        to — reached the trace as an absence. That is the shape this project keeps finding: a
        capture layer reporting success while something it held is gone. A run that lost a handoff
        should say so, even though it is right that losing one did not end the run.

        Written here rather than per-failure because a count is one line whatever happens, and
        because the alternative — a record per drop — is most likely to be written when writing is
        exactly what is failing.

        Not via `_write`: this must not increment the counter it is reporting, and a serialisation
        failure is impossible for two ints.
        """
        if not self._path or self._dropped == 0:
            return None
        line = json.dumps({"kind": "dropped", "count": self._dropped}, ensure_ascii=False)
        try:
            with self._lock, open(self._path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:  # noqa: BLE001 - reporting a loss must not itself end the run
            return None
        # Only once: the SDK may call `shutdown` more than once, and a second line would be read as
        # a second, separate loss.
        self._dropped = 0
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
