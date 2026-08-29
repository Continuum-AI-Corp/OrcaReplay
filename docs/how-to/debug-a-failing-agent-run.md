# My agent broke something. How do I find out why?

You ran a coding agent, it changed files, tests fail, and the terminal has scrolled. Re-running
gives you a different failure. This is the situation OrcaReplay exists for.

## 1. Record the run

```console
npx orcareplay record claude
```

Your agent runs normally. Nothing about it is patched — it is started with a couple of environment
variables pointing its model traffic at a local proxy, and that is the whole trick.

When it finishes (or you `^C` it), you get a run id.

## 2. Look at what happened, in order

```console
orca show last
```

```
SEQ  KIND   WHAT                    DETAIL
12   MODEL  claude-opus-5           8,412 in · 214 out
13   FILE   src/auth.ts
14   TOOL   grep
15   SHELL  npm test -- auth        exit 1 · 8,412ms
16   ERROR  test_failure            1 failed, 13 passed
17   MODEL  claude-opus-5           retry
```

Two things are usually visible immediately: **where the error first appears**, and whether the
agent then went in circles. A `note` event with `rule=identical_tree_across_turns` means three
consecutive turns left the workspace byte-identical — the agent was retrying without changing
anything.

## 3. Open the timeline

```console
orca replay last --ui
```

Click a step to see exactly what went in and what came out — the request, the tool result, the
diff. Press <kbd>space</kbd> to play the run back at the speed it actually happened, which is the
fastest way to feel where it stalled.

## 4. Reproduce it exactly

```console
orca replay last
```

Every model response is served from the trace and the network is blocked. If it reproduces, you
have a deterministic loop to work in. If it *doesn't*, OrcaReplay tells you where it diverged
rather than pretending — that divergence is usually itself the answer.

## What if replay reports divergences?

An agent harness is not deterministic: generated ids, timestamps, context compaction firing at a
different point. A `minor` divergence is normal. A `major` one means the conversation prefix
differed — usually compaction — and is worth reading.

If replay halts with `does not match the recording`, the agent asked something the recording never
saw. `orca replay last --loose` continues live from that point.

## Next

- [Why did my agent delete that file?](why-did-my-agent-delete-my-file.md)
- [Would a different model have got this right?](compare-models-on-the-same-failure.md)
