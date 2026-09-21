"""A TypeSafe System One call, which is a model API of a shape orca had never met.

Jev answers typed propositions with calibrated probabilities rather than text, so none of the
dialects apply: there is no conversation, no messages array and nothing to fork onto another model.
What it *is* is a stateless function from a request to an answer, which is the shape orca already
replays by key — the same one embeddings and rerank use.

Nothing here says where the API lives. `TypeSafeClient()` reads `TYPESAFE_BASE_URL`, which is the
variable `generic-openai` sets, so the call reaches the proxy without the script knowing.
"""

from typesafe_sdk import Choice, Noul, TypeSafeClient

with TypeSafeClient() as client:
    response = client.system_one(
        state="Help! My payouts have been failing for 3 days.",
        questions={
            "is_urgent": Noul(
                instructions="Does this convey urgency?",
                criteria={"true": "Explicitly time-sensitive", "false": "No urgency expressed"},
            ),
            "team": Choice(
                instructions="Which team should take this?",
                criteria={"billing": "Money movement", "auth": "Sign-in"},
            ),
        },
    )

print("GOT:", response.answers["is_urgent"].noul, response.answers["team"].choice)
