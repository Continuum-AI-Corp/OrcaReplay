# What a real agent found

Everything in OrcaReplay `v0` was built against fixtures. Fixtures are written by the person who
writes the code, so they encode what that person already believed — which is why the first run
recorded through it against a *real* harness is worth writing down rather than quietly fixing.

That run was Claude Code, fixing a real bug in a real repository: recorded, replayed offline end to
end, forked from a checkpoint, and exported. It broke four things, each of a kind no fixture can
produce. All four are fixed; each entry says what the fix was, because "we found bugs and fixed
them" is not information.

## A sixteen-character drift scored 217,568

Distance was the common prefix and suffix of the whole request body, and Claude Code carries a
session id in its system prompt *and* another in a tool description — so all 200 KB between them
counted as changed and nothing could reach rung 2 of the matching ladder.

Distance is now summed per field, and per line within a field.

## Redaction made an exact match unreachable

Placeholder digests are salted per run by design, so a recorded request could never equal itself
again.

The matcher now redacts the incoming request the same way and compares the *kind* of secret rather
than its digest — and reports that fold, because it is an approximation and a replay must not
approximate silently.

## Redaction also broke every fork

`tool_use` ids and thinking-block signatures are high-entropy strings, so the sweep replaced them.
A fork replays those turns, the agent echoes the placeholders back, and the API answers `400`.

Protocol values that have to round-trip are now exempt from the entropy guess — never from the
credential rules, which is the distinction that makes the exemption safe.

## Replaying re-runs the tools

Orca does not intercept tool execution, so the agent really runs `npm test` again and it really
reprints its own durations.

A request whose only difference is inside tool output is now served from the recording as a `major`
divergence instead of halting the replay.

## Where that left it

The run replays offline end to end — `reused=7/7 exact=2 divergences=5 unmatched=0 exit=0` — with
every approximation named, and a fork of it reaches the same tree the recording did.

**If you have a recording orca still gets wrong, that is the single most useful thing you can
send.** `orca export last -o bug.html` writes one self-contained file, and `orca scrub` is there for
anything you need out of it first.
