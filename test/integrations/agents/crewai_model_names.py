"""Which model names CrewAI 1.x resolves, and what decides it.

Not a recording check — nothing here talks to a model. It pins a claim the docs make, and the claim
has now been wrong twice, in two different ways, which is the reason it is pinned rather than
described:

  1. `docs/integrations.md` said a prefixed name "no longer resolves" on CrewAI 1.x. It does:
     `openai/gpt-4o-mini` is fine. The measurement behind that had used `openai/stub-1`, and what
     failed was `stub-1` — a name no known-model list contains.
  2. The correction said a prefixed *unknown* name always raises. It does not: CrewAI falls back to
     LiteLLM for anything its native providers do not claim, so `openai/my-gateway-model` resolves
     wherever LiteLLM is installed. That was measured on a machine whose LiteLLM install was broken
     (`litellm.__file__` was None), and a broken install reads exactly like an absent one to
     `crewai.llm._ensure_litellm()`. CI, where LiteLLM works, disagreed — which is how it surfaced.

So the rule has two halves and the second is conditional. This script asserts the half that always
holds, and the conditional half against whichever way LiteLLM actually is on the machine running it.
"""

from crewai import LLM

# A bare name always reaches the native OpenAI provider, recognised or not. Nothing is conditional
# here — this is the half worth relying on, and the form the docs recommend.
ALWAYS_RESOLVE = ["gpt-4o-mini", "o3-mini", "my-gateway-model", "stub-1"]

# A prefixed name a native provider claims. Also unconditional.
NATIVE_PREFIXED = ["openai/gpt-4o-mini", "openai/o3-mini"]

# A prefixed name no native provider claims. These fall through to LiteLLM, so whether they resolve
# is a fact about the environment rather than about CrewAI.
NEEDS_LITELLM = ["openai/my-gateway-model", "openai/stub-1", "foo/gpt-4o-mini"]


def resolves(spec: str) -> bool:
    try:
        LLM(model=spec)
        return True
    except Exception:  # noqa: BLE001 - any failure to construct is a refusal
        return False


def litellm_usable() -> bool:
    """What `crewai.llm._ensure_litellm()` is really asking: can it be imported *and used*."""
    try:
        import litellm

        return hasattr(litellm, "completion")
    except Exception:  # noqa: BLE001
        return False


have_litellm = litellm_usable()
print(f"  litellm usable: {have_litellm}")

failures = []
for spec in ALWAYS_RESOLVE + NATIVE_PREFIXED:
    got = resolves(spec)
    print(f"  {spec:28} {'resolves' if got else 'refused':9} {'ok' if got else 'UNEXPECTED'}")
    if not got:
        failures.append(f"{spec} should always resolve")

for spec in NEEDS_LITELLM:
    got = resolves(spec)
    ok = got == have_litellm
    note = "via litellm" if have_litellm else "no litellm to fall back to"
    print(f"  {spec:28} {'resolves' if got else 'refused':9} {'ok' if ok else 'UNEXPECTED'}  {note}")
    if not ok:
        failures.append(f"{spec} resolved={got} with litellm usable={have_litellm}")

if failures:
    raise SystemExit("CrewAI disagreed with the docs: " + "; ".join(failures))
print("GOT: every case matches what docs/integrations.md says")
