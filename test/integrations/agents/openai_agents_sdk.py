"""The OpenAI Agents SDK itself, on the API it reaches for by default.

Separate from `openai_async.py`, which covers the `AsyncOpenAI` client underneath it. That check
proves the client can be redirected; it says nothing about the wire format the SDK actually speaks,
because the SDK defaults to the **Responses API** and `AsyncOpenAI` in that check does not. So the
path a real Agents SDK user takes had no end-to-end check until this one, on a claim the README has
been making.

Nothing here switches the SDK to chat completions. A check that did would prove the wrong path
works.
"""

import asyncio

from agents import Agent, Runner, set_tracing_disabled

# The SDK ships its own traces to OpenAI, on a second connection that is not model traffic and that
# orca does not capture. Off here so the run talks to nothing but the proxy — which is also what
# makes this check deterministic, and what the docs tell a reader to decide about before a long run.
set_tracing_disabled(True)


async def main() -> None:
    agent = Agent(name="Stub", instructions="Answer in one short sentence.", model="stub-1")
    result = await Runner.run(agent, "hello")
    print("GOT:", result.final_output)


asyncio.run(main())
