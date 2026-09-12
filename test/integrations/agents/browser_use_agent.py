"""browser-use's LLM layer, without starting a browser.

The question this answers is narrow on purpose: does the origin reach the proxy. `ChatOpenAI` here
declares `base_url: str | httpx.URL | None = None` and passes it through, so an unset value falls
to the official SDK's own `OPENAI_BASE_URL` — which is the whole reason browser-use needs no adapter
and is worth a check rather than a claim.

Driving an actual browser would need Chromium and would test Playwright, not orca.
"""

import asyncio

from browser_use import ChatOpenAI
from browser_use.llm.messages import UserMessage


async def main() -> None:
    llm = ChatOpenAI(model="stub-1")
    print("base_url:", llm.get_client().base_url)
    reply = await llm.ainvoke([UserMessage(content="hello")])
    print("GOT:", reply.completion)


asyncio.run(main())
