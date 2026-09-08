# Recording a framework

Most agent frameworks need no adapter. They read a base-URL variable, and `generic-openai` sets
every one in common use at once:

```console
orca record generic-openai -- python your_agent.py
```

Each section below is one command, one measured result, and the one thing about that framework
worth knowing before you run it. Every number here comes from `test/integrations/run.mjs`, which
runs in CI — so a claim on this page fails a build rather than ageing quietly.

---

## LangGraph and LangChain

```console
orca record generic-openai -- python your_graph.py
orca replay last
```

**Measured:** a two-node graph, streaming and with a bound tool. Recorded 2 exchanges, replayed
with the origin down at `exact=2 divergences=0 unmatched=0`, and forked live from checkpoint 1 onto
a different model.

### What replay proves here, and what it does not

LangGraph has its own time travel, and the two answer different questions. From LangChain's docs:

> Replay **re-executes nodes — it doesn't just read from cache. LLM calls, API requests, and
> interrupts fire again and may return different results.**

That makes the *workflow* deterministic. The model stays probabilistic.

`orca replay` serves the recorded responses back with the network off, so the conversation is
byte-identical:

| | asks the model again? | answers |
|---|---|---|
| LangGraph time travel | yes | "if I re-run from step 4, what happens?" |
| `orca replay` | **no** | "does the recorded run still reproduce today?" |
| `orca replay --from 4 --model X` | yes | "same prefix, different model — who is right?" |

The third row is the one that corresponds to time travel, and it is the one that costs tokens.

### Two things specific to LangGraph

**Both variables are set, and only one of them matters.** LangChain reads `OPENAI_API_BASE` itself
and hands the rest to the official client, which reads `OPENAI_BASE_URL`. Measured by removing each
in turn: taking `OPENAI_API_BASE` away breaks nothing here. Both stay set because pre-1.0 SDKs and
several ports read only that one.

**Setting a base URL changes a LangChain default.** It leaves `stream_usage` off, because many
non-OpenAI endpoints do not report streaming token counts. That is LangChain's behaviour, not
orca's, but a recorded run will differ from an unrecorded one in exactly that field.

**Checkpointer state is not in the trace.** An `InMemorySaver` thread id never reaches the wire, so
a replay rebuilds it by re-running the graph. A database-backed checkpointer is a different matter
and is not covered by the checks here.

---

## CrewAI, Aider, OpenHands

```console
orca record generic-openai -- python your_crew.py
```

All three route through **LiteLLM**, which reads `OPENAI_API_BASE`. That is the layer the checks
exercise: one check covers all three, and anything else built on LiteLLM comes with it.

**Measured:** `litellm.completion()` recorded and replayed at `exact=1 divergences=0`.

CrewAI has a known wrinkle worth knowing about even though it does not affect this route:
`LLM(base_url=…)` does not map to LiteLLM's `api_base`, so passing the URL in code can silently do
nothing. Going through the environment sidesteps it.

---

## OpenAI Agents SDK

```console
orca record generic-openai -- python your_agent.py
```

The default provider reads `OPENAI_BASE_URL`, and the SDK is built on `AsyncOpenAI` — both covered.

**Measured:** `AsyncOpenAI` recorded and replayed at `exact=1 divergences=0`.

Two things to decide before a long run:

**Tracing is a second egress.** The SDK ships its own traces to OpenAI. They are not model traffic
and orca does not capture them; `set_tracing_disabled(True)` turns them off if you would rather the
run talked to nothing but the proxy.

**The websocket transport is not captured.** With the Responses websocket transport enabled the SDK
reads `OPENAI_WEBSOCKET_BASE_URL`, and orca's proxy speaks HTTP. Under `--tls-intercept` an upgrade
inside an intercepted connection is refused with `501` rather than half-relayed, so it fails loudly;
outside it, the connection is tunnelled and works but is not recorded.

---

## browser-use

```console
orca record generic-openai -- python your_task.py
```

`ChatOpenAI` declares `base_url: str | httpx.URL | None = None` and passes it through, so an unset
value falls to the SDK's own `OPENAI_BASE_URL`.

**Measured:** recorded and replayed at `exact=1 divergences=0`, LLM layer only — the checks do not
drive a browser.

`ChatBrowserUse` is a different matter: it is browser-use's own hosted model, and its origin is not
an environment variable. That route needs `--tls-intercept` and the host named explicitly.

---

## Vercel AI SDK, and anything with its origin compiled in

```console
orca record node -- node your_app.mjs
```

`@ai-sdk/openai` takes its origin as a constructor argument and reads nothing from the environment.
The `node` adapter installs a preload through `NODE_OPTIONS` that redirects at `globalThis.fetch` —
the one place every JS client agrees on.

**Measured:** an agent posting to a hardcoded `https://api.openai.com/v1/chat/completions`,
recorded and replayed at `exact=1 divergences=0`.

---

## Anthropic-backed agents

```console
orca record generic-openai -- python your_agent.py
```

`ANTHROPIC_BASE_URL` is set alongside the OpenAI pair, so an agent using the Anthropic SDK directly
needs nothing extra. Claude Code has its own adapter — `orca record claude`.

**Measured:** the Anthropic SDK reaching `/v1/messages`, recorded and replayed at `exact=1
divergences=0`.

---

## When none of this works

**The trace comes back empty.** `orca record` says so rather than exiting quietly:

```
warn capture.empty exchanges=0 cause="the agent never called the proxy — it may not read a
  base-URL variable" set=ANTHROPIC_BASE_URL,OPENAI_API_BASE,OPENAI_BASE_URL next="orca doctor"
```

Three things it usually means, in order of likelihood:

1. **The framework reads a variable orca does not set.** Name it:
   `ORCA_BASE_URL_VARS=MY_LLM_ENDPOINT orca record generic-openai -- …`
2. **The origin is in a config file, not the environment.** OpenCode and its forks are like this.
   Interception is the route: `orca record exec --tls-intercept -- your-agent`.
3. **The origin is compiled in.** For a JS agent, `orca record node -- node app.mjs`. For anything
   else, `--tls-intercept` with the host named.

**A gateway on plain HTTP is captured by neither route.** orca sets `HTTPS_PROXY` and not
`HTTP_PROXY`, so plaintext upstream traffic is neither redirected nor decrypted.

---

## Adding a check

A framework is supported here when `test/integrations/run.mjs` says so. Adding one is a script
under `test/integrations/agents/` and a row in the corpus — see that directory's README for what
each check has to prove and why it is end to end rather than a contract check.
