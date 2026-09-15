# orcareplay-openai-agents

Records the OpenAI Agents SDK's own run structure — which agent, which handoff, which guardrail —
into an [OrcaReplay](https://github.com/Continuum-AI-Corp/OrcaReplay) trace.

```console
pip install orcareplay-openai-agents
orca record generic-openai -- python your_agent.py
```

That is the whole setup. There is nothing to add to your agent.

## The SDK interface it implements

`OrcaTracingProcessor` implements the Agents SDK's own
[`TracingProcessor`](https://openai.github.io/openai-agents-python/ref/tracing/processor_interface/)
surface — `on_trace_start`, `on_trace_end`, `on_span_start`, `on_span_end`, `shutdown`,
`force_flush` — and is registered through the SDK's public entry points:

```python
from agents import add_trace_processor, set_trace_processors
from orcareplay_openai_agents import OrcaTracingProcessor

set_trace_processors([OrcaTracingProcessor()])   # what install() does
add_trace_processor(OrcaTracingProcessor())      # to keep the SDK's exporter as well
```

`install()` does the first of those for you and returns whether it registered anything. It is a
duck-typed implementation rather than a subclass on purpose: subclassing would mean importing
`agents` to define the class, and the package has to stay importable — and inert — on a machine
that has no SDK.

**Bounded, metadata-only spans.** Three span types are exported, and from each only the fields the
reader consumes:

| span | fields kept |
|---|---|
| `AgentSpanData` | `name`, `handoffs`, `tools`, `output_type` |
| `HandoffSpanData` | `from_agent`, `to_agent` |
| `GuardrailSpanData` | `name`, `triggered` |

Everything else is dropped, including every other span type. **Raw prompts, model output, tool
arguments, tool results, `mcp_data`, `CustomSpanData` payloads, transcription and speech audio, and
`SpanError.data` never reach the file** — an allow-list rather than a deny-list, so a field the SDK
adds in a future version is excluded without a code change. `ResponseSpanData` and
`GenerationSpanData` are dropped for a second reason as well: orca's proxy already holds those
exchanges byte for byte.

Verified against openai-agents **0.20.0** and **0.22.2**.

## What it adds, and what it does not

orca records model traffic at a proxy, and every claim it makes about capture comes from there. This
package is not needed for that: a run recorded without it is complete in the sense the rest of the
project means. What it adds is the part a proxy structurally cannot see.

Measured on a two-agent run with a handoff and a guardrail — the same script recorded twice:

| the trace can answer | without | with |
|---|---|---|
| which agent a turn belonged to | no | **yes** |
| that a handoff happened, and from whom | no | **yes** |
| that a guardrail ran | no | **yes** |

The middle row is the sharp one. The SDK implements a handoff as a function tool named
`transfer_to_<agent>`, so the proxy records an ordinary tool call and an ordinary next request. A
rule could *guess* a handoff from that name — but a user tool may be called the same thing, and the
agent it came **from** never reaches the wire at all. So a handoff is recorded rather than
inferred: `orca show` and `orca events` name both ends, which nothing reading the wire could have
told you.

Guardrails are the plainest case: one that passes need make no request whatsoever, so it leaves
nothing on the wire to reconstruct from.

**The model exchanges are deliberately left alone.** `ResponseSpanData` and `GenerationSpanData` are
dropped, because the proxy already holds those byte for byte and a second, lossier copy in the same
trace would be worse than none.

## How it attaches without editing your agent

`orca record` writes a `sitecustomize.py` into the run directory and puts that directory on
`PYTHONPATH`. Python imports `sitecustomize` at startup from anywhere on `sys.path`, so the layer
attaches to a process nobody modified — the same trick, and the same reason, as the Node adapter's
`NODE_OPTIONS` preload.

It is inert unless `ORCA_AGENT_SPANS` is set, which only `orca record` does. On a machine that
merely has this package installed, nothing happens.

If you would rather be explicit:

```python
from orcareplay_openai_agents import install

install()
```

## The SDK's own exporter

Installed through `sitecustomize`, this runs before your first statement — at which point the only
registered processor is the SDK's own exporter, which ships traces to OpenAI. It **replaces** that,
because a second egress out of a run being recorded is rarely what anyone wants, and on a machine
without a real tracing key it also fills the output with `Tracing client error 401`.

Anything you register afterwards is added on top and keeps working. To keep the SDK's exporter as
well:

```console
ORCA_AGENT_SPANS_KEEP_EXPORT=1 orca record generic-openai -- python your_agent.py
```

## Turning it off

```console
orca record generic-openai --no-agent-spans -- python your_agent.py
```

## What ends up in the trace

Three event types, added to the trace format in schema `0.2.0`:

```console
$ orca events --json last \
    | jq -r '.[] | select(.type|startswith("agent.")) | "\(.type) \(.attrs|del(.started_at))"'
agent.guardrail {"name":"not_empty","triggered":false}
agent.handoff {"from":"Triage","to":"Billing Specialist"}
agent.start {"name":"Triage","handoffs":"Billing Specialist","tools":0,"output_type":"str"}
agent.start {"name":"Billing Specialist","handoffs":"","tools":0,"output_type":"str"}
```

Each also carries `started_at`, dropped here to keep the line short — it is the SDK's own timestamp
for the span, which is what files a handoff between the turns it happened between rather than at the
end of the run.

They are written with `actor: "harness"` rather than `actor: "orca"`, because orca did not observe
them — it was told.

## Failure posture

Nothing in this package may fail a run it is only watching. Every write, every import and every
value it renders is guarded, including the `repr` fallback for objects it cannot describe: a span
payload is whatever the agent put in it, and an object whose `__repr__` raises would otherwise take
the run down from inside a debugging aid. A value that cannot be described becomes
`<unrepresentable>` and the run continues.

Apache-2.0. Part of [OrcaReplay](https://github.com/Continuum-AI-Corp/OrcaReplay).
