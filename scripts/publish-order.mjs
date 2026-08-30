#!/usr/bin/env node
/**
 * Topological publish order for the workspaces.
 *
 * Internal dependencies are pinned to an exact version, which is right — a `*` resolves to whatever
 * happens to be latest, so a 0.1.0 CLI would silently pick up a 0.9.0 core. The cost is that order
 * now matters: publishing the CLI before `@orcareplay/core` fails, because the version it names does
 * not exist on the registry yet.
 *
 * Computed rather than written down, so adding a dependency cannot silently invalidate a hardcoded
 * list in a release workflow that only runs on a tag.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'packages');

const packages = new Map();
for (const entry of await readdir(dir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = join(dir, entry.name, 'package.json');
  const pkg = JSON.parse(await readFile(manifest, 'utf8').catch(() => '{}'));
  if (!pkg.name || pkg.private === true) continue;
  packages.set(pkg.name, {
    dir: join('packages', entry.name),
    version: pkg.version,
    deps: Object.keys({ ...pkg.dependencies }).filter((d) => d.startsWith('@orcareplay/')),
    ranges: { ...pkg.dependencies },
  });
}

/** Depth-first, with a cycle guard: a cycle is unpublishable and must fail loudly, not hang. */
const order = [];
const state = new Map();
function visit(name, trail) {
  if (state.get(name) === 'done') return;
  if (state.get(name) === 'visiting') {
    throw new Error(`dependency cycle: ${[...trail, name].join(' -> ')}`);
  }
  state.set(name, 'visiting');
  for (const dep of packages.get(name)?.deps ?? []) {
    if (packages.has(dep)) visit(dep, [...trail, name]);
  }
  state.set(name, 'done');
  order.push(name);
}
for (const name of packages.keys()) visit(name, []);

// Two ways an internal dependency ships the wrong thing, both checked here rather than only in the
// test suite — this script is what the release workflow gates on.
const problems = [];
for (const [name, p] of packages) {
  for (const dep of p.deps) {
    const target = packages.get(dep);
    if (!target) continue;
    const range = p.ranges[dep];
    // A range resolves to whatever is latest on the registry, so a 0.1.0 CLI would install a
    // 0.9.0 core — and on a first publish it resolves to nothing at all.
    if (!/^\d+\.\d+\.\d+$/.test(range)) {
      problems.push(`${name} depends on ${dep} as "${range}" — must be an exact version`);
    } else if (target.version !== range) {
      problems.push(`${name} names ${dep}@${range}, but ${dep} is at ${target.version}`);
    }
  }
}
if (problems.length > 0) {
  console.error(`internal dependencies are not publishable:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(order.map((n) => packages.get(n).dir)));
} else {
  for (const name of order) console.log(packages.get(name).dir);
}
