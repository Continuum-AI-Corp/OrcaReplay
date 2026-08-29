import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRealBinary } from '../src/resolve.js';

/**
 * Resolving the *real* binary is the whole safety story for a PATH shim. Our directory is first
 * on PATH, so a shim that fails to exclude itself re-executes itself forever — and it does so
 * inside the user's agent run, which is the worst possible place to discover it.
 */
describe('resolveRealBinary', () => {
  let root: string;
  let shimDir: string;
  let realDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-resolve-'));
    shimDir = join(root, 'shims');
    realDir = join(root, 'bin');
    await mkdir(shimDir);
    await mkdir(realDir);
    await writeFile(join(shimDir, 'bash'), '#!/bin/sh\n');
    await chmod(join(shimDir, 'bash'), 0o755);
    await writeFile(join(realDir, 'bash'), '#!/bin/sh\n');
    await chmod(join(realDir, 'bash'), 0o755);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds the real binary further down PATH', async () => {
    const found = await resolveRealBinary('bash', `${shimDir}:${realDir}`, shimDir);
    expect(found).toBe(join(realDir, 'bash'));
  });

  it('never returns its own shim, however many times the shim dir appears', async () => {
    const path = [shimDir, shimDir, realDir, shimDir].join(':');
    const found = await resolveRealBinary('bash', path, shimDir);
    expect(found, 'returning the shim itself is an infinite exec loop').toBe(join(realDir, 'bash'));
  });

  it('excludes the shim dir even when PATH spells it differently', async () => {
    const awkward = `${shimDir}/.:${realDir}`;
    const found = await resolveRealBinary('bash', awkward, shimDir);
    expect(found).toBe(join(realDir, 'bash'));
  });

  it('returns undefined rather than guessing when there is no real binary', async () => {
    expect(await resolveRealBinary('bash', shimDir, shimDir)).toBeUndefined();
  });

  it('skips non-executable files of the right name', async () => {
    const decoy = join(root, 'decoy');
    await mkdir(decoy);
    await writeFile(join(decoy, 'bash'), 'not executable');
    await chmod(join(decoy, 'bash'), 0o644);
    const found = await resolveRealBinary('bash', `${decoy}:${realDir}`, shimDir);
    expect(found).toBe(join(realDir, 'bash'));
  });

  it('tolerates PATH entries that do not exist', async () => {
    const found = await resolveRealBinary('bash', `/nope/nowhere:${realDir}`, shimDir);
    expect(found).toBe(join(realDir, 'bash'));
  });

  it('ignores empty PATH segments', async () => {
    const found = await resolveRealBinary('bash', `::${realDir}:`, shimDir);
    expect(found).toBe(join(realDir, 'bash'));
  });
});

describe('resolveRunnerBin', () => {
  it('finds the compiled runner whether loaded from dist or from source', async () => {
    const { resolveRunnerBin } = await import('../src/install.js');
    const path = await resolveRunnerBin();
    // Only the compiled .js can be exec'd by the shim script; a .ts here means the shims would
    // silently produce nothing, which is exactly what this cost us the first time.
    expect(path).toMatch(/runner-bin\.js$/);
    const { access } = await import('node:fs/promises');
    await expect(access(path)).resolves.toBeUndefined();
  });
});
