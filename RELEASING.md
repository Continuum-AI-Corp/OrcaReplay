# Releasing

Publishing is irreversible in the way that matters: npm allows an unpublish only briefly, and never
lets the same version be published twice. So the whole thing is one gated workflow rather than a
sequence of `npm publish` calls run by hand at the end of a long day.

## Once, before the first release

- An **`NPM_TOKEN`** repository secret, from an npm account that owns the `orcareplay` name and the
  `@orcareplay` scope. An automation token, not a personal one.
- **Actions enabled** for the repository, and Actions billing active on the org.

## Every release

```console
npm version 0.2.0 --workspaces --include-workspace-root --no-git-tag-version
node scripts/publish-order.mjs      # sanity: prints the order, fails if versions disagree
npm ci && npm run check             # what the workflow will run anyway, but faster to find here
git commit -am "release 0.2.0" && git tag v0.2.0 && git push --follow-tags
```

The tag fires `.github/workflows/release.yml`, which:

1. runs the full gate — format, build, 1000+ tests, conformance, neutrality;
2. checks the tag matches `packages/cli`'s version, so a published version always has a tag
   pointing at it;
3. publishes every workspace **in dependency order**, with npm provenance.

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
