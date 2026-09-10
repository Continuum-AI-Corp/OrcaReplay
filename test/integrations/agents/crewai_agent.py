"""CrewAI itself — a real Agent, Task and Crew.

Not a duplicate of `litellm_agent.py`, and since CrewAI 1.x not even the same route. CrewAI moved
LiteLLM to an optional extra (`crewai[litellm]`) and grew native providers, so a default install
reaches OpenAI through its own `crewai.llms.providers.openai.completion` and never loads LiteLLM at
all. Covering the layer underneath stopped covering CrewAI the moment that happened, and only
running CrewAI itself would have noticed.

Two things this pins that the LiteLLM route cannot:

  - the native provider reads `OPENAI_API_BASE` *and* `OPENAI_BASE_URL`, both of which
    `generic-openai` sets — so the capture survived the change even though the reason for it did not
  - a bare model name is what the native provider takes. `LLM(model="openai/stub-1")` is the
    LiteLLM spelling and now raises `ImportError` on a default install, which is the shape of
    breakage a CrewAI user upgrading from 0.x will hit
"""

import os

# Before importing crewai: telemetry is wired up at import time, and a run that phones home is doing
# something this check did not ask for. Not orca's business to capture — it is not model traffic —
# but a reader deciding whether a recording is complete should know the connection exists.
os.environ["CREWAI_DISABLE_TELEMETRY"] = "true"
os.environ["OTEL_SDK_DISABLED"] = "true"

from crewai import Agent, Crew, LLM, Process, Task  # noqa: E402

# Bare, not `openai/…`. See the note above: the prefixed form is LiteLLM's and no longer resolves.
llm = LLM(model="stub-1")

agent = Agent(
    role="Responder",
    goal="Answer the question you are given",
    backstory="You answer in one short sentence.",
    llm=llm,
    verbose=False,
)

task = Task(description="Say hello.", expected_output="A short greeting.", agent=agent)

crew = Crew(agents=[agent], tasks=[task], process=Process.sequential, verbose=False)
result = crew.kickoff()
print("GOT:", str(result).strip())
