# orcareplay-openai-agents

Records the OpenAI Agents SDK's own run structure — which agent, which handoff, which guardrail —
into an [OrcaReplay](https://github.com/Continuum-AI-Corp/OrcaReplay) trace.

```console
pip install orcareplay-openai-agents
orca record generic-openai -- python your_agent.py
```

That is the whole setup. There is nothing to add to your agent.

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
agent it came **from** never reaches the wire at all. `orca graph` already distinguishes what a
trace records from what a rule infers; this moves handoffs into the first column.

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
$ orca events --json last | jq -r '.[] | select(.type|startswith("agent.")) | "\(.type) \(.attrs)"'
agent.guardrail {"name":"not_empty","triggered":false}
agent.start     {"name":"Triage","handoffs":"Billing Specialist","tools":0}
agent.handoff   {"from":"Triage","to":"Billing Specialist"}
agent.start     {"name":"Billing Specialist","handoffs":"","tools":0}
```

They are written with `actor: "harness"` rather than `actor: "orca"`, because orca did not observe
them — it was told.

### It writes a whitelist, never a payload

Three span types reach disk, and from each only the fields the reader turns into an event:

| type | fields kept |
|---|---|
| `AgentSpanData` | `name`, `handoffs`, `tools`, `output_type` |
| `HandoffSpanData` | `from_agent`, `to_agent` |
| `GuardrailSpanData` | `name`, `triggered` |

Everything else — every other span type, and every other field of these three — is dropped, and the
reason is a rule this package cannot bend. OrcaReplay's redactor lives in the TypeScript write path,
and there is deliberately no second one, because a second redaction implementation is how a secret
leaks. This file is a sink with no redactor in front of it, so nothing a *user* put in a span may be
written here at all.

That is not hypothetical. `FunctionSpanData.export()` is `{name, input, output}` — a tool's
arguments and its result, which is exactly where an `Authorization` header or a returned credential
lives. `MCPToolCallSpanData` carries `arguments` and `result`; `CustomSpanData` is whatever was
passed to `custom_span(data=…)`; `AgentSpanData.instructions` is the system prompt. The same bytes
are scrubbed in `events.jsonl`, and `orca scrub` does not rewrite this file — so anything written
here would survive a scrub that reported success.

A fourth type is supported by listing its fields in `KEEP`, never by widening this to the whole
export.

## Failure posture

Nothing in this package may fail a run it is only watching. Every write, every import and every
value it renders is guarded, including the `repr` fallback for objects it cannot describe: a span
payload is whatever the agent put in it, and an object whose `__repr__` raises would otherwise take
the run down from inside a debugging aid. A value that cannot be described becomes
`<unrepresentable>` and the run continues.

Guarding the value is not enough on its own, which took a review to notice. `export()` and every
attribute read happen while the record is still being *built*, before the value-level guard is
entered, and both are user code: `CustomSpanData.export()` raises on a circular reference, and the
SDK may make any of `span_id`, `started_at` or `ended_at` a property. The SDK calls `on_span_end`
synchronously from `Span.finish()`, so an escape there surfaces as the user's own `Runner.run()`
failing — the debugger ending the run it was watching. Those reads are guarded too; a span that
cannot be read is skipped, and the run continues.

Apache-2.0. Part of [OrcaReplay](https://github.com/Continuum-AI-Corp/OrcaReplay).
