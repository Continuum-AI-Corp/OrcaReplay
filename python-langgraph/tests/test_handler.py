"""The handler's three obligations: report only nodes, be inert when it should be, never raise.

All three are load-bearing rather than defensive. `orca record` installs this into *every* Python
process a recording starts, so "does nothing" is the common case and has to be the reliable one;
and a callback that raises takes the user's graph down with it, which is the one thing a debugging
aid must never do.

These tests drive the handler directly with the kwargs langchain-core passes, rather than through a
graph. The shapes they use are not invented: they are what a real `StateGraph` produced under a
probe, and `test_integration.py` is what keeps them honest against the installed version.
"""

from __future__ import annotations

import json
import os
import uuid

import pytest

from orcareplay_langgraph import PACKAGE, SPAN_END, SPAN_START, SPANS_ENV, OrcaCallbackHandler
from orcareplay_langgraph.handler import MAX_OPEN, TRANSPORT, report_losses


@pytest.fixture
def spans(tmp_path, monkeypatch):
    """A transport orca would have handed us, reset around every test."""
    path = tmp_path / "agent-spans.jsonl"
    monkeypatch.setenv(SPANS_ENV, str(path))
    TRANSPORT.reset()
    yield path
    TRANSPORT.reset()


def records(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


#: Distinct from `None`, which is a `name` a test may want to pass deliberately.
SAME = object()


def start(handler, node, *, name=SAME, step=1, run_id=None, parent=None, extra=None):
    """One `on_chain_start`, shaped the way langchain-core shapes it.

    `name` defaults to `node` — the case that should be reported. Passing them apart is how the
    tests express an inner runnable, a conditional edge or a subgraph.
    """
    run_id = run_id or uuid.uuid4()
    metadata = {"langgraph_step": step, "thread_id": "1"}
    if node is not None:
        metadata["langgraph_node"] = node
    metadata.update(extra or {})
    handler.on_chain_start(
        {"name": "whatever"},
        {"state": "in"},
        run_id=run_id,
        parent_run_id=parent,
        tags=["graph:step:1"],
        metadata=metadata,
        name=node if name is SAME else name,
    )
    return run_id


# -- the discriminator ---------------------------------------------------------------------------
def test_reports_a_node(spans):
    handler = OrcaCallbackHandler()
    run_id = start(handler, "validate_only", step=2)

    (record,) = records(spans)
    assert record["kind"] == "span"
    assert record["type"] == SPAN_START
    assert record["span_id"] == str(run_id)
    assert record["data"] == {"node": "validate_only", "step": 2}
    assert record["started_at"].endswith("+00:00")


@pytest.mark.parametrize(
    ("node", "name", "why"),
    [
        ("first", "INNER-RUNNABLE", "a runnable inside a node inherits langgraph_node"),
        ("validate_only", "router", "a conditional edge inherits the node it left"),
        (None, "probe_graph", "the graph itself has no langgraph_node"),
        ("first", None, "no name at all"),
        ("__start__", "__start__", "LangGraph's own entry marker is not a node anyone wrote"),
        ("__end__", "__end__", "nor its exit marker"),
    ],
)
def test_reports_nothing_else(spans, node, name, why):
    start(OrcaCallbackHandler(), node, name=name)
    assert records(spans) == [], why


def test_a_run_name_cannot_reach_the_transport(spans):
    """The safety property the discriminator buys, stated as a test.

    `.with_config({"run_name": ...})` puts caller-controlled text in `name`. It is only ever
    compared against the author-written node name, so an interpolated secret is a mismatch and a
    mismatch is a drop.
    """
    start(OrcaCallbackHandler(), "lookup", name="lookup for ada@example.com (sk-live-abcd1234)")
    assert records(spans) == []


def test_step_must_be_an_int(spans):
    """A step that is not an int is written as null rather than passed through.

    `isinstance(True, int)` is true, so a bool would otherwise arrive as 1 and read as superstep 1.
    """
    start(OrcaCallbackHandler(), "n", step="2")
    start(OrcaCallbackHandler(), "n", step=True)
    start(OrcaCallbackHandler(), "n", step=0)
    assert [r["data"]["step"] for r in records(spans)] == [None, None, 0]


def test_metadata_that_is_not_a_dict(spans):
    handler = OrcaCallbackHandler()
    handler.on_chain_start({}, {}, run_id=uuid.uuid4(), metadata="not a dict", name="first")
    handler.on_chain_start({}, {}, run_id=uuid.uuid4(), metadata=None, name="first")
    assert records(spans) == []


# -- pairing a start with an end -----------------------------------------------------------------
def test_end_carries_the_node_it_was_told_about(spans):
    """`on_chain_end` gets no metadata, so the node name can only come from the remembered start."""
    handler = OrcaCallbackHandler()
    run_id = start(handler, "second", step=3)
    handler.on_chain_end({"state": "out"}, run_id=run_id)

    _, end = records(spans)
    assert end["type"] == SPAN_END
    assert end["span_id"] == str(run_id)
    assert end["data"] == {"node": "second", "step": 3}
    assert "error" not in end["data"]
    assert "started_at" not in end


def test_end_for_something_never_reported_writes_nothing(spans):
    """The stand-in for the discriminator, which cannot run on an end.

    Every inner runnable and conditional edge also ends, and each one arrives here indistinguishable
    from a node's end except that its start was never remembered.
    """
    OrcaCallbackHandler().on_chain_end({}, run_id=uuid.uuid4())
    assert records(spans) == []


def test_an_end_is_written_once(spans):
    handler = OrcaCallbackHandler()
    run_id = start(handler, "first")
    handler.on_chain_end({}, run_id=run_id)
    handler.on_chain_end({}, run_id=run_id)
    assert [r["type"] for r in records(spans)] == [SPAN_START, SPAN_END]


def test_error_records_the_class_and_not_the_message(spans):
    handler = OrcaCallbackHandler()
    run_id = start(handler, "lookup")
    handler.on_chain_error(ValueError("no row for ada@example.com, token sk-live-abcd1234"), run_id=run_id)

    _, end = records(spans)
    assert end["data"]["error"] == "ValueError"
    assert "ada@example.com" not in json.dumps(end)
    assert "sk-live" not in json.dumps(end)


def test_instances_share_state(spans):
    """Started by one instance, ended by another — because langchain-core makes several.

    Measured: one `invoke()` constructs the handler class twice. If the open map were per instance,
    the end would arrive at a handler that had never seen the start and be dropped.
    """
    run_id = start(OrcaCallbackHandler(), "first")
    OrcaCallbackHandler().on_chain_end({}, run_id=run_id)
    assert [r["type"] for r in records(spans)] == [SPAN_START, SPAN_END]


def test_parallel_nodes_are_distinguishable(spans):
    """Two workers in one superstep: same step, same parent, different run ids.

    This is the row the proxy cannot answer — two model calls in one superstep look exactly like
    two turns on the wire.
    """
    parent = uuid.uuid4()
    handler = OrcaCallbackHandler()
    a = start(handler, "worker", step=1, parent=parent)
    b = start(handler, "worker", step=1, parent=parent)

    first, second = records(spans)
    assert first["data"] == second["data"] == {"node": "worker", "step": 1}
    assert first["parent_id"] == second["parent_id"] == str(parent)
    assert first["span_id"] != second["span_id"]
    assert {first["span_id"], second["span_id"]} == {str(a), str(b)}


def test_parent_is_null_when_there_is_none(spans):
    start(OrcaCallbackHandler(), "first", parent=None)
    assert records(spans)[0]["parent_id"] is None


# -- being inert ---------------------------------------------------------------------------------
def test_writes_nothing_without_the_variable(tmp_path, monkeypatch):
    monkeypatch.delenv(SPANS_ENV, raising=False)
    TRANSPORT.reset()
    handler = OrcaCallbackHandler()
    run_id = start(handler, "first")
    handler.on_chain_end({}, run_id=run_id)
    assert list(tmp_path.iterdir()) == []


def test_an_empty_variable_is_the_same_as_none(tmp_path, monkeypatch):
    """Not merely "writes nothing": it must not look like a loss either.

    Without the `or None`, an empty value is a path, `open("")` raises, and the failure is counted
    as a dropped record. The run would then report that capture lost something when there was
    nothing to capture and orca was not recording at all — the sort of false alarm that teaches
    people to ignore the real ones.
    """
    monkeypatch.setenv(SPANS_ENV, "")
    TRANSPORT.reset()
    handler = OrcaCallbackHandler()
    run_id = start(handler, "first")
    handler.on_chain_end({}, run_id=run_id)
    assert list(tmp_path.iterdir()) == []
    assert TRANSPORT.dropped == 0, "an absent transport is not a loss"


def test_the_variable_is_read_per_write(spans, tmp_path, monkeypatch):
    """Not cached at import: this module is imported during interpreter startup.

    A path captured then would be whatever the parent happened to have exported, which for a nested
    `orca record` is the outer run's transport.
    """
    handler = OrcaCallbackHandler()
    start(handler, "first")
    moved = tmp_path / "moved.jsonl"
    monkeypatch.setenv(SPANS_ENV, str(moved))
    start(handler, "second")

    assert [r["data"]["node"] for r in records(spans)] == ["first"]
    assert [r["data"]["node"] for r in records(moved)] == ["second"]


def test_constructing_the_handler_touches_nothing(tmp_path, monkeypatch):
    """`_configure` constructs one on every configure call, unguarded, and usually discards it.

    Measured: a handler whose `__init__` raised made an ordinary `app.invoke()` raise the same
    exception. So `__init__` must not read the environment, join a path, or open a file.
    """
    monkeypatch.setenv(SPANS_ENV, str(tmp_path / "nested" / "does-not-exist.jsonl"))
    for _ in range(100):
        OrcaCallbackHandler()
    assert list(tmp_path.iterdir()) == []


def test_the_handler_declines_the_callbacks_it_does_not_implement():
    handler = OrcaCallbackHandler()
    assert handler.run_inline is True
    assert handler.raise_error is False
    assert handler.ignore_chain is False, "chain callbacks are the only ones this wants"
    for attr in (
        "ignore_llm",
        "ignore_chat_model",
        "ignore_retriever",
        "ignore_agent",
        "ignore_retry",
        "ignore_custom_event",
    ):
        assert getattr(handler, attr) is True, attr


# -- never raising -------------------------------------------------------------------------------
def test_an_unwritable_path_is_counted_not_raised(tmp_path, monkeypatch):
    monkeypatch.setenv(SPANS_ENV, str(tmp_path / "no" / "such" / "dir" / "spans.jsonl"))
    TRANSPORT.reset()
    handler = OrcaCallbackHandler()
    run_id = start(handler, "first")
    handler.on_chain_end({}, run_id=run_id)
    assert TRANSPORT.dropped == 2
    TRANSPORT.reset()


def test_a_node_name_that_will_not_serialise_is_counted_not_raised(spans):
    class Unserialisable:
        def __str__(self):
            raise RuntimeError("not even str() works")

        def __eq__(self, other):
            return True  # equal to the `name` kwarg, so it passes the discriminator

        __hash__ = None

    handler = OrcaCallbackHandler()
    handler.on_chain_start(
        {}, {}, run_id=uuid.uuid4(), metadata={"langgraph_node": Unserialisable()}, name="x"
    )
    assert records(spans) == []
    assert TRANSPORT.dropped == 0  # it never reached the write; str() raised first


def test_the_open_map_has_a_ceiling(spans):
    handler = OrcaCallbackHandler()
    kept = [start(handler, "n", run_id=uuid.uuid4()) for _ in range(MAX_OPEN)]
    assert TRANSPORT.reported == MAX_OPEN

    over = start(handler, "n")
    handler.on_chain_end({}, run_id=over)
    assert TRANSPORT.dropped == 1
    assert TRANSPORT.reported == MAX_OPEN

    written = records(spans)
    assert len(written) == MAX_OPEN, "the start over the ceiling is refused, not written"
    handler.on_chain_end({}, run_id=kept[0])
    assert len(records(spans)) == MAX_OPEN + 1, "a remembered node still closes"


# -- what was lost -------------------------------------------------------------------------------
def test_losses_says_nothing_when_nothing_was_lost(spans):
    handler = OrcaCallbackHandler()
    run_id = start(handler, "first")
    handler.on_chain_end({}, run_id=run_id)
    report_losses()
    assert [r["type"] for r in records(spans)] == [SPAN_START, SPAN_END]


def test_losses_counts_a_node_that_never_closed(spans):
    start(OrcaCallbackHandler(), "first")
    report_losses()
    loss = records(spans)[-1]
    assert loss == {"kind": "dropped", "count": 1, "package": PACKAGE}


def test_losses_names_this_package(spans):
    """Two adapters share one transport file, so a count that does not say whose is unactionable."""
    start(OrcaCallbackHandler(), "first")
    report_losses()
    assert records(spans)[-1]["package"] == "orcareplay-langgraph"


# -- the shape the reader depends on ---------------------------------------------------------------
def test_kind_is_the_first_key(spans):
    """`readAgentSpans` recovers a torn line by searching for `{"kind":`.

    Every Python process in a recording appends to one file, so a short write leaves a fragment with
    the next process's bytes on the end of it. That recovery only works while `kind` is written
    first, which is a property of this file rather than of JSON.
    """
    handler = OrcaCallbackHandler()
    run_id = start(handler, "first")
    handler.on_chain_end({}, run_id=run_id)
    report_losses()
    TRANSPORT.reset()
    start(handler, "orphan")
    report_losses()

    for line in spans.read_text(encoding="utf-8").splitlines():
        assert line.startswith('{"kind": '), line


def test_every_line_is_one_json_object(spans):
    handler = OrcaCallbackHandler()
    for i in range(20):
        run_id = start(handler, f"n{i}")
        handler.on_chain_end({}, run_id=run_id)
    text = spans.read_text(encoding="utf-8")
    assert text.endswith("\n")
    assert len(records(spans)) == 40
