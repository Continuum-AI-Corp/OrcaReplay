# Releasing

Publishing is irreversible in the way that matters: npm allows an unpublish only briefly, and never
lets the same version be published twice. So the whole thing is one gated workflow rather than a
sequence of `npm publish` calls run by hand at the end of a long day.

## Once, before the first release

- An **`NPM_TOKEN`** repository secret, from an npm account that owns the `orcareplay` name and the
  `@orcareplay` scope. An automation token, not a personal one.
- **Actions enabled** for the repository, and Actions billing active on the org.

## Two channels

| | what it is | who gets it |
| --- | --- | --- |
| `latest` | a version someone decided to release | `npm i orcareplay` |
| `next` | every green commit on main, as `0.2.4-main.<sha>` | `npm i orcareplay@next` |

`next` is published by `.github/workflows/publish-next.yml` after CI passes on main, and needs
nothing from you. Every version on it is a **prerelease**, which npm excludes from
`npm i orcareplay` even though `0.2.4-main.abc1234` sorts above `0.2.3` — so main is always
installable and nobody is opted in to it by accident. `--tag next` never moves `latest`.

That is what keeps the rest of this page short: releasing is no longer the only way to get main
into someone's hands, so it can stay deliberate.

## Every release

A release is a pull request that changes a version number. Merging it publishes `latest` and
creates the tag.

```console
node scripts/set-version.mjs 0.3.0 --lock   # 13 manifests, every internal pin, and the lockfile
node scripts/publish-order.mjs              # sanity: prints the order, fails if versions disagree
npm run check                               # what the workflow runs anyway, faster to find here
git commit -am "release 0.3.0" && git push  # open a PR, merge it
```

Merging that into main fires `.github/workflows/release.yml`, which sees a version with no tag,
runs the full gate, publishes, and creates `v0.3.0` itself. Nothing else lands a release: every
other merge leaves the version alone, and the workflow's `decide` job costs seconds to say so.

A `v*` tag pushed by hand still works and does the same thing, for a release made from somewhere
other than main.

> **Why there is a script for what looks like one edit.** Twelve packages name each other by exact
> version, so a bump is thirty-eight fields across thirteen manifests — and `npm version
> --workspaces` moves each package's own `version` while leaving its dependants naming the previous
> release. Publish that and `orcareplay@0.3.0` depends on `@orcareplay/core@0.2.0`, which npm will
> never let you replace.
>
> **And why `--lock` rather than `npm version`.** When a workspace sits at the new version and its
> dependants still name the old one, npm stops treating them as satisfiable workspace links and
> resolves the *published* old version instead, into `packages/<name>/node_modules/`. Those copies
> shadow the source, `tsc` then checks the CLI against last release's `.d.ts`, and the errors it
> reports name symbols that plainly do exist. `npm version` writes `package-lock.json` itself at
> exactly that moment, so the bad resolution is recorded before the pins can be fixed — 0.2.1
> shipped with correct manifests and two poisoned lockfile entries, and every later `npm ci`
> honoured them. `set-version.mjs` moves the pins first and reconciles the lockfile after, so the
> window does not exist.
>
> Both halves are still checked rather than trusted: `publish-order.mjs` catches a manifest
> mismatch, and `scripts/set-version.test.ts` asserts the committed lockfile links every
> `@orcareplay/*` instead of fetching it. The manifests can be perfectly consistent while the
> lockfile is not.

> **The registry step waits for npm, and has to.** The MCP Registry validates that the npm version
> it is being told about exists, and npm's own publish output says a tarball "may take a few minutes
> to become available". 0.2.3 published at `:06` and the registry call ran three seconds later, got
> a 404 for the version that had just gone out, and failed the release — after npm had succeeded, so
> re-running the whole workflow was not an option. The step now polls `npm view` for up to five
> minutes before publishing. `registry-only` exists for the case where it still needs a retry.

`.github/workflows/release.yml`, however it was triggered:

1. decides whether there is anything to release — from main, a version that already has a tag is
   not one, which is what makes an ordinary merge cost seconds instead of the whole suite;
2. runs the full gate — format, build, 1000+ tests, conformance, neutrality;
3. for a `v*` tag, checks it matches `packages/cli`'s version, so a published version always has a
   tag pointing at it;
4. publishes every workspace **in dependency order**, with npm provenance;
5. creates the tag, when the release came from main — *after* the publish, so a tag means "this
   went out" rather than "this was attempted", and so the next merge does not try again.

Both publishing workflows are `concurrency`-grouped and queue rather than cancel. The publish loop
walks twelve packages one at a time, and a run cancelled half way leaves some of them on the
registry at a version the rest do not name — which is the one state npm will not let anyone fix.

To rehearse without sending anything: **Actions → Release → Run workflow**, leaving *dry run*
checked. It packs and validates every tarball and publishes nothing.

## Why order matters

Internal dependencies are pinned to an exact version — `"@orcareplay/core": "0.1.0"`, never `"*"`.
A `*` resolves to whatever is latest on the registry, so a 0.1.0 CLI would silently pull a 0.9.0
core, and on the very first publish it cannot resolve at all because nothing exists yet.

The cost of pinning is that the CLI cannot be published before the core it names. `scripts/publish-order.mjs`
topologically sorts the workspaces so that order is computed from the manifests rather than written
down somewhere that quietly goes stale — and it exits non-zero if two packages disagree about a
version, or if the dependency graph has a cycle.

## Verifying a release actually works

The end-to-end check that matters is not "did npm accept it" but "does a fresh install run":

```console
npm pack --workspaces --pack-destination /tmp/tarballs
mkdir /tmp/verify && cd /tmp/verify && npm init -y
npm i /tmp/tarballs/*.tgz
./node_modules/.bin/orca doctor       # both shims must report ok — they run out of dist/
```

That last line is the one worth keeping. The MCP shim was resolved through a path that only worked
inside the monorepo for the whole of v0's development; nothing caught it until a packaged install
was actually run.
