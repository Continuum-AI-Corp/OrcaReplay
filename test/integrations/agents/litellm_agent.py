"""LiteLLM directly — the layer CrewAI, Aider and OpenHands all route through.

Covering it covers them, which is why this file exists instead of three more.
"""

import litellm

reply = litellm.completion(
    model="openai/stub-1", messages=[{"role": "user", "content": "hello"}]
)
print("GOT:", reply.choices[0].message.content)
