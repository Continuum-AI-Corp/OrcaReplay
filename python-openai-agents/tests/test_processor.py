"""The processor's two obligations: be inert when it should be, and never break the run.

Both are load-bearing rather than defensive. This package is installed by `orca record` into *every*
Python process a recording starts — including `python --version` — so "does nothing" is the common
case and has to be the reliable one.
"""

from __future__ import annotations

import json
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
    assert read(out)[0]["data"] == {}


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
    assert read(out)[0]["started_at"] is None
    assert read(out)[0]["data"] == {"from_agent": "A", "to_agent": "B"}


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
    assert not out.exists() or read(out) == []


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
    assert read(out)[0]["data"] == {
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
