#!/usr/bin/env node
/**
 * Set one version across every workspace, and rewrite the internal pins that name it.
 *
 * Twelve packages depend on each other by *exact* version — `"@orcareplay/core": "0.2.3"`, never a
 * range — for the reason `publish-order.mjs` gives: a range resolves to whatever is latest, so a
 * 0.1.0 CLI would install a 0.9.0 core. The cost is that a version bump is not one edit but
 * thirteen manifests plus every pin inside them, and `npm version --workspaces` does not touch the
 * pins: it moves each package's own `version` and leaves its dependents naming the old one, which
 * `publish-order.mjs` then rejects. Every release so far was therefore a hand-written commit
 * touching thirteen files, which is exactly the kind of thing that goes wrong once and is
 * irreversible on npm.
 *
 *     node scripts/set-version.mjs 0.2.4            # manifests only
 *     node scripts/set-version.mjs 0.2.4 --lock     # and reconcile package-lock.json
 *     node scripts/set-version.mjs 0.2.4 --check    # say what would change, write nothing
 *
 * `--lock` is what a bump you intend to *commit* needs, because `npm ci` fails on a lockfile that
 * disagrees with the manifests. A publish does not read the lockfile, so the release workflows that
 * set a version in the runner and never commit it can skip the slow half.
 *
 * Verified by `scripts/set-version.test.ts`, and by `publish-order.mjs`, which every release runs
 * and which fails loudly if a pin was left behind.
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Accepts a prerelease, because that is what the `next` channel publishes.
 *
 * `0.2.4-main.90fc463` is a legal semver version and npm treats it specially: it is excluded from
 * `npm install <pkg>` even though it sorts above `0.2.3`, so a prerelease cannot reach someone who
 * did not ask for it by name. Build metadata (`+…`) is rejected instead of allowed — npm ignores it
 * when comparing versions, so two builds could differ in the manifest and be the same version to
 * the registry, which is the one failure mode a publish cannot recover from.
 */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** Every workspace manifest, plus the root, which carries a version of its own. */
async function manifests() {
  const found = [join(root, 'package.json')];
  const dir = join(root, 'packages');
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    found.push(join(dir, entry.name, 'package.json'));
  }
  return found;
}

/** The names this repository publishes, so a pin on someone else's package is left alone. */
async function internalNames(paths) {
  const names = new Set();
  for (const path of paths) {
    const pkg = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'));
    if (typeof pkg.name === 'string' && pkg.name.startsWith('@orcareplay/')) names.add(pkg.name);
  }
  return names;
}

async function main() {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith('--'));
  const check = args.includes('--check');
  const lock = args.includes('--lock');

  if (version === undefined) {
    console.error('usage: node scripts/set-version.mjs <version> [--lock] [--check]');
    process.exit(2);
  }
  if (!VERSION.test(version)) {
    console.error(
      `"${version}" is not a version this can set — expected 1.2.3 or 1.2.3-main.abc1234`,
    );
    process.exit(2);
  }

  const paths = await manifests();
  const internal = await internalNames(paths);
  const changes = [];

  for (const path of paths) {
    const before = await readFile(path, 'utf8');
    const pkg = JSON.parse(before);
    const label = pkg.name ?? path;

    if (pkg.version !== undefined && pkg.version !== version) {
      changes.push(`${label}: version ${pkg.version} -> ${version}`);
      pkg.version = version;
    }
    for (const field of DEP_FIELDS) {
      const deps = pkg[field];
      if (deps === undefined) continue;
      for (const name of Object.keys(deps)) {
        // Only what this repository publishes, and only a pin that has actually moved. A
        // `workspace:` protocol or a range would be a bug `publish-order.mjs` reports, so it is
        // replaced here too rather than quietly preserved.
        if (!internal.has(name) || deps[name] === version) continue;
        changes.push(`${label}: ${field}.${name} ${deps[name]} -> ${version}`);
        deps[name] = version;
      }
    }

    // Re-serialised with the trailing newline npm itself writes, so a bump is a diff of the lines
    // that changed rather than of the whole file.
    const after = `${JSON.stringify(pkg, null, 2)}\n`;
    if (after !== before && !check) await writeFile(path, after);
  }

  if (changes.length === 0) {
    console.log(`already at ${version} — nothing to change`);
  } else {
    for (const line of changes) console.log(`  ${line}`);
    console.log(`${check ? 'would change' : 'changed'} ${changes.length} field(s) to ${version}`);
  }

  if (lock && !check) {
    // `npm ci` fails on a lockfile that disagrees with the manifests, so a bump meant for a commit
    // has to bring it along. `--ignore-scripts` because nothing here needs a build, and
    // `--package-lock-only` because nothing here needs node_modules touched either.
    console.log('reconciling package-lock.json');
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }
}

await main();
