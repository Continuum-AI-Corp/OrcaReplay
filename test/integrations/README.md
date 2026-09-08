# Integration checks

`orca record generic-openai -- python your_agent.py` is documented as working for LangGraph,
CrewAI, the OpenAI Agents SDK and anything else that reads a base-URL variable. Until this
directory existed, that was a sentence.

Each check here records a real framework against a stub origin, kills the origin, replays the
recording offline, and asserts the numbers. It is the difference between "we support X" and a line
in CI that goes red.

## Why end to end rather than the adapter contract

`checkAdapterContract` guards against adapter rot — a harness renames the variable it reads and the
adapter keeps setting the old one. It cannot see whether anything was actually captured.

`orca record opencode` once produced a trace with two events and no model exchange, twice over, for
two independent reasons. The contract was green for both. What catches that shape is running the
thing and counting what came back.

## Why a stub origin

Three properties, and every one of them is load-bearing:

- **Free.** A matrix that costs tokens per run is a matrix somebody eventually turns off.
- **Deterministic.** Replay is judged on matching the recorded bytes. An origin that varied its
  answer would make an exact match indistinguishable from a lucky one.
- **Offline.** The second half of every check kills the origin before replaying. If a replay reaches
  the network the check fails by construction rather than by assertion.

The stub answers the shapes real frameworks use, not the simplest one: streaming SSE, tool calls,
and the Anthropic messages endpoint. Those are where a recording proxy is most likely to break, and
a matrix that only exercised a plain completion would have said nothing about either.

## What each check proves

| check | the mechanism it covers | what else rides on it |
|---|---|---|
| `openai-sdk` | the official Python SDK reads `OPENAI_BASE_URL` | every framework that lets the SDK build its own client |
| `openai-async` | the same for `AsyncOpenAI` | the OpenAI Agents SDK |
| `anthropic-sdk` | `ANTHROPIC_BASE_URL` | Claude-backed agents that are not Claude Code |
| `litellm` | `OPENAI_API_BASE` through LiteLLM | **CrewAI, Aider, OpenHands** — they route through it |
| `langgraph-stream` | LangChain's own `OPENAI_API_BASE`, over SSE | LangGraph, LangChain |
| `langgraph-tools` | the same, with a bound tool | tool-calling graphs |
| `browser-use` | its own `ChatOpenAI` passes an unset `base_url` through | browser-use, and the pattern any wrapper using the official SDK follows |
| `fetch-hook` | `NODE_OPTIONS` preload on `globalThis.fetch` | the Vercel AI SDK, and any JS agent with its origin compiled in |

Eight checks, and the `litellm` row is the reason the list is shorter than the set of frameworks it
speaks for: covering the layer underneath covers everything standing on it.

## What the checks are worth, measured

A green matrix proves nothing on its own. Each redirect was removed in turn to see which checks
notice:

| removed from `generic-openai` | what fails |
|---|---|
| `OPENAI_BASE_URL` | `openai-sdk`, `openai-async` |
| `ANTHROPIC_BASE_URL` | `anthropic-sdk` |
| `OPENAI_API_BASE` | **nothing** |

The last row is the finding. LangChain reads `OPENAI_API_BASE` itself, but it hands the rest to the
official client, which reads `OPENAI_BASE_URL` — so the LangGraph checks survive losing the variable
that appears to be theirs. Both are still set, because pre-1.0 SDKs and several ports read only the
second, and this matrix does not cover those. It is worth knowing that today nothing here would
notice if that line went away.

## Running them

```console
node test/integrations/run.mjs            # all of them
node test/integrations/run.mjs litellm    # one
```

Python checks are skipped, not failed, when the package they need is not installed — a contributor
without `langgraph` on their machine should still be able to run the suite. CI installs them, so a
skip there is a failure.
