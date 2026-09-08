"""`AsyncOpenAI`, which is what the OpenAI Agents SDK builds on."""

import asyncio

from openai import AsyncOpenAI


async def main() -> None:
    client = AsyncOpenAI()
    print("base_url:", client.base_url)
    reply = await client.chat.completions.create(
        model="stub-1", messages=[{"role": "user", "content": "hello"}]
    )
    print("GOT:", reply.choices[0].message.content)


asyncio.run(main())
