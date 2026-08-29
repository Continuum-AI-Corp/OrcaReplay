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

```console
orca replay last --ui
```

Select seq 15. The pane shows the event's own facts — path, status, insertion and deletion counts —
and the rows immediately above it are the same turn's `tool.call` and `model.response`. Select the
`model.response` and you get the raw body it was recorded from, including the model's own reasoning
text, verbatim. That is the sentence you came for.

Two limits to know before you rely on this. The `fs.change` event stores counts, **not a diff** —
there is no patch in the trace, only the tree ids either side of it, so the pane has no `-` lines
to show you. And walking the chain is positional, not linked: `causes` is only populated on
`shell.result`, pointing at its `shell.exec`. An `fs.change` names nothing, so "the rows just above
it, in the same turn" is the actual relationship, and it is why turn boundaries are worth watching.

## Get the file back

**There is no read-only "materialise this checkpoint" command yet.** Note especially what
`orca replay last --from 14` is *not*: `--from` is a fork. It serves the conversation up to that
checkpoint from the recording and then spawns your real agent to continue **live**, against the
real model API. Reaching for it to recover a file bills you for tokens and turns an agent loose on
a copy of your workspace.

What you have instead is the shadow store, and it is enough. It is an ordinary bare git object
store, so plain git reads it — no OrcaReplay code involved:

```console
orca show last | grep SNAP       # the tree id for each turn, full length
orca checkpoints last            # the same trees, by the seq you could fork from
```

```console
# one file, as it was at that tree
git --git-dir=.orca/runs/<id>/fs cat-file blob <tree>:src/auth.ts > src/auth.ts

# what was in the tree at all
git --git-dir=.orca/runs/<id>/fs ls-tree -r <tree>

# or the whole workspace, into a scratch directory that is not yours
mkdir /tmp/before && git --git-dir=.orca/runs/<id>/fs archive <tree> | tar -x -C /tmp/before
```

Take the tree from the `SNAP` row of the turn **before** the deletion — the snapshot is taken at the
end of a turn, so the turn that deleted the file already has it gone. An abbreviated tree id works,
which is what makes the twelve characters `orca checkpoints` prints usable directly.

The objects are dangling on purpose: snapshots are written with `write-tree` and never committed, so
there are no refs and `git log` in that directory shows nothing. That is also why `orca scrub`
cannot rewrite the store, and why `--drop-fs` — which deletes it — takes this recovery route with
it.

## Stop it happening again

Fork from just before the deletion and let a different model try:

```console
orca replay last --from 14 --model <another-model>
```

Same files, same conversation up to that point, different model from there. If the second model
does not delete the file, you have a concrete, reproducible case to file against the first.

This is the one place spending the tokens is the point. The fork restores the checkpoint tree into
a scratch worktree under the OS temp directory and runs there, so your own checkout is never
touched, and it prints the path it used. The worktree is deliberately left behind — it holds what
the model actually did — until `orca gc` reclaims it along with the fork's run.
