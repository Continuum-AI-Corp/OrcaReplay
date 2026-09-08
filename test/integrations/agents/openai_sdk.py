"""The official Python SDK with no base_url — the shape every env-var framework reduces to."""

from openai import OpenAI

client = OpenAI()
print("base_url:", client.base_url)
reply = client.chat.completions.create(
    model="stub-1", messages=[{"role": "user", "content": "hello"}]
)
print("GOT:", reply.choices[0].message.content)
