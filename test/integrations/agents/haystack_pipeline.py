"""A Haystack pipeline, in the shape their own quickstart uses.

`Pipeline` rather than a bare generator: Haystack's unit of work is the pipeline, and a component
inside one is constructed and run differently from one called directly. The generator is left
without an `api_base_url` on purpose — that is the case orca has to capture, because it is what
every Haystack example writes, and it means the origin comes from the environment through the
OpenAI SDK rather than from the pipeline's own code.
"""

from haystack import Pipeline
from haystack.components.builders import ChatPromptBuilder
from haystack.components.generators.chat import OpenAIChatGenerator
from haystack.dataclasses import ChatMessage

pipeline = Pipeline()
pipeline.add_component(
    "prompt",
    ChatPromptBuilder(
        template=[ChatMessage.from_user("Answer in one word: what is the weather in {{city}}?")],
        required_variables=["city"],
    ),
)
# No api_base_url: the client reads OPENAI_BASE_URL, which is the variable `generic-openai` sets.
pipeline.add_component("llm", OpenAIChatGenerator(model="stub-1"))
pipeline.connect("prompt.prompt", "llm.messages")

result = pipeline.run({"prompt": {"city": "Paris"}})
print("GOT:", result["llm"]["replies"][0].text)
