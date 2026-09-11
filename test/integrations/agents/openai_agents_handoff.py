"""A two-agent run with a handoff and an input guardrail, configuring nothing.

The point of this check is what the file does *not* contain. orca attaches its tracing processor
through a `sitecustomize` on PYTHONPATH, so an agent that has never heard of orca still reports the
three things a proxy cannot see: which agent a turn belonged to, that a handoff happened and from
whom, and that a guardrail ran. If this file mentioned orca, it would be testing something else.

The stub answers the first turn with a `transfer_to_*` call, so the handoff is real rather than
simulated.
"""

import asyncio

from agents import (
    Agent,
    GuardrailFunctionOutput,
    RunContextWrapper,
    Runner,
    input_guardrail,
)


@input_guardrail
async def not_empty(
    ctx: RunContextWrapper[None], agent: Agent, user_input
) -> GuardrailFunctionOutput:
    text = user_input if isinstance(user_input, str) else str(user_input)
    return GuardrailFunctionOutput(output_info={"length": len(text)}, tripwire_triggered=False)


billing = Agent(
    name="Billing Specialist",
    instructions="Answer billing questions in one sentence.",
    model="stub-1",
)

triage = Agent(
    name="Triage",
    instructions="Route the user to the right specialist.",
    model="stub-1",
    handoffs=[billing],
    input_guardrails=[not_empty],
)


async def main() -> None:
    result = await Runner.run(triage, "I was charged twice this month.")
    print("GOT:", result.final_output)
    print("LAST AGENT:", result.last_agent.name)


asyncio.run(main())
