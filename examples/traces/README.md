# Example traces

Real-shaped traces, checked into the repo on purpose. They do four jobs at once:

1. **Documentation.** The fastest way to understand the format is to read one.
2. **Contributor fixtures.** Everything here works against these on day one, no recording needed.
3. **Conformance input.** `scripts/conformance.mjs` validates each against the normative schema in
   CI — that is what makes v0 a format others can target rather than whatever our writer emits.
   The same job also validates a trace the writer produces on the spot, so "the format" and "our
   implementation of it" are checked separately rather than one standing in for the other.
4. **Evaluation.** Anyone can inspect the project without installing it.

**These are hand-written**, and that is the point of job 1 and job 3 — a fixture our own writer
produced could not demonstrate that someone else's implementation is possible. It does mean they
are ahead of the recorder in places: `run_9f2c14a03b71` contains `error` and `checkpoint` events,
and a populated `manifest.git`, and v0 emits none of the first two (checkpoints are *derived* at
read time per spec §3, never recorded). Treat the examples as what the format allows, not as a
transcript of what `orca record` produces today. The conformance run prints which declared event
types no shipped trace exercises, so the gap stays visible instead of drifting.

## `run_9f2c14a03b71`

A coding agent chasing a failing auth test. It reads `src/auth.ts`, greps for `JWT`, makes a
correct-looking edit at turn 3, runs the tests, and fails — then repeats the same edit for two more
turns without changing the tree, which the `note` event at seq 26 flags as a loop.

The interesting part is seq 18: the `checkpoint`. Everything before it is identical no matter which
model you hand the rest of the run to, which is exactly what makes
`orca replay --from 18 --model <other>` a controlled experiment rather than an anecdote.

Poke at it with nothing but `jq`:

```console
# what did each turn do?
jq -r '"\(.seq)\t\(.type)\t\(.attrs.path // .attrs.name // .attrs.model // "")"' events.jsonl

# where did it go wrong?
jq 'select(.type == "error")' events.jsonl

# what did the whole thing cost in tokens?
jq -s 'map(.attrs.input_tokens // 0) | add' events.jsonl
```

That those questions are answerable without any OrcaReplay code is the point of the format.
