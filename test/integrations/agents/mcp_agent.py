"""An agent that talks to a model *and* to an MCP server it launches from a config file.

Both halves on purpose. The model call is what every other check asserts and what makes the
exchange counts comparable; the MCP session is the half no other check covers at all.

It reads the config rather than building `StdioServerParameters` in code, because that is the shape
orca can instrument — it rewrites the config to put its shim between client and server. A client
that constructs the parameters itself leaves orca nothing to rewrite, and the session is then
invisible to every capture layer: the transport is OS pipes, so the proxy never sees it, and
`mcp.client.stdio` spawns in list form rather than through a shell, so the PATH shim never fires.
That gap is real and is not what this check covers.
"""

import asyncio
import json
import os

from mcp import ClientSession, StdioServerParameters, stdio_client
from openai import OpenAI


async def main() -> None:
    with open(os.environ["MCP_CONFIG_PATH"], encoding="utf8") as fh:
        config = json.load(fh)
    name, entry = next(iter(config["mcpServers"].items()))
    params = StdioServerParameters(
        command=entry["command"], args=entry.get("args", []), env=entry.get("env")
    )

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print("TOOLS:", [t.name for t in tools.tools])
            result = await session.call_tool("lookup", {"key": "alpha"})
            print("MCP:", result.content[0].text)

    reply = OpenAI().chat.completions.create(
        model="stub-1", messages=[{"role": "user", "content": "hello"}]
    )
    print("GOT:", reply.choices[0].message.content)


asyncio.run(main())
