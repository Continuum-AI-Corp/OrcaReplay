"""An MCP server over stdio, for the check that records one and then takes it away.

Deliberately trivial and deliberately deterministic: the point of the check is the transport and
the replay, not the tool. `lookup` answers from its argument so a replay that served the wrong
recorded frame is visible in the output rather than only in a count.
"""

from mcp.server.fastmcp import FastMCP

app = FastMCP("orca-check")


@app.tool()
def lookup(key: str) -> str:
    """Return a canned value for a key."""
    return f"VALUE-FOR-{key}"


if __name__ == "__main__":
    app.run()
