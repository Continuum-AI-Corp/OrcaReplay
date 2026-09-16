"""A LangChain callback handler that records which LangGraph node did what.

## What this is for, and what it is not for

orca records model traffic at a proxy, and every claim it makes about capture comes from there.
This package is not needed for that: a LangGraph run recorded without it is complete in the sense
the rest of the project means. What it adds is the part a proxy structurally cannot see.

The wire carries the conversation and not the graph. Searching a recorded three-node run for the
node names, the graph's name, `langgraph_node` and `langgraph_step` finds none of them in any
request:

| the trace can answer                                      | without | with |
|-----------------------------------------------------------|---------|------|
| which nodes ran, and in which superstep                    | no      | yes  |
| that a node ran at all, when it called no model            | no      | yes  |
| that two calls were one parallel superstep, not two turns  | no      | yes  |
| when each node began and ended                             | no      | yes  |

The second row is the common shape rather than an edge case -- validators, state reducers, routers
and writers make no model call, so a proxy sees a graph with those nodes and a graph without them
as the same run.

**What this does not do is attribute a model call to a node by timestamp alone**, and the reason is
on orca's side rather than here. A node record carries the instant the callback fired -- measured
against the agent's own clock, exactly: node start 54.843 against `invoke` at 54.843. A
`model.request` is stamped when orca *persists* it, which is after the response and after a
workspace snapshot: measured 95 ms late on one call and 31 ms on the next, enough to put a call
just outside the node that blocked on it. So the node boundaries are trustworthy, and a call within
about a tenth of a second of one can fall on the wrong side.

## The discriminator, which is the whole design

`on_chain_start` fires for everything a graph runs, and at that moment a node, a runnable *inside*
a node, a subgraph and a conditional-edge function all look alike: same inherited
`langgraph_node`, same `langgraph_step`, and an arbitrary `name`. Reporting on `name` alone reports
all four. Measured on one graph: `name='INNER-RUNNABLE'` carrying `langgraph_node='first'`,
`name='router'` carrying `langgraph_node='validate_only'`, and `name='probe_graph'` carrying no
`langgraph_node` at all.

So a node is reported only when the `name` kwarg **equals** `metadata['langgraph_node']` --
compared, never copied. That rule has a second effect worth stating, because it is what keeps this
file safe: `langgraph_node` is the name the graph's author wrote in `add_node(...)`, while `name`
is whatever the caller supplied, including a `run_name` interpolated from a user record. The two
are equal only for an author-defined node, so a runtime string cannot reach the transport here.
"""

from __future__ import annotations

import datetime
import json
import os
import threading
from typing import Any

# The path orca hands us. Absent means orca is not recording this run, and then this package does
# nothing at all -- which is what makes it safe to leave installed.
SPANS_ENV = "ORCA_AGENT_SPANS"

#: The name orca reports when this adapter is the one that lost something.
PACKAGE = "orcareplay-langgraph"

#: The two record types, named the way the reader switches on them.
SPAN_START = "LangGraphNodeStart"
SPAN_END = "LangGraphNodeEnd"

#: LangGraph's own entry and exit markers. They are reported exactly like a node -- measured,
#: `__start__` arrives with `langgraph_step` 0 -- and they are not nodes anyone wrote.
SYNTHETIC = frozenset({"__start__", "__end__"})

#: A ceiling on how many node starts may be open at once.
#:
#: The open map exists to pair an end with a start, since `on_chain_end` receives **no metadata** --
#: measured, its `kwargs` are empty -- so the discriminator cannot run there and the run id is the
#: only link. Entries are removed on end or error, so the map is bounded by concurrent nodes in any
#: ordinary graph. This bounds the other case: a long-lived process in which nodes stop closing.
#: Over the ceiling the start is still written and the end is not, which loses a pairing rather
#: than growing without limit -- and `dropped` says it happened.
MAX_OPEN = 10_000


class _Transport:
    """One file per process, shared by every handler instance, because there are many.

    `_configure` constructs `handler_class()` **per configure call**, not per run, and it does so
    before the `isinstance` check that decides whether to keep it: measured, one trivial `invoke()`
    produced two instances. Per-instance state would therefore mean several file objects appending
    to one path from one process, which is the interleaving the reader on the other side has to
    recover from. Module-level state means one writer and one lock.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._open: dict[str, tuple[str, Any]] = {}
        self.dropped = 0
        self.reported = 0

    @property
    def path(self) -> str:
        """Where to append, or empty when orca is not recording.

        Read per write rather than cached at import: this module is imported during interpreter
        startup, and a value captured then would be whatever the parent happened to export -- for
        a nested `orca record`, the outer run's transport.
        """
        return os.environ.get(SPANS_ENV, "")

    def write(self, record: dict[str, Any]) -> None:
        path = self.path
        # The one place that decides there is no transport. An empty value has to land here rather
        # than reach `open`, which would raise and be counted as a dropped record -- a run claiming
        # capture lost something when orca was not recording at all.
        if not path:
            return
        try:
            # `default=str` so a value JSON cannot take costs that one field and nothing else.
            # Every field written here is a string or an int today; this is about what a future
            # langchain-core puts in `metadata`, which is not ours to choose.
            line = json.dumps(record, ensure_ascii=False, default=str)
        except Exception:  # noqa: BLE001 - a record that will not serialise must not end the run
            self.dropped += 1
            return
        try:
            # Opened per write, like the sibling adapter: the transport may be swept out from under
            # a long run, and holding a handle to a deleted file would discard every later record
            # in silence. A failed append is counted instead.
            with self._lock, open(path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:  # noqa: BLE001 - a debugger must not be able to fail a run
            self.dropped += 1

    def opened(self, run_id: str, node: str, step: Any) -> bool:
        """Remember a node start, or refuse to when the map is already at its ceiling."""
        with self._lock:
            if len(self._open) >= MAX_OPEN:
                self.dropped += 1
                return False
            self._open[run_id] = (node, step)
            self.reported += 1
            return True

    def closing(self, run_id: str) -> tuple[str, Any] | None:
        """What this run id was reported as, or None if it was not one of ours.

        Removing here is what makes an end written once. It is also the only reason the node name
        can appear on an end record at all: `on_chain_end` is handed a run id and an output, and
        nothing that says which node it belonged to.
        """
        with self._lock:
            return self._open.pop(run_id, None)

    def losses(self) -> dict[str, Any] | None:
        """The `dropped` record, or None when there is nothing to say."""
        with self._lock:
            unclosed = len(self._open)
            total = self.dropped + unclosed
        if total <= 0:
            return None
        return {"kind": "dropped", "count": total, "package": PACKAGE}

    def reset(self) -> None:
        """Only for tests; nothing in the package calls it."""
        with self._lock:
            self._open.clear()
            self.dropped = 0
            self.reported = 0


TRANSPORT = _Transport()


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def report_losses() -> None:
    """Write what was not captured, at exit. Registered by `install`, never on import.

    A node that neither ended nor errored is counted with the drops rather than reported as a node
    that ran forever: from here the two are the same observation, and the honest summary is that
    the pairing is missing.
    """
    record = TRANSPORT.losses()
    if record is not None:
        TRANSPORT.write(record)


class OrcaCallbackHandler:
    """Reports LangGraph node boundaries, and nothing else.

    Not a subclass of `langchain_core.callbacks.BaseCallbackHandler`, deliberately: importing
    langchain-core to define the class would make this module unimportable without it, and the
    point is that it is inert when langchain-core is absent. Measured, importing the module that
    holds the hook registry costs **617 ms** against an interpreter that starts in about 50 -- and
    `orca record` puts this package's bootstrap in front of every Python process a recording
    starts, `python --version` included. langchain-core checks the attributes, not the base class;
    `_configure` type-checks with `isinstance(handler, handler_class)` against the class it was
    handed, which is this one.
    """

    #: Without this, an `ainvoke` runs the handler on the default executor rather than on the
    #: caller's thread -- measured, thread `asyncio_0` against `MainThread` -- which reorders the
    #: records and makes the timestamps say when the callback was scheduled rather than when the
    #: node ran. langchain-core supplies no timestamp of its own, so that would be the only one.
    run_inline = True

    #: An exception from a callback must never reach the graph. False is langchain-core's default;
    #: it is stated because this handler's whole contract is that it cannot fail a run.
    raise_error = False

    #: What this handler listens to. **Every** `ignore_*` that `BaseCallbackHandler` defines has to
    #: be here, not just the ones set to True: the dispatcher reads them with a bare
    #: `getattr(handler, ignore_condition_name)`, so a missing one is an `AttributeError` per
    #: callback -- which langchain-core logs and swallows. Measured, omitting `ignore_chain` gave a
    #: graph that ran to completion, printed four `Error in ... callback` lines, and recorded
    #: nothing. A silent miss, arriving through the one attribute that had to be False.
    #:
    #: `test_the_ignore_set_matches_langchain_core` compares this list against the installed
    #: `BaseCallbackHandler` so that a version which adds an eighth is caught by a test rather than
    #: by an empty trace.
    ignore_chain = False
    ignore_llm = True
    ignore_chat_model = True
    ignore_retriever = True
    ignore_agent = True
    ignore_retry = True
    ignore_custom_event = True

    def __init__(self) -> None:
        """Nothing. Deliberately nothing.

        `_configure` calls `handler_class()` directly, unguarded, and does it on every configure
        call before deciding whether the handler is already present -- measured, a handler whose
        `__init__` raised made an ordinary `app.invoke()` raise the same `RuntimeError`. So this
        opens no file, reads no environment variable and joins no path; everything that can fail is
        deferred to a write, where it is caught.
        """

    # -- langchain-core's interface -------------------------------------------------------------
    def on_chain_start(
        self,
        serialized: Any,
        inputs: Any,
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        tags: Any = None,
        metadata: Any = None,
        **kwargs: Any,
    ) -> None:
        try:
            meta = metadata if isinstance(metadata, dict) else {}
            node = meta.get("langgraph_node")
            name = kwargs.get("name")
            # Compared, not copied. See the module docstring.
            if name is None or node is None or name != node or node in SYNTHETIC:
                return
            node = str(node)
            step = meta.get("langgraph_step")
            # An int or nothing. `isinstance(True, int)` is also true, and a bool here would be a
            # sign the field had changed meaning, so it is excluded rather than written as 1.
            step = step if isinstance(step, int) and not isinstance(step, bool) else None
            key = str(run_id)
            if not TRANSPORT.opened(key, node, step):
                return
            TRANSPORT.write(
                {
                    "kind": "span",
                    "type": SPAN_START,
                    "span_id": key,
                    "parent_id": None if parent_run_id is None else str(parent_run_id),
                    "started_at": _now(),
                    # The superstep is per graph, not per run: a subgraph's node reports its own,
                    # so two records can share a step without being concurrent unless they also
                    # share a parent. The reader is told both and can tell them apart.
                    "data": {"node": node, "step": step},
                }
            )
        except Exception:  # noqa: BLE001 - never raise into the graph
            return

    def on_chain_end(
        self, outputs: Any, *, run_id: Any = None, parent_run_id: Any = None, **kwargs: Any
    ) -> None:
        self._close(run_id, None)

    def on_chain_error(
        self, error: BaseException, *, run_id: Any = None, parent_run_id: Any = None, **kwargs: Any
    ) -> None:
        # The class name, never the message. A node's exception text is whatever it was given -- a
        # row it could not find, an argument it was called with -- and nothing redacts this file on
        # the way in.
        self._close(run_id, type(error).__name__)

    def _close(self, run_id: Any, error: str | None) -> None:
        try:
            opened = TRANSPORT.closing(str(run_id))
            # An end for something never reported as a node -- an inner runnable, a conditional
            # edge, the graph itself. The discriminator cannot run here, so this is what stands in
            # for it.
            if opened is None:
                return
            node, step = opened
            data: dict[str, Any] = {"node": node, "step": step}
            if error is not None:
                data["error"] = error
            TRANSPORT.write(
                {
                    "kind": "span",
                    "type": SPAN_END,
                    "span_id": str(run_id),
                    "ended_at": _now(),
                    "data": data,
                }
            )
        except Exception:  # noqa: BLE001 - never raise into the graph
            return
