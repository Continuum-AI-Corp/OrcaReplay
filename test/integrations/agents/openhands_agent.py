"""The OpenHands SDK's own LLM layer.

The LiteLLM check already covers the transport OpenHands rides on, so this exists for the part
that check cannot speak to: whether the SDK *reaches* LiteLLM with the environment intact. It
wraps LiteLLM in its own `LLM` model with retries, usage tracking and a telemetry layer, and any
of those could have pinned an origin of its own.

Deliberately one `completion()` and no `Conversation`: a workspace and a task loop would be
testing OpenHands, not testing whether orca can see it.
"""

import os

from openhands.sdk import LLM
from openhands.sdk.llm import Message, TextContent
from pydantic import SecretStr

# Read from the environment, never passed in code. That is the route `orca record` sets up, and
# CrewAI's known wrinkle — `base_url=` in code silently not reaching LiteLLM — is the reason to
# prove the environment route specifically.
base = os.environ.get("OPENAI_API_BASE") or os.environ["OPENAI_BASE_URL"]

llm = LLM(
    model="openai/stub-1",
    base_url=base,
    api_key=SecretStr(os.environ.get("OPENAI_API_KEY", "stub")),
    usage_id="orca-integration-check",
    num_retries=1,
)

reply = llm.completion(
    messages=[Message(role="user", content=[TextContent(text="hello")])]
)
print("GOT:", reply.message.content[0].text)
