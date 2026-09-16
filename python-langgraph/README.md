# orcareplay-langgraph

Record a LangGraph run's own structure — which node ran, in which superstep, and how it ended —
into an [OrcaReplay](https://github.com/Continuum-AI-Corp/OrcaReplay) trace.

```console
pip install orcareplay-langgraph
```

That is the whole setup. `orca record` attaches it to a graph you have not edited; there is no
callback to register, no `with_config`, and no import in your code.

```console
orca record generic-openai -- python your_graph.py
```

## What it adds, and what it does not

orca records model traffic at a proxy, and every claim it makes about capture comes from there.
This package is not needed for that: a LangGraph run recorded without it is complete in the sense
the rest of the project means. What it adds is the part a proxy structurally cannot see.

The wire carries the conversation and not the graph. Searching a recorded three-node run for the
node names, the graph's name, `langgraph_node` and `langgraph_step` finds none of them in any
request:

| the trace can answer | without | with |
| --- | --- | --- |
| which nodes ran, and in which superstep | no | yes |
| that a node ran at all, when it called no model | no | yes |
| that two calls were one parallel superstep, not two turns | no | yes |
| when each node began and ended | no | yes |

The second row is the common shape rather than an edge case. Validators, state reducers, routers
and writers make no model call, so a proxy sees a graph with those nodes and a graph without them
as the same run. Recorded with this package, a graph of `plan → validate → answer` against a stub
origin produces:

```
03:24:45.102  graph.node.start   plan
03:24:45.233  model.request
03:24:45.235  model.response
03:24:45.239  graph.node.end     plan
03:24:45.240  graph.node.start   validate      ← no request of any kind
03:24:45.241  graph.node.end     validate
03:24:45.241  graph.node.start   answer
03:24:45.254  graph.node.end     answer
```

**What it does not do is attribute a model call to a node by timestamp alone**, and the reason is
on orca's side rather than here. A node record carries the instant the callback fired — measured
against the agent's own clock, exactly. A `model.request` is stamped when orca *persists* it, which
is after the response and after a workspace snapshot: measured 95 ms late on one call and 31 ms on
the next. The node boundaries are trustworthy; a call within about a tenth of a second of one can
fall on the wrong side of it.

## What is written

Two record types, and from each only the fields the reader consumes:

| record | fields |
| --- | --- |
| `LangGraphNodeStart` | `node`, `step`, `run_id`, `parent_run_id`, `started_at` |
| `LangGraphNodeEnd` | `node`, `step`, `run_id`, `ended_at`, and `error` when the node raised |

Nothing else. No state, no inputs, no outputs, no messages, no tool arguments, and no exception
*message* — only the exception's class name. The model exchanges are left to the proxy, which
already holds them byte for byte; a second copy in a file orca does not redact on the way in would
be a lossier duplicate in a place nothing scrubs.

`step` is the superstep, which is per graph rather than per run: a subgraph's node reports its own,
so two records can share a step without being concurrent. `parent_run_id` is what separates those,
and it is how two nodes of one parallel fan-out are told apart from two consecutive turns.

## How a node is recognised

This is the whole design, and it is also what keeps the package safe.

`on_chain_start` fires for everything a graph runs. At that moment a node, a runnable *inside* a
node, a subgraph and a conditional-edge function all look alike — same inherited `langgraph_node`,
same `langgraph_step`, and an arbitrary `name`. Measured on one graph: `name='INNER-RUNNABLE'`
carrying `langgraph_node='first'`, `name='router'` carrying `langgraph_node='validate_only'`, and
`name='the_graph'` carrying no `langgraph_node` at all. Reporting on `name` alone reports all four.

So a node is reported only when the `name` kwarg **equals** `metadata['langgraph_node']` — compared,
never copied. `langgraph_node` is the name the graph's author wrote in `add_node(...)`, while `name`
is whatever the caller supplied, including

```python
node.with_config({"run_name": f"lookup for {customer.email}"})
```

The two are equal only for an author-defined node, so a runtime string cannot reach the transport
through this path. LangGraph's own `__start__` and `__end__` markers are filtered as well: they are
reported exactly like nodes, and nobody wrote them.

## Inert unless orca is recording

Everything keys off `ORCA_AGENT_SPANS`, which only `orca record` sets. With it unset the package
registers nothing, opens nothing and costs nothing, which is what makes it safe to leave installed.

It declares **no dependencies** — not langgraph, not langchain-core. Installing a framework as a
side effect of installing a debugging aid is the kind of thing that makes people uninstall the
debugging aid, and `orca record` puts this package's bootstrap in front of every Python process a
recording starts, `python --version` included. Importing the module that holds langchain-core's
hook registry costs **617 ms** against an interpreter that starts in about 50, so `install()` arms
a `sys.meta_path` finder and returns; the registration happens the first time anything under
`langgraph` is imported, in a process already paying a second for it.

## Using it explicitly

Supported, for anyone who would rather be. `install()` returns whether it did anything, and is
false — quietly — when orca is not recording or the hook is already registered.

```python
from orcareplay_langgraph import install

install()
```

To supply your own handler instance, set the context variable langchain-core offers:

```python
from orcareplay_langgraph import HANDLER_VAR, OrcaCallbackHandler

HANDLER_VAR.set(OrcaCallbackHandler())
```

## The langchain-core interface it implements

`OrcaCallbackHandler` is **not** a subclass of `BaseCallbackHandler`, deliberately: importing
langchain-core to define the class would make this module unimportable without it, and the point is
that it is inert when langchain-core is absent. langchain-core checks the attributes, not the base
class, and `_configure` type-checks with `isinstance(handler, handler_class)` against the class it
was handed — which is this one.

| attribute | value | why |
| --- | --- | --- |
| `on_chain_start` / `on_chain_end` / `on_chain_error` | implemented | node boundaries, and how one ended |
| `ignore_chain` | `False` | the only callbacks this wants |
| `ignore_llm`, `ignore_chat_model`, `ignore_retriever`, `ignore_agent`, `ignore_retry`, `ignore_custom_event` | `True` | keeps it out of the token and tool hot path |
| `run_inline` | `True` | without it an `ainvoke` runs the callback on the default executor, and the timestamps say when it was scheduled |
| `raise_error` | `False` | a callback must never take the graph down |

Every `ignore_*` the base class defines is present, including the ones set to `False`: the
dispatcher reads them with a bare `getattr`, so a missing one is an `AttributeError` per callback,
which langchain-core logs and swallows. Measured, omitting `ignore_chain` gave a graph that ran to
completion, printed four `Error in ... callback` lines, and recorded nothing — a silent miss. A test
compares the two sets so a langchain-core release that adds an eighth is caught by a test rather
than by an empty trace.

`__init__` does nothing at all, and that is load-bearing: `_configure` constructs a handler on every
configure call, unguarded, before deciding whether one is already present — measured, one trivial
`invoke()` constructs two. A handler whose `__init__` raised made an ordinary `app.invoke()` raise
the same exception, so nothing here opens a file, reads the environment or joins a path.

## Licence

Apache-2.0.
