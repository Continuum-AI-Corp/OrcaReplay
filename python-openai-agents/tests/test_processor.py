"""The processor's two obligations: be inert when it should be, and never break the run.

Both are load-bearing rather than defensive. This package is installed by `orca record` into *every*
Python process a recording starts — including `python --version` — so "does nothing" is the common
case and has to be the reliable one.
"""

from __future__ import annotations

import datetime
import json
import time
import os

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


class AgentSpanData(FakeSpanData):
    pass


class FunctionSpanData(FakeSpanData):
    pass


class CustomSpanData(FakeSpanData):
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
    records = read(out)
    assert len(records) == 1
    assert records[0]["type"] == "HandoffSpanData"
    assert records[0]["data"] == {"from_agent": "Triage", "to_agent": "Billing"}


def test_drops_what_the_proxy_already_has(tmp_path):
    # Not an optimisation: the proxy holds these exchanges byte for byte, and a second, lossier copy
    # in the same trace is worse than none.
    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    processor.on_span_end(FakeSpan(ResponseSpanData({"response": "..."})))
    assert not out.exists() or read(out) == []


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

# ── what reaches the file, and what does not ──────────────────────────────────────────────────────
#
# The file is written by the agent's own interpreter, so nothing orca owns can redact it on the way
# in. That leaves one control: do not write it. These pin the allow-list in both directions, because
# a list that let everything through and a list that let nothing through would both have passed the
# suite this replaced.


def _one_record(tmp_path, span, monkeypatch=None):
    path = tmp_path / "spans.jsonl"
    p = OrcaTracingProcessor(str(path))
    p.on_span_end(span)
    if not path.exists():
        return None
    lines = [l for l in path.read_text(encoding="utf-8").splitlines() if l]
    return json.loads(lines[0]) if lines else None


SECRET = "sk-canary0123456789abcdefghijklmn"


@pytest.mark.parametrize("data", [FunctionSpanData, CustomSpanData])
def test_a_span_type_nothing_reads_is_not_written_at_all(tmp_path, data):
    """The reader maps three span types. The other span types carry the payload.

    `FunctionSpanData` holds a tool's input, output and `mcp_data`; `CustomSpanData` holds whatever
    the user put in it. Both used to be written verbatim, and `eventForSpan` threw both away -- so
    the file carried material the trace never kept and nothing could remove.
    """
    span = FakeSpan(data({"name": "run_shell", "output": SECRET, "mcp_data": {"key": SECRET}}))
    assert _one_record(tmp_path, span) is None


def test_an_allowed_span_carries_only_the_fields_the_reader_reads(tmp_path):
    span = FakeSpan(
        AgentSpanData(
            {
                "name": "Triage",
                "handoffs": ["Billing"],
                "tools": ["run_shell"],
                "output_type": "str",
                # Not in the list, so not written -- the SDK is free to add fields and this file is
                # not free to carry them.
                "instructions": SECRET,
            }
        )
    )
    record = _one_record(tmp_path, span)
    assert record is not None
    assert set(record["data"]) == {"name", "handoffs", "tools", "output_type"}
    assert SECRET not in json.dumps(record)


def test_the_error_object_is_never_written(tmp_path):
    """`SpanError.data` is a free-form dict: a tool's input, an API error echoed back.

    Nothing read it -- `AgentSpan.error` is declared on the reader side and never used -- so writing
    it was payload for no reader at all.
    """
    span = FakeSpan(HandoffSpanData({"from_agent": "a", "to_agent": "b"}))
    span.error = {"message": "boom", "data": {"echoed": SECRET}}
    record = _one_record(tmp_path, span)
    assert record is not None
    assert "error" not in record
    assert SECRET not in json.dumps(record)


def test_a_payload_that_will_not_export_costs_the_span_and_not_the_run(tmp_path):
    # Named for an allowed type, or the allow-list would be what dropped it and this would pass
    # without exercising the export guard at all.
    class GuardrailSpanData(FakeSpanData):
        def export(self):
            raise RuntimeError("no")

    record = _one_record(tmp_path, FakeSpan(GuardrailSpanData(None)))
    # Written, because the span type is one the reader wants; empty, because nothing could be read.
    assert record is not None and record["data"] == {}

# ── what one payload may cost ─────────────────────────────────────────────────────────────────────
#
# This runs inside the agent's own process, on the SDK's callback. It used to walk every *path*
# through a payload rather than every node, so shared sub-objects cost 2^n and a reference cycle cost
# everything: `on_span_end` hung with no error and no output, which is the one thing the module's
# docstrings promise cannot happen. Doing nothing would have been safer — `json.dumps` rejects a
# circular reference in microseconds.


def test_a_payload_that_refers_to_itself_is_described_rather_than_followed(tmp_path):
    cycle = {}
    cycle["a"] = cycle
    cycle["b"] = cycle  # branching, which is what made it explode rather than merely recurse
    record = _one_record(
        tmp_path,
        FakeSpan(AgentSpanData({"name": cycle, "handoffs": [], "tools": [], "output_type": "s"})),
    )
    assert record is not None
    assert "<circular>" in json.dumps(record["data"])


def test_a_payload_larger_than_the_budget_is_truncated_rather_than_written(tmp_path):
    # Comfortably past _MAX_NODES, and linear either way, so this is fast whether or not the bound
    # is there — it is the truncation marker that is being asserted, not a stopwatch.
    wide = [{"n": i} for i in range(20_000)]
    record = _one_record(
        tmp_path,
        FakeSpan(AgentSpanData({"name": wide, "handoffs": [], "tools": [], "output_type": "s"})),
    )
    assert record is not None
    assert "<truncated>" in json.dumps(record["data"])


def test_shared_sub_objects_do_not_cost_a_path_each(tmp_path):
    """Forty shared diamonds, no cycle anywhere. This did not return in twenty seconds."""
    node = "leaf"
    for _ in range(40):
        node = {"l": node, "r": node}
    started = time.monotonic()
    record = _one_record(
        tmp_path,
        FakeSpan(AgentSpanData({"name": node, "handoffs": [], "tools": [], "output_type": "s"})),
    )
    elapsed = time.monotonic() - started
    assert record is not None
    # Generous by three orders of magnitude against the 2^40 it was; the claim is the shape of the
    # curve, not a stopwatch.
    assert elapsed < 10, f"describing a shared structure took {elapsed:.1f}s"


def test_an_ordinary_payload_is_still_written_whole(tmp_path):
    payload = {"a": {"b": {"c": [1, 2, {"d": "ok"}]}}}
    record = _one_record(
        tmp_path,
        FakeSpan(AgentSpanData({"name": payload, "handoffs": [], "tools": [], "output_type": "s"})),
    )
    assert record is not None
    assert record["data"]["name"] == payload


def test_a_datetime_timestamp_is_written_as_iso(tmp_path):
    """The reader parses these with `Date.parse`, and the SDK hands over whatever it hands over.

    Every supported version of openai-agents stores `util.time_iso()`, which is already a string,
    so this is not today's behaviour being pinned — it is the failure mode if that ever changes.
    The whole record would fail to serialise, the write path would swallow it, and a run would
    capture no spans at all while `trace.start` and `trace.end` kept landing, so nothing about the
    file would look wrong.

    `str(datetime)` is not the answer either: it puts a space where the `T` belongs. Hence asking
    the value for its own ISO form rather than leaving it to `default=str`.
    """
    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    span = FakeSpan(HandoffSpanData({"from_agent": "Triage", "to_agent": "Billing"}))
    span.started_at = datetime.datetime(
        2026, 9, 10, 3, 46, 3, 483810, tzinfo=datetime.timezone.utc
    )
    span.ended_at = datetime.datetime(2026, 9, 10, 3, 46, 3, 500000, tzinfo=datetime.timezone.utc)

    processor.on_span_end(span)

    records = read(out)
    assert len(records) == 1, "a span whose timestamps are datetimes was dropped entirely"
    assert records[0]["started_at"] == "2026-09-10T03:46:03.483810+00:00"
    assert records[0]["ended_at"] == "2026-09-10T03:46:03.500000+00:00"
    assert processor._dropped == 0


def test_a_value_json_cannot_take_costs_that_field_and_nothing_else(tmp_path):
    """The other half of the same guarantee, for a field that has no ISO form to ask for."""

    class Unserialisable:
        def __repr__(self):
            return "<unserialisable>"

    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    span = FakeSpan(HandoffSpanData({"from_agent": "Triage", "to_agent": "Billing"}))
    span.started_at = Unserialisable()

    processor.on_span_end(span)

    records = read(out)
    assert len(records) == 1, "one unserialisable field took the whole span with it"
    assert records[0]["data"] == {"from_agent": "Triage", "to_agent": "Billing"}
    assert processor._dropped == 0


def test_every_record_begins_with_kind(tmp_path):
    """The CLI's reader anchors its recovery of a torn line on these bytes.

    Every Python process the run starts appends to this file — the lock above is per-process — so a
    short write can leave part of a record with the next process's bytes on the end of it. Getting
    the whole record back out of such a line means finding where one begins, and the only thing on
    the line that can say so is the first key. `json.dumps` keeps insertion order, and every record
    here is built with `kind` first; this is the half of that agreement that lives on this side.
    """
    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    processor.on_trace_start(object())
    processor.on_span_end(FakeSpan(HandoffSpanData({"from_agent": "A", "to_agent": "B"})))
    processor.on_trace_end(object())

    lines = out.read_text(encoding="utf-8").splitlines()
    assert lines, "the processor wrote nothing, so this proves nothing"
    for line in lines:
        assert line.startswith('{"kind":'), line[:24]


# ── saying what was lost ──────────────────────────────────────────────────────────────────────────
#
# `_dropped` was counted from the first version and read by nothing, so the two failures `_write`
# deliberately swallows reached the trace as an absence. Swallowing them is right — a debugger must
# not be able to fail a run — but staying quiet about them is the shape this project keeps finding:
# a capture layer reporting success while something it held is gone.


def _wedge(processor):
    """Cost the processor one record, through the guard that really drops them.

    A non-string key is one of the few things that still defeats `json.dumps` here: `default=` is
    consulted for values and never for keys. Going through `_write` rather than setting the counter
    means the test fails if the guard stops counting.
    """
    processor._write({"kind": "span", (1, 2): "x"})


def test_nothing_lost_says_nothing(tmp_path):
    """The common case, and the one a spurious line would be most annoying in."""
    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    processor.on_span_end(FakeSpan(HandoffSpanData({"from_agent": "Triage", "to_agent": "Billing"})))

    processor.shutdown()

    kinds = [r["kind"] for r in read(out)]
    assert kinds == ["span"], "shutdown invented a loss on a run that had none"


def test_a_record_that_could_not_be_written_is_reported_at_shutdown(tmp_path):
    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))

    _wedge(processor)
    assert processor._dropped == 1
    # Not `read(out) == []`: the file is not there at all, because the only record so far is the
    # one that could not be written.
    assert not out.exists(), "the record that could not be serialised was written anyway"

    processor.shutdown()

    assert read(out) == [{"kind": "dropped", "count": 1}]


def test_every_loss_is_counted_not_just_the_first(tmp_path):
    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    for _ in range(3):
        _wedge(processor)

    processor.shutdown()

    assert read(out) == [{"kind": "dropped", "count": 3}]


def test_shutdown_twice_reports_once(tmp_path):
    """The SDK may call `shutdown` more than once; a second line reads as a second, separate loss."""
    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    _wedge(processor)

    processor.shutdown()
    processor.shutdown()

    assert read(out) == [{"kind": "dropped", "count": 1}]


def test_reporting_a_loss_cannot_itself_end_the_run(tmp_path):
    """The likeliest reason a record was dropped is that this file cannot be written to."""
    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    _wedge(processor)
    # A directory where the file should be: every append fails, including shutdown's own.
    (tmp_path / "wedged").mkdir()
    processor._path = str(tmp_path / "wedged")

    processor.shutdown()  # must return, not raise


def test_an_inert_processor_writes_no_dropped_line(tmp_path, monkeypatch):
    """Nothing is being recorded, so there is no file to report a loss into."""
    monkeypatch.delenv(SPANS_ENV, raising=False)
    processor = OrcaTracingProcessor()
    assert not processor.active

    processor.shutdown()  # must return, not raise

    assert list(tmp_path.iterdir()) == []


def test_the_dropped_record_begins_with_kind_like_every_other(tmp_path):
    """The CLI anchors its recovery of a torn line on these bytes. This record is not exempt."""
    out = tmp_path / "spans.jsonl"
    processor = OrcaTracingProcessor(str(out))
    _wedge(processor)
    processor.shutdown()

    with open(out, encoding="utf-8") as f:
        assert f.read().startswith('{"kind": "dropped"')
