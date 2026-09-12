"""The processor's two obligations: be inert when it should be, and never break the run.

Both are load-bearing rather than defensive. This package is installed by `orca record` into *every*
Python process a recording starts — including `python --version` — so "does nothing" is the common
case and has to be the reliable one.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from orcareplay_openai_agents import KEEP_ENV, SPANS_ENV, OrcaTracingProcessor, install


class FakeSpanData:
    def __init__(self, payload):
        self._payload = payload

    def export(self):
        return self._payload


class HandoffSpanData(FakeSpanData):
    """Named to match the SDK's class, because the processor keys off the class name."""


class ResponseSpanData(FakeSpanData):
    pass


class FakeSpan:
    def __init__(self, data):
        self.span_data = data
        self.span_id = "span_1"
        self.parent_id = None
        self.trace_id = "trace_1"
        self.started_at = "2026-09-10T03:46:03.483810+00:00"
        self.ended_at = "2026-09-10T03:46:03.500000+00:00"
        self.error = None


def read(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def spans_of(processor):
    """What this processor wrote.

    Not the path handed to it: one file per process, so the name carries a pid suffix. The tests
    ask the processor where it wrote rather than recomputing the rule, which is the only way they
    keep testing the behaviour instead of restating it.
    """
    return read(processor._path)


def test_inert_without_the_environment_variable(monkeypatch, tmp_path):
    monkeypatch.delenv(SPANS_ENV, raising=False)
    processor = OrcaTracingProcessor()
    assert processor.active is False
    # And writing must be a no-op rather than an error: the SDK calls these unconditionally.
    processor.on_span_end(FakeSpan(HandoffSpanData({"from_agent": "A", "to_agent": "B"})))
    assert not list(tmp_path.iterdir())


def test_install_is_false_and_quiet_when_not_recording(monkeypatch):
    monkeypatch.delenv(SPANS_ENV, raising=False)
    assert install() is False


def test_writes_a_handoff(tmp_path):
    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    processor.on_span_end(FakeSpan(HandoffSpanData({"from_agent": "Triage", "to_agent": "Billing"})))
    records = spans_of(processor)
    assert len(records) == 1
    assert records[0]["type"] == "HandoffSpanData"
    assert records[0]["data"] == {"from_agent": "Triage", "to_agent": "Billing"}


def test_drops_what_the_proxy_already_has(tmp_path):
    # Not an optimisation: the proxy holds these exchanges byte for byte, and a second, lossier copy
    # in the same trace is worse than none.
    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    processor.on_span_end(FakeSpan(ResponseSpanData({"response": "..."})))
    assert not Path(processor._path).exists() or spans_of(processor) == []


def test_a_span_that_will_not_serialise_does_not_raise(tmp_path):
    class Hostile:
        def __repr__(self):
            raise RuntimeError("even repr fails")

    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    # Must not propagate. The SDK calls this from inside the run; an exception here would surface as
    # the agent failing, which is the one thing a debugging aid must never cause.
    processor.on_span_end(FakeSpan(HandoffSpanData({"bad": Hostile()})))


def test_an_unwritable_path_does_not_raise(tmp_path):
    processor = OrcaTracingProcessor(str(tmp_path / "no-such-dir" / "spans.jsonl"))
    processor.on_span_end(FakeSpan(HandoffSpanData({"from_agent": "A", "to_agent": "B"})))


def test_an_export_that_raises_does_not_reach_the_agent(tmp_path):
    # The `repr` case above guards what `_plain` is *handed*. This is the raise that happens while
    # the argument is still being built, which that guard never saw: `CustomSpanData.export()`
    # JSON-encodes the user's payload and raises on a circular reference. The SDK calls
    # `on_span_end` synchronously from `Span.finish()`, so an escape surfaces as the user's own
    # `Runner.run()` failing — the debugger ending the run it was watching.
    class Exploding(FakeSpanData):
        def export(self):
            raise ValueError("Circular reference detected")

    Exploding.__name__ = "AgentSpanData"
    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    processor.on_span_end(FakeSpan(Exploding(None)))
    assert spans_of(processor)[0]["data"] == {}


def test_a_property_that_raises_does_not_reach_the_agent(tmp_path):
    # Same shape one field over. Every `getattr` here reads something the SDK is entitled to make a
    # property, and a property is user code.
    class Sneaky:
        span_id = "span_1"
        parent_id = None
        trace_id = "trace_1"
        ended_at = None
        error = None
        span_data = HandoffSpanData({"from_agent": "A", "to_agent": "B"})

        @property
        def started_at(self):
            raise RuntimeError("a raising property")

    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    processor.on_span_end(Sneaky())
    assert spans_of(processor)[0]["started_at"] is None
    assert spans_of(processor)[0]["data"] == {"from_agent": "A", "to_agent": "B"}


def test_a_tool_call_carrying_a_credential_is_not_written(tmp_path):
    # The rule this file lives under: "If you add a new sink, it goes through the redactor." There
    # is no redactor in Python and there must not be a second one, so nothing a user put in a span
    # may be written at all. `FunctionSpanData.export()` is `{name, input, output}` — the tool's
    # arguments and its result, which is where an Authorization header lives. The same bytes are
    # scrubbed in `events.jsonl`, and `orca scrub` does not rewrite this file.
    class FunctionSpanData(FakeSpanData):
        pass

    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    processor.on_span_end(
        FakeSpan(
            FunctionSpanData(
                {
                    "name": "http_get",
                    "input": {"headers": {"Authorization": "Bearer sk-abcdefghijklmnop12345"}},
                    "output": "ok",
                }
            )
        )
    )
    assert not Path(processor._path).exists() or spans_of(processor) == []


def test_only_the_fields_the_reader_maps_are_kept(tmp_path):
    # A whitelist, so a field the SDK adds later is not written until someone lists it here. The one
    # below is real: `instructions` is the agent's system prompt.
    class AgentSpanData(FakeSpanData):
        pass

    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    processor.on_span_end(
        FakeSpan(
            AgentSpanData(
                {
                    "name": "triage",
                    "handoffs": ["billing"],
                    "tools": ["lookup"],
                    "output_type": "str",
                    "instructions": "you are a helpful assistant with SECRET-PROMPT",
                }
            )
        )
    )
    assert spans_of(processor)[0]["data"] == {
        "name": "triage",
        "handoffs": ["billing"],
        "tools": ["lookup"],
        "output_type": "str",
    }


@pytest.mark.skipif(
    os.environ.get("ORCA_SKIP_SDK_TESTS") == "1", reason="asked to skip SDK-dependent tests"
)
def test_install_replaces_the_default_exporter(monkeypatch, tmp_path):
    """The reason `install` replaces rather than appends.

    It runs before the user's first statement, when the only registered processor is the SDK's own
    exporter to OpenAI. Leaving that in place would mean a second egress out of every recorded run.
    """
    agents = pytest.importorskip("agents")
    monkeypatch.setenv(SPANS_ENV, str(tmp_path / "spans.jsonl"))
    monkeypatch.delenv(KEEP_ENV, raising=False)

    installed: list = []
    monkeypatch.setattr(agents, "set_trace_processors", lambda ps: installed.append(("set", ps)))
    monkeypatch.setattr(agents, "add_trace_processor", lambda p: installed.append(("add", p)))

    assert install() is True
    assert installed and installed[0][0] == "set"


@pytest.mark.skipif(
    os.environ.get("ORCA_SKIP_SDK_TESTS") == "1", reason="asked to skip SDK-dependent tests"
)
def test_keep_export_appends_instead(monkeypatch, tmp_path):
    agents = pytest.importorskip("agents")
    monkeypatch.setenv(SPANS_ENV, str(tmp_path / "spans.jsonl"))
    monkeypatch.setenv(KEEP_ENV, "1")

    installed: list = []
    monkeypatch.setattr(agents, "set_trace_processors", lambda ps: installed.append(("set", ps)))
    monkeypatch.setattr(agents, "add_trace_processor", lambda p: installed.append(("add", p)))

    assert install() is True
    assert installed and installed[0][0] == "add"


def test_one_file_per_process(tmp_path):
    # The whole environment is inherited by everything the agent starts, so an agent that shells out
    # to `python`, or runs `pytest -n` or a worker pool, has several processes tracing at once.
    # `threading.Lock` serialises none of them, and Windows implements append as seek-then-write.
    base = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(base))
    processor.on_span_end(FakeSpan(HandoffSpanData({"from_agent": "A", "to_agent": "B"})))
    processor.shutdown()
    assert not base.exists()
    written = list(tmp_path.glob("spans.jsonl.*"))
    assert [p.name for p in written] == [f"spans.jsonl.{os.getpid()}"]


def test_a_short_write_cannot_swallow_the_next_record(tmp_path):
    # The loss worth preventing is the *second* one. A write that stops part-way leaves the file
    # mid-record; appended straight on, the next record glues to that fragment, and the reader —
    # which skips any line that does not parse — loses both: the torn one, and the intact one whose
    # bytes were fine. One leading newline separates them.
    #
    # A partial write is what has to be simulated, not a failed one: a write that lands nothing
    # leaves the file ending in a clean newline, where the next record is safe either way.
    processor = OrcaTracingProcessor(str(tmp_path / "spans.jsonl"))
    processor.on_span_end(FakeSpan(HandoffSpanData({"from_agent": "A", "to_agent": "B"})))
    os.write(processor._fd, b'{"kind":"span","type":"HandoffSpa')  # cut off mid-record
    processor._torn = True
    processor._dropped = 1

    processor.on_span_end(FakeSpan(HandoffSpanData({"from_agent": "C", "to_agent": "D"})))
    processor.shutdown()

    text = Path(processor._path).read_text(encoding="utf-8")
    lines = [line for line in text.split("\n") if line.strip()]
    unparseable = 0
    records = []
    for line in lines:
        try:
            records.append(json.loads(line))
        except ValueError:
            unparseable += 1
    assert unparseable == 1, "only the fragment itself should be unreadable"
    kept = [r["data"]["from_agent"] for r in records if r["kind"] == "span"]
    assert kept == ["A", "C"], "the record after a torn one must survive"


def test_it_says_how_many_it_lost(tmp_path):
    # The count used to be kept and never read by anything, which is what makes a loss silent: orca
    # deletes this file as soon as it has ingested it, so a note here is the only chance to mention
    # it. `kind` is not "span", so a reader that does not know the record skips it.
    processor = OrcaTracingProcessor(str(tmp_path / "spans.jsonl"))
    processor.on_span_end(FakeSpan(HandoffSpanData({"from_agent": "A", "to_agent": "B"})))
    os.close(processor._fd)
    processor.on_span_end(FakeSpan(HandoffSpanData({"from_agent": "LOST", "to_agent": "X"})))
    processor._fd = None
    processor.shutdown()
    assert {"kind": "dropped", "count": 1} in spans_of(processor)


def test_it_says_nothing_when_it_lost_nothing(tmp_path):
    processor = OrcaTracingProcessor(str(tmp_path / "spans.jsonl"))
    processor.on_span_end(FakeSpan(HandoffSpanData({"from_agent": "A", "to_agent": "B"})))
    processor.shutdown()
    assert [r for r in spans_of(processor) if r["kind"] == "dropped"] == []


def test_a_span_error_payload_is_not_written(tmp_path):
    # `SpanError.data` is free-form: a tool's input, an API error echoed back, a guardrail's
    # `output_info`. It was written verbatim while every other non-whitelisted field was dropped,
    # which is the one hole the whitelist above is supposed to have closed. Nothing read it.
    class Failing(FakeSpan):
        pass

    span = FakeSpan(HandoffSpanData({"from_agent": "A", "to_agent": "B"}))
    span.error = {
        "message": "tool call failed",
        "data": {"headers": {"Authorization": "Bearer sk-abcdefghijklmnop12345"}},
    }
    processor = OrcaTracingProcessor(str(tmp_path / "spans.jsonl"))
    processor.on_span_end(span)
    processor.shutdown()

    text = Path(processor._path).read_text(encoding="utf-8")
    assert "sk-abcdefghijklmnop12345" not in text
    assert "tool call failed" not in text
    record = spans_of(processor)[0]
    assert record["failed"] is True, "that it failed is worth keeping; what it said is not"
    assert "error" not in record


def test_a_name_that_will_not_encode_does_not_reach_the_agent(tmp_path):
    # `json.dumps(..., ensure_ascii=False)` copies a lone surrogate through unchanged and CPython
    # refuses to encode one, so encoding is a second way a record can fail to serialise — and the
    # kept fields are names the agent's author chose, where a non-UTF-8 byte read through
    # `surrogateescape` lands unchanged. The buffered writer this replaced encoded inside the guard.
    processor = OrcaTracingProcessor(str(tmp_path / "spans.jsonl"))
    processor.on_span_end(
        FakeSpan(HandoffSpanData({"from_agent": "agent-\ud800-name", "to_agent": "B"}))
    )
    assert processor._dropped == 1

    # And the next record still lands: a drop is one span, not the rest of the run.
    processor.on_span_end(FakeSpan(HandoffSpanData({"from_agent": "A", "to_agent": "B"})))
    processor.shutdown()
    kept = [r for r in spans_of(processor) if r["kind"] == "span"]
    assert [r["data"]["from_agent"] for r in kept] == ["A"]


def test_two_threads_cannot_glue_a_record_onto_a_torn_one(tmp_path, monkeypatch):
    # `_torn` describes the file, so it has to be read where the file is written. Read before the
    # lock is taken, the answer can be stale: both threads build a payload with no leading newline,
    # the first tears, and the second glues its intact record onto the fragment — losing both, which
    # is the loss the newline exists to prevent.
    #
    # Made deterministic rather than raced: a barrier at the serialise point puts both threads past
    # it before either can take the lock, which is exactly the interleaving at issue.
    import json as json_module
    import threading

    from orcareplay_openai_agents import processor as mod

    gate = threading.Barrier(2, timeout=10)
    real_dumps = json_module.dumps

    def dumps_at_the_gate(*args, **kwargs):
        line = real_dumps(*args, **kwargs)
        gate.wait()
        return line

    monkeypatch.setattr(mod.json, "dumps", dumps_at_the_gate)

    # The first write to land is short; the rest go through.
    real_write = os.write
    first = threading.Lock()
    torn_once = []

    def short_first(fd, data):
        with first:
            tear = not torn_once
            if tear:
                torn_once.append(True)
        if tear:
            return real_write(fd, data[: len(data) // 2])
        return real_write(fd, data)

    monkeypatch.setattr(mod.os, "write", short_first)

    processor = OrcaTracingProcessor(str(tmp_path / "spans.jsonl"))
    threads = [
        threading.Thread(
            target=processor.on_span_end,
            args=(FakeSpan(HandoffSpanData({"from_agent": name, "to_agent": "B"})),),
        )
        for name in ("A", "C")
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)

    monkeypatch.undo()
    text = Path(processor._path).read_text(encoding="utf-8")
    survived = []
    for chunk in text.split("\n"):
        if not chunk.strip():
            continue
        try:
            survived.append(json_module.loads(chunk))
        except ValueError:
            pass
    kept = sorted(r["data"]["from_agent"] for r in survived if r.get("kind") == "span")
    assert len(kept) == 1, f"the record written after the tear must survive, got {kept}"


def test_a_raising_trace_attribute_does_not_reach_the_agent(tmp_path):
    # The same rule as the span hooks, on the other half of the same interface. `on_trace_start` and
    # `on_trace_end` are called synchronously from trace start and `Trace.finish()` inside
    # `Runner.run()`, so an escape here is the user's own run failing — and the SDK wraps `Trace` in
    # properties, which is exactly what `_read` exists for.
    class RaisingName:
        trace_id = "t1"

        @property
        def name(self):
            raise RuntimeError("a raising property")

    class RaisingId:
        name = "w"

        @property
        def trace_id(self):
            raise RuntimeError("a raising property")

    processor = OrcaTracingProcessor(str(tmp_path / "spans.jsonl"))
    processor.on_trace_start(RaisingName())
    processor.on_trace_end(RaisingId())
    processor.shutdown()

    records = spans_of(processor)
    assert [r["kind"] for r in records] == ["trace.start", "trace.end"]
    assert records[0]["name"] is None, "what it could not read becomes None, not an exception"
    assert records[1]["trace_id"] is None


def test_a_datetime_timestamp_does_not_take_the_record_with_it(tmp_path):
    # Not what this SDK does: `SpanImpl.start` sets `util.time_iso()`, a string, and its own
    # `export()` passes it through without conversion. This is about what happens if that changes.
    #
    # Measured before the guard: `json.dumps` refuses a `datetime`, the whole *record* is dropped —
    # not the field — and the file holds nothing but the `dropped` count. Every `agent.start`,
    # `agent.handoff` and `agent.guardrail` would vanish from every trace with one warning to show
    # for it, which is a total and silent failure of the layer the package exists to provide.
    from datetime import datetime, timezone

    when = datetime(2026, 9, 12, 20, 46, 53, tzinfo=timezone.utc)

    class Stamped(FakeSpan):
        pass

    span = FakeSpan(HandoffSpanData({"from_agent": "A", "to_agent": "B"}))
    span.started_at = when
    processor = OrcaTracingProcessor(str(tmp_path / "spans.jsonl"))
    processor.on_span_end(span)
    processor.shutdown()

    records = spans_of(processor)
    kept = [r for r in records if r["kind"] == "span"]
    assert len(kept) == 1, "the record must survive a timestamp it cannot serialise"
    assert kept[0]["started_at"] == when.isoformat()
    assert kept[0]["data"] == {"from_agent": "A", "to_agent": "B"}
    assert [r for r in records if r["kind"] == "dropped"] == []


def test_an_unserialisable_envelope_field_costs_that_field_only(tmp_path):
    # The envelope is built from `_read`, so its values are whatever the SDK's attributes hold. One
    # of them being unserialisable should cost the field, never the record — and the placeholder is
    # a constant rather than a `repr`, because this half has no whitelist in front of it.
    class Opaque:
        def __repr__(self):
            return "SECRET-IN-REPR"

    span = FakeSpan(HandoffSpanData({"from_agent": "A", "to_agent": "B"}))
    span.span_id = Opaque()
    processor = OrcaTracingProcessor(str(tmp_path / "spans.jsonl"))
    processor.on_span_end(span)
    processor.shutdown()

    record = spans_of(processor)[0]
    assert record["kind"] == "span"
    assert record["span_id"] == "<unserialisable>"
    assert "SECRET-IN-REPR" not in Path(processor._path).read_text(encoding="utf-8")
    assert record["data"] == {"from_agent": "A", "to_agent": "B"}
