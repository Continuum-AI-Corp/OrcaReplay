# Would a different model have got this right?

The usual way to answer this is to re-run the whole task on another model and squint at the
result. That measures the task setup as much as the model — different starting state, different
conversation, different luck.

Forking answers it properly: **same task, same files, same conversation prefix, one variable.**

## Fork one model

```console
orca checkpoints last
orca replay last --from 17 --model glm-5.3-flash
```

Everything before checkpoint 17 is served from the recording, so it is identical by construction.
From 17 onward the agent runs live on the new model, in a scratch worktree.

## Compare several at once

```console
orca compare last --from 17 \
  --models claude-opus-5,gpt-5.2,glm-5.3-flash,qwen3-coder \
  --verify 'npm test'
```

```
MODEL          VERDICT  TOKENS   COST       WALL   RUN
claude-opus-5  pass     186k     $5.81      312s   run_5140e2
gpt-5.2        pass     215k     $3.42      278s   run_ee55fa
glm-5.3-flash  pass     200k     $0.61      242s   run_85d55e
qwen3-coder    fail     178k     $0.29      191s   run_a71e08
```

**`--verify` matters more than it looks.** Without it, `pass` only means the agent exited without
crashing — not that the task got done. With it, the verdict is the exit code of a command you
chose, run inside that fork's worktree.

Each row is a real child run with its own trace. To see what a model actually did:

```console
orca replay run_a71e08 --ui
```

## Share the result

```console
orca compare last --from 17 --models ... --verify 'npm test' --share result.svg
```

One self-contained SVG, no external references, that renders anywhere. It carries the fork point
and the verify command alongside the numbers, so the comparison cannot be quoted without saying
what it measured.

## The caveat worth stating

An unknown model prices as `—`, never `$0.00`. A confidently wrong cost is worse than an absent
one when it lands in a table someone makes a decision from.
