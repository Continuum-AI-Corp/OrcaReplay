import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The version bump, which is the one edit a release cannot get wrong.
 *
 * Twelve packages name each other by exact version, so moving a version means moving every pin that
 * names it — thirty-eight fields across thirteen manifests at the time of writing. Every release
 * before this script was a hand-written commit doing that, and `npm version --workspaces` does not
 * help: it moves each package's own `version` and leaves its dependents pointing at the old one.
 *
 * The failure this guards is not a red test later. A pin left behind publishes
 * `orcareplay@0.2.4` depending on `@orcareplay/core@0.2.3`, and npm never allows a version to be
 * re-published — so it is wrong on the registry permanently. `publish-order.mjs` is the other half
 * of the guard and every release runs it; this pins the shape it is checking.
 */
describe('set-version', () => {
  let work: string;

  /** A copy of the real manifests, so the assertions are about this repository's actual graph. */
  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'orca-setver-'));
    await cp(join(repo, 'package.json'), join(work, 'package.json'));
    await mkdir(join(work, 'scripts'), { recursive: true });
    await cp(join(repo, 'scripts', 'set-version.mjs'), join(work, 'scripts', 'set-version.mjs'));
    await cp(
      join(repo, 'scripts', 'publish-order.mjs'),
      join(work, 'scripts', 'publish-order.mjs'),
    );
    await cp(join(repo, 'packages'), join(work, 'packages'), {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.includes(`${'dist'}`),
    });
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  const setVersion = (...args: string[]) =>
    run(process.execPath, [join(work, 'scripts', 'set-version.mjs'), ...args], { cwd: work });

  const manifest = async (rel: string) =>
    JSON.parse(await readFile(join(work, rel), 'utf8')) as {
      version?: string;
      dependencies?: Record<string, string>;
    };

  it('moves every version and every internal pin together', async () => {
    await setVersion('1.2.3');

    const cli = await manifest('packages/cli/package.json');
    expect(cli.version).toBe('1.2.3');
    // The pins are the half `npm version` leaves behind.
    for (const [name, range] of Object.entries(cli.dependencies ?? {})) {
      if (!name.startsWith('@orcareplay/')) continue;
      expect(range, `${name} was left naming the old version`).toBe('1.2.3');
    }
    expect((await manifest('packages/core/package.json')).version).toBe('1.2.3');
    expect((await manifest('package.json')).version).toBe('1.2.3');
  });

  it('leaves a third-party dependency alone', async () => {
    // `@orcareplay/schema` rather than the CLI: the CLI ships with no runtime dependency at all,
    // so it cannot show that an outside range survives. Both the root's devDependencies and
    // schema's `ajv` are checked, because the fields are walked separately.
    const schema = 'packages/schema/package.json';
    const before = (await manifest(schema)).dependencies ?? {};
    const outside = Object.entries(before).filter(([n]) => !n.startsWith('@orcareplay/'));
    expect(outside.length, 'schema has no external dependency to check').toBeGreaterThan(0);
    const rootDev = (
      JSON.parse(await readFile(join(work, 'package.json'), 'utf8')) as {
        devDependencies?: Record<string, string>;
      }
    ).devDependencies;

    await setVersion('1.2.3');

    const after = (await manifest(schema)).dependencies ?? {};
    for (const [name, range] of outside) expect(after[name], name).toBe(range);
    const rootAfter = (
      JSON.parse(await readFile(join(work, 'package.json'), 'utf8')) as {
        devDependencies?: Record<string, string>;
      }
    ).devDependencies;
    expect(rootAfter, 'a devDependency on prettier is not a version to bump').toEqual(rootDev);
  });

  it('satisfies publish-order, which is what a release gates on', async () => {
    for (const version of ['1.2.3', '0.2.4-main.90fc463']) {
      await setVersion(version);
      // Exits non-zero and names the offender if any pin disagrees.
      const { stdout } = await run(process.execPath, [join(work, 'scripts', 'publish-order.mjs')], {
        cwd: work,
      });
      expect(stdout.trim().split(/\r?\n/).length, 'every package should be publishable').toBe(12);
    }
  });

  it('accepts a prerelease, because that is what the next channel publishes', async () => {
    await setVersion('0.2.4-main.90fc463');
    expect((await manifest('packages/cli/package.json')).version).toBe('0.2.4-main.90fc463');
    expect((await manifest('packages/cli/package.json')).dependencies?.['@orcareplay/core']).toBe(
      '0.2.4-main.90fc463',
    );
  });

  it('refuses a range, and build metadata, rather than publishing something unfixable', async () => {
    // A range would resolve to whatever is latest; build metadata is ignored when npm compares
    // versions, so two different trees could claim the same version on the registry.
    for (const bad of ['^1.2.3', '1.2', 'latest', '1.2.3+build']) {
      await expect(setVersion(bad), `"${bad}" should be refused`).rejects.toThrow();
    }
    // And nothing was written on the way to refusing.
    expect((await manifest('packages/cli/package.json')).version).toBe(
      (await manifest('package.json')).version,
    );
  });

  /**
   * A numeric prerelease identifier with a leading zero, which npm rewrites rather than refuses.
   *
   * `0.2.4-main.0123456` is invalid semver, and `npm publish` does not say so. It runs the manifest
   * through `@npmcli/package-json`'s `fix()`, which cleans the *version* to `0.2.4-main.123456`
   * with a warning and leaves every dependency pin naming `0.2.4-main.0123456`. Measured with
   * npm's own library:
   *
   *     fix() version : 0.2.4-main.123456
   *     fix() dep pin : 0.2.4-main.0123456
   *
   * So twelve packages would go out at one version while declaring dependencies on another that
   * does not exist, and npm never lets a version be replaced — the channel would be permanently
   * unresolvable. A short sha does this whenever its first seven characters are all digits and
   * start with a zero, about one commit in 270, which is why `publish-next.yml` prefixes the sha
   * with a letter as well.
   */
  it('refuses a leading-zero numeric prerelease, which npm would silently rewrite', async () => {
    for (const bad of ['0.2.4-main.0123456', '0.2.4-01', '1.2.3-0.0123', '01.2.3']) {
      await expect(setVersion(bad), `"${bad}" should be refused`).rejects.toThrow();
    }
    // The shapes that are legal must still pass, or the guard is just refusing prereleases.
    for (const good of ['0.2.4-main.g0123456', '0.2.4-main.123456', '0.2.4-main.0abc123']) {
      await expect(setVersion(good), `"${good}" should be accepted`).resolves.toBeTruthy();
    }
  });

  /**
   * The lockfile half, asserted on what is committed rather than on a re-resolve.
   *
   * An internal dependency must appear in `package-lock.json` as a link to the workspace, never as
   * something to fetch. 0.2.1 shipped with two entries resolving `@orcareplay/*` from the registry,
   * because `npm version` writes the lockfile at the one moment when the versions have moved and
   * the pins have not — so npm stopped seeing them as satisfiable workspace links and recorded the
   * *previous release* instead. Those copies then shadow the source and `tsc` checks the CLI
   * against last release's `.d.ts`.
   *
   * `set-version.mjs --lock` cannot reproduce that, because it fixes the pins before it touches the
   * lockfile. This guards the outcome anyway: it is cheap, it does not care how the file was
   * produced, and re-resolving here to prove it would add a minute to the suite.
   */
  it('the committed lockfile links internal packages instead of fetching them', async () => {
    const lock = await readFile(join(repo, 'package-lock.json'), 'utf8');
    const fetched = [...lock.matchAll(/registry\.npmjs\.org\/(@orcareplay\/[\w-]+)/g)].map(
      (m) => m[1],
    );
    expect(
      [...new Set(fetched)],
      'these are resolved from the registry and must be workspace links',
    ).toEqual([]);
  });

  it('is idempotent, and says so', async () => {
    await setVersion('1.2.3');
    const first = await readFile(join(work, 'packages/cli/package.json'), 'utf8');
    const { stdout } = await setVersion('1.2.3');
    expect(stdout).toContain('nothing to change');
    expect(await readFile(join(work, 'packages/cli/package.json'), 'utf8')).toBe(first);
  });

  it('--check writes nothing', async () => {
    const before = await readFile(join(work, 'packages/cli/package.json'), 'utf8');
    const { stdout } = await setVersion('9.9.9', '--check');
    expect(stdout).toContain('would change');
    expect(await readFile(join(work, 'packages/cli/package.json'), 'utf8')).toBe(before);
  });

  it('round-trips, so a release that is rolled back leaves no trace', async () => {
    const before = await readFile(join(work, 'packages/cli/package.json'), 'utf8');
    const original = (await manifest('packages/cli/package.json')).version!;
    await setVersion('0.2.4-main.90fc463');
    await setVersion(original);
    expect(await readFile(join(work, 'packages/cli/package.json'), 'utf8')).toBe(before);
  });

  it('rewrites a workspace protocol, which publish-order would reject', async () => {
    // Not hypothetical: `workspace:*` is what npm/pnpm docs suggest, and it cannot be published.
    const path = join(work, 'packages/cli/package.json');
    const pkg = JSON.parse(await readFile(path, 'utf8'));
    pkg.dependencies['@orcareplay/core'] = 'workspace:*';
    await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);

    await setVersion('1.2.3');

    expect((await manifest('packages/cli/package.json')).dependencies?.['@orcareplay/core']).toBe(
      '1.2.3',
    );
  });
});
