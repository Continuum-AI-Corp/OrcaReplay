# My agent broke something. How do I find out why?

You ran a coding agent, it changed files, tests fail, and the terminal has scrolled. Re-running
gives you a different failure. This is the situation OrcaReplay exists for.

## 1. Record the run

```console
orca record claude
```

Your agent runs normally. Nothing about it is patched — it is started with a couple of environment
variables pointing its model traffic at a local proxy, and that is the whole trick.

When it finishes (or you `^C` it), you get a run id.

## 2. Look at what happened, in order

```console
orca show last
```

```
run_9f2c14a03b71  claude-code@0.1.0  21 events  exit 0

SEQ  KIND   WHAT                                           DETAIL
0    RUN    run started                                    claude-code
1    SNAP   tree 6b1f0c9d2e4a8c53d1b0f7a2c96e4d38b5170ae9  0 changed
2    MODEL  claude-opus-5                                  1 messages
3    MODEL  claude-opus-5                                  stop: tool_use · 8,412 in · 214 out
4    TOOL   edit_file                                      {"path":"src/auth.ts","content":"const ok = true;\n"}
5    SNAP   tree dc61276f6baa4b3986276ae9ace6df230399788e  1 changed
6    FILE   src/auth.ts                                    modified +14 −3
7    TOOL   edit_file                                      ok
8    MODEL  claude-opus-5                                  3 messages
9    MODEL  claude-opus-5                                  stop: tool_use · 8,655 in · 190 out
10   TOOL   run_tests                                      {"suite":"auth"}
11   SNAP   tree dc61276f6baa4b3986276ae9ace6df230399788e  0 changed
12   TOOL   run_tests                                      ok
13   MODEL  claude-opus-5                                  5 messages
14   MODEL  claude-opus-5                                  stop: end_turn · 8,901 in · 62 out
15   SNAP   tree dc61276f6baa4b3986276ae9ace6df230399788e  0 changed
16   SHELL  ["sh","-c","npm test -- auth"]                 /home/you/project
17   SHELL  shell result                                   exit 1 · 8.4s
18   SHELL  ["sh","-c","npm test -- auth"]                 /home/you/project
19   SHELL  shell result                                   exit 1 · 8.2s
20   RUN    run ended                                      exit 0

warn loop.detected turns=1,2,3 tree=dc61276f

info usage input=22968 output=466 cost=$0.1099
```

Three things about reading that are worth knowing up front, because each of them has misled
somebody.

**The failure is in the `SHELL` rows.** There is no `ERROR` row, here or in any recording: the
format reserves an `error` event type but nothing in the recorder emits one. A command that failed
appears as a `shell.result` with a non-zero exit code — which is precisely the fact the model never
gets, since the harness hands it a rendering of the output one turn later.

**`ok` on a `TOOL` row means the result came back, not that it worked.** The tool layer is
reconstructed from the protocol and does record whether the harness flagged the result as an error,
but the timeline does not surface that flag today. Read the shell rows for verdicts, not the tool
rows.

**The `SHELL` rows sit at the end even though they ran in the middle.** The `PATH` shim writes its
frames to a file, and the recorder drains that file once the agent has exited — so shell events are
appended last and carry the highest `seq`. Their `ts` and `mono_us` are the real moments they
happened, so anything sorting by time puts them back where they belong, but `orca show` and the
viewer both list a trace in `seq` order, which is append order. Line 17 happened between turns 2
and 3, not after the run.

## Did it go in circles?

That is the `warn loop.detected` line under the table. It is not an event in the trace: loop
detection is an analyzer that runs when the trace is *read*, so it will appear against a run
recorded before the detector existed, and it costs the recorder nothing.

```
warn loop.detected turns=1,2,3 tree=dc61276f
```

Three or more consecutive snapshot-bearing turns ending on the same workspace tree — the agent kept
working and the files stopped moving. Above, the edit on turn 1 landed and then nothing changed
while the tests were re-run twice.

`detectLoops` in `packages/viewer/src/render.ts` is about forty lines and reads nothing but the
public format, which is the point: it is the model to copy for an analyzer of your own.

The only `note` events a recording contains are the two `orca record` writes itself —
`fs_snapshot_skipped`, when a workspace snapshot failed and that turn has no checkpoint, and
`unresolved_tool_calls`, when the run ended with a tool call whose result never came back.

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
