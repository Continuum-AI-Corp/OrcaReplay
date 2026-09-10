"""Which model names CrewAI 1.x resolves, and which it refuses.

Not a recording check — nothing here talks to a model. It pins a claim the docs make, because that
claim was wrong once already: `docs/integrations.md` said a prefixed model name "no longer resolves"
on CrewAI 1.x, and `openai/gpt-4o-mini` resolves perfectly well. The measurement behind the claim had
used `openai/stub-1`, and what actually failed was `stub-1`, a name no known-model list contains.

The distinction matters here more than it would elsewhere: pointing an agent at a gateway usually
means naming a model the vendor never published, which is exactly the case the two forms treat
differently.

Run directly; it prints one line per case and exits non-zero if any disagrees.
"""

from crewai import LLM

# (spec, should_resolve)
CASES = [
    # A bare name always reaches the native provider, recognised or not.
    ("gpt-4o-mini", True),
    ("o3-mini", True),
    ("my-gateway-model", True),
    ("stub-1", True),
    # A prefixed name is checked against a known-model list first.
    ("openai/gpt-4o-mini", True),
    ("openai/o3-mini", True),
    ("openai/my-gateway-model", False),
    ("openai/stub-1", False),
    # An unknown prefix has nowhere to fall through to on a default install.
    ("foo/gpt-4o-mini", False),
]

failures = []
for spec, should_resolve in CASES:
    try:
        LLM(model=spec)
        resolved = True
    except Exception:  # noqa: BLE001 - any failure to construct is a refusal
        resolved = False
    ok = resolved == should_resolve
    print(f"  {spec:28} {'resolves' if resolved else 'refused':9} {'ok' if ok else 'UNEXPECTED'}")
    if not ok:
        failures.append(spec)

if failures:
    raise SystemExit(f"CrewAI resolved these differently than documented: {', '.join(failures)}")
print("GOT: every case matches what docs/integrations.md says")
