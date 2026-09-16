"""A graph whose shape the proxy cannot see, for the adapter that reports it.

`langgraph_agent.py` next door proves the traffic is captured. This one is about what the traffic
does not contain, so every node here is chosen for that:

  - `plan` calls the model, and runs an inner runnable that must *not* be reported as a node
  - `validate` calls no model at all, so a proxy has no evidence it ran
  - `route` is a conditional edge, which arrives at the callback looking exactly like a node
  - `answer` calls the model again, in a later superstep

Nothing here imports orcareplay_langgraph. The point of the check is that `orca record` attaches it
to a graph nobody edited.
"""

from typing import Annotated, TypedDict

from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableLambda
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

llm = ChatOpenAI(model="stub-1")


class State(TypedDict):
    messages: Annotated[list, add_messages]
    checked: bool


def plan(state: State):
    # An inner runnable inside a node. It inherits `langgraph_node`, so anything keying off that
    # alone reports it as a second `plan`.
    RunnableLambda(lambda x: x).with_config({"run_name": "INNER-RUNNABLE"}).invoke({})
    return {"messages": [llm.invoke(state["messages"])]}


def validate(state: State):
    """No model call. The whole reason this file exists."""
    return {"checked": True}


def route(state: State):
    return "answer"


def answer(state: State):
    return {"messages": [llm.invoke(state["messages"] + [HumanMessage("again")])]}


graph = StateGraph(State)
graph.add_node("plan", plan)
graph.add_node("validate", validate)
graph.add_node("answer", answer)
graph.add_edge(START, "plan")
graph.add_edge("plan", "validate")
graph.add_conditional_edges("validate", route, {"answer": "answer"})
graph.add_edge("answer", END)

out = graph.compile(name="the_graph").invoke({"messages": [HumanMessage("hello")], "checked": False})
print("TURNS:", len(out["messages"]))
print("GOT:", out["messages"][-1].content or "(tool call)")
