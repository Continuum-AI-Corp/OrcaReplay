# Why did my agent delete that file?

A file is gone, or truncated, or full of something you did not ask for. You want to know which
turn did it and what the agent was reasoning about at the time.

## Find the turn that touched it

Every recorded run snapshots the workspace once per turn, so filesystem changes are attributable.

```console
orca show last | grep auth.ts
```

Or straight from the trace, with no OrcaReplay code involved:

```console
jq 'select(.type == "fs.change" and .attrs.path == "src/auth.ts")' .orca/runs/*/events.jsonl
```

```json
{ "seq": 15, "turn": 3, "type": "fs.change",
  "attrs": { "path": "src/auth.ts", "status": "deleted", "insertions": 0, "deletions": 214 } }
```

## Read what the agent was doing at that moment

`causes` links events into a chain, so you can walk backwards from the deletion to the tool call
that made it and the model response that asked for it:

```console
orca replay last --ui
```

Select seq 15. The pane shows the diff; the rows immediately above it are the `tool.call` that
performed the write and the `model.response` that decided on it — including the model's own
reasoning text, verbatim.

## Get the file back

The workspace at every turn is a real git tree in the run's shadow store:

```console
orca checkpoints last          # which turns you can restore from
orca replay last --from 14     # materialises the workspace as it was, in a scratch worktree
```

The fork runs in a temp directory, so your actual workspace is untouched — you can copy the file
out of it.

## Stop it happening again

Fork from just before the deletion and let a different model try:

```console
orca replay last --from 14 --model <another-model>
```

Same files, same conversation up to that point, different model from there. If the second model
does not delete the file, you have a concrete, reproducible case to file against the first.
