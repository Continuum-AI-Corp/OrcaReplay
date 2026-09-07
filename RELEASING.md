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
npm version 0.3.0 --workspaces --include-workspace-root --no-git-tag-version

# `npm version` bumps each package's own version and nothing else: the internal pins
# ("@orcareplay/core": "0.2.0") are left naming the previous release. Move them too,
# before anything installs. By this point the only "0.2.0" left in these files IS a pin.
sed -i 's/"0\.2\.0"/"0.3.0"/g' packages/*/package.json

node scripts/publish-order.mjs      # sanity: prints the order, fails if versions disagree

# `npm version` already rewrote package-lock.json — while the pins were still stale. Throw that
# write away and re-resolve from the last committed lockfile, which is clean.
git checkout package-lock.json
rm -rf node_modules packages/*/node_modules && npm install   # one clean re-resolve
grep -c 'registry.npmjs.org/@orcareplay' package-lock.json   # must be 0: every one is a link
npm run check                       # what the workflow will run anyway, but faster to find here
git commit -am "release 0.3.0"
# -a, not a lightweight tag: `--follow-tags` pushes only annotated ones, and a tag that
# stays local fires nothing.
git tag -a v0.3.0 -m "0.3.0" && git push --follow-tags
```

> **Why both the sed and the `git checkout`.** When a workspace sits at the new version and its
> dependants still name the old one, npm stops treating them as satisfiable workspace links and
> resolves the *published* old version instead, into `packages/<name>/node_modules/`. Those copies
> shadow the source, `tsc` then checks the CLI against last release's `.d.ts`, and the errors it
> reports name symbols that plainly do exist.
>
> The sed alone does not prevent it, because **`npm version` writes `package-lock.json` itself**,
> at the one moment when the versions have moved and the pins have not. So the bad resolution is
> already recorded before you get a chance to fix the pins, and the next `npm install` honours it
> — as does any later `npm ci`. 0.2.1 hit this with correct manifests and two poisoned lockfile
> entries. Discarding npm's write and re-resolving from the committed lockfile is what clears it.
>
> `scripts/publish-order.mjs` catches the manifest mismatch, and the `grep` catches the lockfile
> one; the manifests can be perfectly consistent while the lockfile is not, so check both.

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
