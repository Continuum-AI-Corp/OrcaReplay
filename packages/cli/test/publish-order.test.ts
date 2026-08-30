import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = join(repoRoot, 'scripts', 'publish-order.mjs');

const order = (): string[] =>
  execFileSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n');

const manifest = (
  dir: string,
): { name: string; version: string; dependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'));

/**
 * The release workflow publishes in this order and only ever runs on a tag, so a mistake here is
 * discovered at the worst possible moment — halfway through pushing irreversible versions to a
 * public registry.
 */
describe('publish order', () => {
  it('puts every package after all of its internal dependencies', () => {
    const published = new Set<string>();
    for (const dir of order()) {
      const pkg = manifest(dir);
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        if (!dep.startsWith('@orcareplay/')) continue;
        expect(published, `${pkg.name} is published before its dependency ${dep}`).toContain(dep);
      }
      published.add(pkg.name);
    }
  });

  it('includes every publishable workspace and no private one', () => {
    const listed = order().map((d) => manifest(d).name);
    expect(new Set(listed).size, 'a package listed twice would publish twice').toBe(listed.length);
    expect(listed).toContain('orcareplay');
    expect(listed).toContain('@orcareplay/core');
    expect(listed).not.toContain('orcareplay-monorepo');
  });

  it('pins internal dependencies to an exact version, never a range', () => {
    // `*` resolves to whatever is latest on the registry, so a 0.1.0 CLI would silently install a
    // 0.9.0 core — and on a first publish it cannot resolve at all, because nothing exists yet.
    for (const dir of order()) {
      const pkg = manifest(dir);
      for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
        if (!dep.startsWith('@orcareplay/')) continue;
        expect(range, `${pkg.name} depends on ${dep} as "${range}"`).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
  });

  it('fails loudly when two packages disagree about a version', () => {
    // Exercised through the real script rather than a unit of it: the guard exists so a release
    // cannot publish a CLI naming a core version that is not the one being published beside it.
    const versions = new Set(order().map((d) => manifest(d).version));
    expect(versions.size, `workspaces are on different versions: ${[...versions].join(', ')}`).toBe(
      1,
    );
  });
});
