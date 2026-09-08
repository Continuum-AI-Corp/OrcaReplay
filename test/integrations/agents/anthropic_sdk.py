"""The Anthropic SDK with no base_url, so ANTHROPIC_BASE_URL has to reach it."""

from anthropic import Anthropic

client = Anthropic()
print("base_url:", client.base_url)
reply = client.messages.create(
    model="claude-stub", max_tokens=64, messages=[{"role": "user", "content": "hello"}]
)
print("GOT:", reply.content[0].text)
