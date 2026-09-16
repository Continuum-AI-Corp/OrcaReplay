"""The claims that only a real LangGraph can settle, against the installed version.

`test_handler.py` drives the handler with the kwargs langchain-core is believed to pass. This file
is what keeps that belief honest: it builds ordinary graphs, invokes them, and reads the transport.
Nothing here imports the handler into the test process — registration, `sys.meta_path` and the hook
registry are all process-wide, so each case is a subprocess with its own interpreter.

Skipped rather than failed when langgraph is absent, because the package is meant to be installable
and inert on a machine that has never seen it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap

import pytest

from orcareplay_langgraph import PACKAGE

langgraph = pytest.importorskip("langgraph", reason="the adapter is inert without it")

#: The repository's package directory, so a subprocess imports the source under test rather than
#: whatever `pip` may have left on the machine.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(body, tmp_path, *, spans=True, env=None, expect_rc=0):
    """Run a snippet in a fresh interpreter and return (stdout, the records it produced).

    `body` may be a list of parts, each dedented on its own before they are joined. Dedenting the
    concatenation instead would strip only the prefix they share, which silently mis-indents every
    part written at a deeper level than the shallowest one.
    """
    parts = [body] if isinstance(body, str) else list(body)
    script = tmp_path / "case.py"
    script.write_text("\n".join(textwrap.dedent(p) for p in parts), encoding="utf-8")
    path = tmp_path / "agent-spans.jsonl"

    child = dict(os.environ)
    child["PYTHONPATH"] = ROOT + os.pathsep + child.get("PYTHONPATH", "")
    child.pop("ORCA_AGENT_SPANS", None)
    if spans:
        child["ORCA_AGENT_SPANS"] = str(path)
    child.update(env or {})

    done = subprocess.run(
        [sys.executable, str(script)], capture_output=True, text=True, env=child, timeout=300
    )
    assert done.returncode == expect_rc, f"rc={done.returncode}\n{done.stdout}\n{done.stderr}"
    written = []
    if path.exists():
        written = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l]
    return done.stdout, written


GRAPH = """
    from typing import Annotated, TypedDict
    from langchain_core.runnables import RunnableLambda
    from langgraph.graph import END, START, StateGraph

    class S(TypedDict):
        seen: Annotated[list, lambda a, b: a + b]

    def first(state):
        # A runnable inside a node: inherits langgraph_node, and must not be reported as one.
        RunnableLambda(lambda x: x).with_config({"run_name": "INNER-RUNNABLE"}).invoke({})
        return {"seen": ["first"]}

    def validate_only(state):
        # A node that makes no model call at all: invisible to a proxy by construction.
        return {"seen": []}

    def second(state):
        return {"seen": ["second"]}

    def router(state):
        return "second"

    g = StateGraph(S)
    g.add_node("first", first)
    g.add_node("validate_only", validate_only)
    g.add_node("second", second)
    g.add_edge(START, "first")
    g.add_edge("first", "validate_only")
    g.add_conditional_edges("validate_only", router, {"second": "second"})
    g.add_edge("second", END)
    app = g.compile(name="the_graph")
"""


def nodes(records, type_):
    return [r["data"]["node"] for r in records if r["type"] == type_]


def test_the_ignore_set_matches_langchain_core():
    """Every `ignore_*` the base class defines must exist on ours, because we do not subclass.

    The dispatcher reads them with a bare `getattr(handler, ignore_condition_name)`. A missing one
    raises `AttributeError` inside the callback, which langchain-core logs and swallows — measured,
    omitting `ignore_chain` produced a graph that ran to completion, printed four
    `Error in ... callback` lines, and recorded nothing at all.

    So this compares the sets rather than spot-checking, and it is an integration test rather than
    a unit test on purpose: the thing it guards against is a langchain-core release adding an
    eighth, which only the installed package can tell us.
    """
    from langchain_core.callbacks.base import BaseCallbackHandler

    from orcareplay_langgraph import OrcaCallbackHandler

    theirs = {n for n in dir(BaseCallbackHandler) if n.startswith("ignore_")}
    ours = {n for n in dir(OrcaCallbackHandler) if n.startswith("ignore_")}
    assert theirs <= ours, f"langchain-core reads these and we do not define them: {theirs - ours}"


def test_the_duck_typed_surface_is_complete():
    """Beyond `ignore_*`: everything the manager reads off a handler that is not tracer-guarded.

    `order_map`, `run_map`, `_external_run_ids` and `copy_with_metadata_defaults` are read only
    behind `isinstance(handler, LangChainTracer)`, so they are not ours to supply. What is left is
    this.
    """
    from orcareplay_langgraph import OrcaCallbackHandler

    handler = OrcaCallbackHandler()
    assert handler.raise_error is False
    assert handler.run_inline is True


def test_a_graph_nobody_edited_is_recorded(tmp_path):
    """The headline claim: `install()` first, the user's own graph after, no edit anywhere.

    This is the order `orca record` produces — the bootstrap runs before the agent's first
    statement — and it is the order the lazy finder exists for.
    """
    out, records = run(
        [
            """
            from orcareplay_langgraph import install
            assert install() is True
            """,
            GRAPH,
            """
            print(app.invoke({"seen": []}))
            """,
        ],
        tmp_path,
    )

    assert nodes(records, "LangGraphNodeStart") == ["first", "validate_only", "second"]
    assert nodes(records, "LangGraphNodeEnd") == ["first", "validate_only", "second"]
    assert [r["data"]["step"] for r in records if r["type"] == "LangGraphNodeStart"] == [1, 2, 3]
    assert "INNER-RUNNABLE" not in json.dumps(records)
    assert "the_graph" not in json.dumps(records)
    assert "router" not in json.dumps(records)


def test_the_node_that_calls_no_model_is_the_point(tmp_path):
    """`validate_only` makes no request. A proxy cannot know it ran; this is where it comes from."""
    _, records = run(
        ["from orcareplay_langgraph import install\ninstall()", GRAPH, "app.invoke({'seen': []})"],
        tmp_path,
    )
    assert "validate_only" in nodes(records, "LangGraphNodeStart")


def test_installing_after_langgraph_is_imported_still_works(tmp_path):
    """A user calling `install()` in their own script, below their imports.

    The trigger has already fired by then, so the finder would never be asked; `install` has to
    notice langgraph in `sys.modules` and register on the spot.
    """
    _, records = run(
        [
            GRAPH,
            """
            from orcareplay_langgraph import install
            assert install() is True
            app.invoke({"seen": []})
            """,
        ],
        tmp_path,
    )
    assert nodes(records, "LangGraphNodeStart") == ["first", "validate_only", "second"]


def test_a_second_install_does_not_double_report(tmp_path):
    _, records = run(
        [
            """
            from orcareplay_langgraph import install
            assert install() is True
            assert install() is False
            """,
            GRAPH,
            """
            from orcareplay_langgraph import install as again
            assert again() is False
            app.invoke({"seen": []})
            """,
        ],
        tmp_path,
    )
    assert nodes(records, "LangGraphNodeStart") == ["first", "validate_only", "second"]


def test_without_the_variable_nothing_is_written_and_the_graph_still_runs(tmp_path):
    out, records = run(
        [
            """
            import sys
            from orcareplay_langgraph import install
            assert install() is False, "orca is not recording; nothing should be armed"
            before = len(sys.meta_path)
            """,
            GRAPH,
            """
            print(app.invoke({"seen": []})["seen"])
            assert len(sys.meta_path) == before, "no finder should have been left behind"
            """,
        ],
        tmp_path,
        spans=False,
    )
    assert "['first', 'second']" in out
    assert records == []


def test_a_failing_node_is_named(tmp_path):
    """Which node raised is not on the wire, and it is the first thing anyone asks."""
    _, records = run(
        """
        from typing import TypedDict
        from orcareplay_langgraph import install
        install()
        from langgraph.graph import END, START, StateGraph

        class S(TypedDict):
            n: int

        def ok(state):
            return {"n": 1}

        def boom(state):
            raise ValueError("no row for ada@example.com")

        g = StateGraph(S)
        g.add_node("ok", ok)
        g.add_node("boom", boom)
        g.add_edge(START, "ok")
        g.add_edge("ok", "boom")
        g.add_edge("boom", END)
        try:
            g.compile().invoke({"n": 0})
        except ValueError:
            print("raised, as the graph should")
        """,
        tmp_path,
    )

    ends = {r["data"]["node"]: r["data"] for r in records if r["type"] == "LangGraphNodeEnd"}
    assert ends["ok"].get("error") is None
    assert ends["boom"]["error"] == "ValueError"
    assert "ada@example.com" not in json.dumps(records), "the message must never be written"


def test_parallel_workers_share_a_superstep(tmp_path):
    """One superstep, two nodes. On the wire this is indistinguishable from two turns."""
    _, records = run(
        """
        from typing import Annotated, TypedDict
        from orcareplay_langgraph import install
        install()
        from langgraph.graph import END, START, StateGraph
        from langgraph.types import Send

        class S(TypedDict):
            out: Annotated[list, lambda a, b: a + b]

        g = StateGraph(S)
        g.add_node("worker", lambda s: {"out": ["w"]})
        g.add_conditional_edges(START, lambda s: [Send("worker", {"out": []})] * 2, ["worker"])
        g.add_edge("worker", END)
        g.compile().invoke({"out": []})
        """,
        tmp_path,
    )

    starts = [r for r in records if r["type"] == "LangGraphNodeStart"]
    assert [r["data"] for r in starts] == [{"node": "worker", "step": 1}] * 2
    assert starts[0]["span_id"] != starts[1]["span_id"]
    assert starts[0]["parent_id"] == starts[1]["parent_id"]
    assert len([r for r in records if r["type"] == "LangGraphNodeEnd"]) == 2


def test_ainvoke_records_on_the_calling_thread(tmp_path):
    """`run_inline`, checked where it matters: the timestamps are the only ones the trace gets."""
    out, records = run(
        """
        import asyncio, threading
        from typing import TypedDict
        from orcareplay_langgraph import install
        install()
        from langgraph.graph import END, START, StateGraph
        import orcareplay_langgraph.handler as H

        seen = set()
        real = H.TRANSPORT.write
        H.TRANSPORT.write = lambda r: (seen.add(threading.current_thread().name), real(r))[1]

        class S(TypedDict):
            n: int
        g = StateGraph(S)
        g.add_node("a", lambda s: {"n": 1})
        g.add_edge(START, "a")
        g.add_edge("a", END)
        asyncio.run(g.compile().ainvoke({"n": 0}))
        print("threads:", sorted(seen))
        """,
        tmp_path,
    )
    assert "threads: ['MainThread']" in out
    assert nodes(records, "LangGraphNodeStart") == ["a"]


def test_a_python_process_that_never_touches_langgraph_pays_nothing(tmp_path):
    """The justification for the whole lazy design, as a test.

    `orca record` puts the bootstrap in front of every Python process a recording starts. Importing
    the module that holds the hook registry costs 617 ms on this machine, so a process that only
    prints its version must not import it — and must not import langchain_core or langgraph either.
    """
    out, records = run(
        """
        import sys, time
        t = time.perf_counter()
        from orcareplay_langgraph import install
        install()
        cost = (time.perf_counter() - t) * 1000
        leaked = sorted(m for m in sys.modules if m.split(".")[0] in ("langchain_core", "langgraph", "langchain"))
        print("cost_ms:", round(cost, 1))
        print("leaked:", leaked)
        """,
        tmp_path,
    )
    assert "leaked: []" in out, out
    cost = float(out.split("cost_ms:")[1].split()[0])
    assert cost < 100, f"arming should be nearly free, took {cost} ms"


def test_the_finder_removes_itself(tmp_path):
    """It is asked once. Leaving it on `sys.meta_path` would tax every later import in the run."""
    out, _ = run(
        """
        import sys
        from orcareplay_langgraph import install
        install()
        armed = sum(1 for f in sys.meta_path if type(f).__name__ == "_LazyInstaller")
        import langgraph.graph  # noqa: F401
        after = sum(1 for f in sys.meta_path if type(f).__name__ == "_LazyInstaller")
        print("armed:", armed, "after:", after)
        """,
        tmp_path,
    )
    assert "armed: 1 after: 0" in out


def test_langchain_core_is_executed_once(tmp_path):
    """The re-entrancy the finder's trigger choice exists to avoid.

    The finder runs inside `_find_and_load_unlocked`, past its `sys.modules` check. Importing
    langchain-core from a `find_spec` for a `langchain_core.*` name would re-enter that load and
    execute the package twice, leaving two module objects. Triggering on `langgraph` cannot.
    """
    out, _ = run(
        """
        import sys
        seen = []
        real_exec = None
        import importlib.machinery as M
        original = M.SourceFileLoader.exec_module
        def counting(self, module):
            if module.__name__ == "langchain_core":
                seen.append(id(module))
            return original(self, module)
        M.SourceFileLoader.exec_module = counting

        from orcareplay_langgraph import install
        install()
        import langgraph.graph  # noqa: F401
        import langchain_core
        print("executions:", len(seen), "identity_ok:", id(langchain_core) in seen)
        """,
        tmp_path,
    )
    assert "executions: 1 identity_ok: True" in out, out


def test_langchain_core_alone_is_executed_once(tmp_path):
    """The same hazard, reached the only way that actually reaches it.

    Importing langgraph fires the trigger before any `langchain_core` name is looked up, so a
    finder that *also* watched `langchain_core` would behave identically there and the bug would
    hide. It shows up when langchain-core is imported first and langgraph never: measured against a
    finder widened to watch both, `langchain_core` was executed **twice**, leaving one stale module
    object behind. That is why `TRIGGER` is a single root.
    """
    out, _ = run(
        """
        import importlib.machinery as M
        seen = []
        original = M.SourceFileLoader.exec_module
        def counting(self, module):
            if module.__name__ == "langchain_core":
                seen.append(id(module))
            return original(self, module)
        M.SourceFileLoader.exec_module = counting

        from orcareplay_langgraph import install
        install()
        import langchain_core   # first, and langgraph never
        print("stale objects:", len(seen) - 1)
        """,
        tmp_path,
    )
    assert "stale objects: 0" in out, out


def test_losses_are_reported_at_exit(tmp_path):
    """A node the process never saw the end of is counted, and says which adapter counted it."""
    _, records = run(
        """
        from typing import TypedDict
        from orcareplay_langgraph import install
        install()
        from langgraph.graph import END, START, StateGraph
        import orcareplay_langgraph.handler as H

        class S(TypedDict):
            n: int
        g = StateGraph(S)
        g.add_node("a", lambda s: {"n": 1})
        g.add_edge(START, "a")
        g.add_edge("a", END)
        H.OrcaCallbackHandler.on_chain_end = lambda *a, **k: None   # the end never arrives
        g.compile().invoke({"n": 0})
        """,
        tmp_path,
    )
    assert records[-1] == {"kind": "dropped", "count": 1, "package": PACKAGE}


def test_the_user_keeps_their_own_callbacks(tmp_path):
    """Attaching must not displace anything: a handler passed in `config` still fires."""
    out, records = run(
        """
        from typing import TypedDict
        from orcareplay_langgraph import install
        install()
        from langchain_core.callbacks.base import BaseCallbackHandler
        from langgraph.graph import END, START, StateGraph

        theirs = []
        class Theirs(BaseCallbackHandler):
            def on_chain_start(self, *a, **k):
                theirs.append(k.get("name"))

        class S(TypedDict):
            n: int
        g = StateGraph(S)
        g.add_node("a", lambda s: {"n": 1})
        g.add_edge(START, "a")
        g.add_edge("a", END)
        g.compile().invoke({"n": 0}, config={"callbacks": [Theirs()]})
        print("theirs saw:", "a" in theirs)
        """,
        tmp_path,
    )
    assert "theirs saw: True" in out
    assert nodes(records, "LangGraphNodeStart") == ["a"]
