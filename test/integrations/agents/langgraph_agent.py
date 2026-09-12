"""A two-node LangGraph, in the two shapes people actually write.

`stream` and `tools` rather than a plain completion: SSE has to be parsed and re-emitted, and a
tool call round-trips a structured payload through the trace. Those are the two places a recording
proxy is most likely to break.
"""

import sys
from typing import Annotated, TypedDict

from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

MODE = sys.argv[1] if len(sys.argv) > 1 else "stream"


class State(TypedDict):
    messages: Annotated[list, add_messages]


@tool
def get_weather(city: str) -> str:
    """Look up the weather in a city."""
    return f"it is sunny in {city}"


llm = (
    ChatOpenAI(model="stub-1").bind_tools([get_weather])
    if MODE == "tools"
    else ChatOpenAI(model="stub-1", streaming=True)
)


def first(state: State):
    return {"messages": [llm.invoke(state["messages"])]}


def second(state: State):
    return {"messages": [llm.invoke(state["messages"] + [HumanMessage("again")])]}


graph = StateGraph(State)
graph.add_node("first", first)
graph.add_node("second", second)
graph.add_edge(START, "first")
graph.add_edge("first", "second")
graph.add_edge("second", END)

out = graph.compile().invoke({"messages": [HumanMessage("what is the weather in Paris")]})
print("TURNS:", len(out["messages"]))
print("GOT:", out["messages"][-1].content or "(tool call)")
