# Contributing to OrcaReplay

## The five-minute dev loop

```console
git clone https://github.com/Continuum-AI-Corp/OrcaReplay
cd OrcaReplay
npm install
npm run check     # format check + typecheck + tests
```

`npm run check` is the fast loop — format check, typecheck, tests — and it is the first CI job, but
it is not all of CI. Three more jobs run commands `check` does not:

```console
node scripts/conformance.mjs      # the shipped example traces and a freshly written one both
                                  # validate against the normative schema
node scripts/check-neutrality.mjs # no vendor plugin reaches past @orcareplay/plugin-api
pip install ./python[dev] && python -m pytest python/ -q   # the Python SDK
```

`conformance.mjs` reads `packages/*/dist`, so run it after a build — `npm run check` has already
done one by the time you get there.

Run those four and CI has nothing left to tell you, with one caveat it cannot: the `check` job runs
on node 20 as well as 22, so a 22-only API passes locally and fails there.

**Contributing needs a newer node than using.** The published CLI runs on node 20.0 and its
`engines` says so; the *test toolchain* does not, because vitest pulls a vite that wants
`^20.19.0 || >=22.12.0`. The root `package.json` declares that range, so `npm ci` tells you up front
instead of letting the mismatch surface later as something stranger. Nobody running `orca` is
affected.

Working on one package:

```console
npx vitest run packages/core      # one package
npx vitest                        # watch mode, everything
npx tsc --build                   # typecheck the project graph
```

If that took longer than five minutes on a clean machine, that is a bug — please open an issue
saying where it stalled. Time-to-first-contribution is a metric we actually track.

## Tests come first

This project is built test-first, and not as a slogan: the payload schema, the checkpoint snapping
rules and the redactor all had real bugs caught by a test written before the implementation.

Write the failing test, run it, confirm it fails **for the reason you expect**, then implement.
A test that has never been red has not proven anything.

## What we are looking for

The highest-value contributions, in order:

1. **Adapters** — support for an agent harness we do not cover. `packages/adapters/` has the
   pattern; the interface is two methods.
2. **Providers** — a model API we cannot fork onto. `packages/providers/` has two examples.
3. **Redaction rules** — a secret shape we fail to catch. These are small, self-contained, and
   they protect everyone.
4. **Trace analyzers** — anything that reads a trace and finds something useful. The loop detector
   in `packages/viewer/src/render.ts` is the model: about forty lines, no privileged access.

## Rules of the road

- **No new runtime dependencies** without discussion. The CLI has none beyond a JSON Schema
  validator, and a debugger you install to diagnose a broken environment should not drag in a
  hundred packages. `devDependencies` are easier, but still argue for them.
- **The spec is normative.** `spec/orca-trace-v0.md` and the JSON Schema come first; TypeScript
  types are verified against them. If you need a format change, change the spec in the same PR and
  bump the schema version. Adding an event type is a MINOR bump; changing one is MAJOR.
- **Readers skip what they do not understand.** Never make an unknown event type an error.
- **Replay never silently approximates.** If a match is inexact, emit a `divergence` event. A
  debugger that quietly guesses is worse than no debugger, because you will believe it.
- **Secrets never reach disk or a TTY.** Redaction lives in the write path. If you add a new sink,
  it goes through the redactor.

## Sign your commits

We use the [Developer Certificate of Origin](https://developercertificate.org/). Add a `Signed-off-by`
line with `git commit -s`. There is no CLA and no copyright assignment.

**This one is honour-system.** No CI job checks for the trailer and no bot will ask you for it, so a
PR without one is not blocked — we would rather tell you that than have you discover it from a
green tick. If we ever start enforcing it, it will be a check you can see, not a surprise on merge.

## Code of conduct

By participating you agree to the [Contributor Covenant](CODE_OF_CONDUCT.md).
