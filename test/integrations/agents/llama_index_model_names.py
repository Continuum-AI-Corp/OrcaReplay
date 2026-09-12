"""Which model names LlamaIndex's OpenAI LLM accepts, and when it decides.

Not a recording check — nothing here talks to a model. It pins a claim `docs/integrations.md`
makes, for the same reason the CrewAI one exists: a sentence about model names in someone else's
library is exactly the kind of thing that is true when written and false two releases later, and
we have already shipped that mistake once.

The claim: LlamaIndex validates the model name against a list compiled into
`llama_index.llms.openai.utils`, and refuses anything outside it *before any request is made*. So
a name your gateway understands but OpenAI never published — the usual case when pointing
LlamaIndex at a proxy, a local model, or an internal router — does not work, and no orca setting
changes that, because nothing has reached the wire yet.

Where it raises matters as much as that it raises. The check is not in the constructor: `OpenAI(...)`
returns fine, and the ValueError arrives from `openai_modelname_to_contextsize` when `.metadata` is
first read, which the chat path does on every call. A user therefore sees it at the first message
rather than at setup, and there is no `context_window` argument to supply instead — asserted below,
because if LlamaIndex adds one, that becomes the recommended workaround and the docs should say so.
"""

from llama_index.core.llms import ChatMessage
from llama_index.llms.openai import OpenAI

# Names from LlamaIndex's own list. These must keep working or the integration check is wrong too.
KNOWN = ["gpt-4o-mini", "gpt-4.1-mini"]

# What a gateway or a local model is actually called. None of these is in any OpenAI list.
UNKNOWN = ["stub-1", "my-gateway-model", "llama-3.1-70b"]


def accepts(name: str) -> tuple[bool, str]:
    """Construct and read metadata, which is what the chat path does before sending anything."""
    try:
        llm = OpenAI(model=name, api_key="unused")
        llm.metadata  # noqa: B018 - reading it is the operation under test
        return True, ""
    except Exception as exc:  # noqa: BLE001 - any refusal counts
        return False, type(exc).__name__


failures = []

for name in KNOWN:
    ok, why = accepts(name)
    print(f"  {name:22} {'accepted' if ok else 'refused':9} {'ok' if ok else 'UNEXPECTED ' + why}")
    if not ok:
        failures.append(f"{name} should be accepted")

for name in UNKNOWN:
    ok, why = accepts(name)
    print(f"  {name:22} {'accepted' if ok else 'refused':9} {'UNEXPECTED' if ok else 'ok — ' + why}")
    if ok:
        failures.append(f"{name} was accepted; LlamaIndex no longer gates on its own model list")

# The constructor itself must stay permissive, or the sentence above about *where* it raises is
# wrong — and that sentence is the difference between "fails at setup" and "fails at first message".
try:
    OpenAI(model="my-gateway-model", api_key="unused")
except Exception as exc:  # noqa: BLE001
    failures.append(f"the constructor now refuses too ({type(exc).__name__}); the docs describe the old behaviour")

if "context_window" in OpenAI.model_fields:
    failures.append("OpenAI now takes context_window — that is a supported escape hatch and the docs should recommend it")

if failures:
    raise SystemExit("LlamaIndex disagreed with the docs: " + "; ".join(failures))
print("GOT: every case matches what docs/integrations.md says")
