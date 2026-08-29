---
name: Bug report
about: Something recorded, replayed or forked incorrectly
labels: bug
---

## What happened

## What you expected

## Attach a trace

The fastest way to get this fixed is a trace we can replay:

```console
orca export --html last -o bug.html   # single self-contained file
```

`orca export` prints exactly what it is about to write. Run `orca scrub last` first if you want a
second pass over anything sensitive — and please skim the file before attaching it. A trace can
contain file contents and shell output.

## Environment

- `orca --version`:
- Agent and version:
- OS and Node version:
