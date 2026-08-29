import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlobStore, TraceReader, TraceWriter, listRuns } from '@orcareplay/core';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { stripAnsi } from '../src/out.js';
import { gcCommand, parseDuration } from '../src/commands/gc.js';
import { main } from '../src/main.js';

/**
 * `orca gc` deletes recorded evidence, so every test here is really asking the same question:
 * does it delete exactly what it said it would, and nothing else?
 */
describe('gc', () => {
  let cwd: string;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-gc-'));
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const text = () => stripAnsi(lines.join(''));

  async function makeRun(payloads: unknown[] = ['hello']): Promise<string> {
    const writer = await TraceWriter.create(join(cwd, '.orca', 'runs'), {
      adapter: { id: 'test' },
      argv: ['test'],
      cwd,
      orcaVersion: '0.1.0',
    });
    await writer.append({ type: 'run.start', actor: 'orca', turn: 0 });
    for (const payload of payloads) {
      await writer.append({ type: 'note', actor: 'orca', turn: 1, payload: payload as never });
    }
    await writer.append({ type: 'run.end', actor: 'orca', turn: 1 });
    await writer.close(0);
    return writer.runDir;
  }

  describe('gc — fork worktrees', () => {
    /**
     * A fork materialises the recorded workspace into a scratch directory under the OS temp dir and
     * runs the agent there, and nothing ever removed it. `orca compare --models a,b,c,d` therefore
     * left four full copies of the workspace behind on every invocation, permanently, and `orca gc`
     * — the command whose entire job is reclaiming space — could not see them.
     *
     * The worktree is not deleted when the fork ends, because it holds what the model actually did:
     * deleting it immediately would destroy the thing you forked in order to look at. It is reclaimed
     * with its run.
     */
    it('removes the worktree belonging to a run it deletes', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'orca-4-'));
      await writeFile(join(worktree, 'auth.ts'), 'export const fixed = true;\n');

      const parent = await makeRun(['parent']);
      const child = await makeRun(['child']);
      await patchManifest(child, { parent_run: 'run_000000000000', fork_point: 4, cwd: worktree });
      await ageRun(child, 30 * DAY);
      await ageRun(parent, 1000);

      await gcCommand(parseArgs(['gc', '--older-than', '7d']), out, cwd);

      expect(existsSync(child), 'the forked run should be gone').toBe(false);
      expect(existsSync(worktree), 'its worktree should be gone with it').toBe(false);
    });

    it('leaves a worktree alone on a dry run', async () => {
      const worktree = await mkdtemp(join(tmpdir(), 'orca-4-'));
      const child = await makeRun(['child']);
      await patchManifest(child, { parent_run: 'run_000000000000', fork_point: 4, cwd: worktree });
      await ageRun(child, 30 * DAY);

      await gcCommand(parseArgs(['gc', '--older-than', '7d', '--dry-run']), out, cwd);

      expect(existsSync(worktree)).toBe(true);
    });

    it('never deletes the cwd of a run that carries a parent but is not a fork', async () => {
      // `parent_run` used to mean "fork", so the two halves of the guard — is it a fork, does the
      // path look like one of ours — were the same question asked twice. An exact replay now
      // writes a run with `parent_run` set and the *user's own directory* as its cwd, so the fork
      // half has to be a real question again: only a run that actually forked has a `fork_point`,
      // and only such a run has a directory orca made and may reclaim.
      const project = await mkdtemp(join(tmpdir(), 'orca-someones-project-'));
      await writeFile(join(project, 'important.ts'), 'do not delete me\n');

      const run = await makeRun(['replay trace']);
      await patchManifest(run, { parent_run: 'run_000000000000', cwd: project });
      await ageRun(run, 30 * DAY);

      const result = await gcCommand(parseArgs(['gc', '--older-than', '7d']), out, cwd);

      expect(existsSync(run), 'the trace itself should be gone').toBe(false);
      expect(existsSync(project), 'a replay ran in the user’s project; it is not ours').toBe(true);
      expect(result.worktreesRemoved).toBe(0);
    });

    it('never deletes a directory that is not a scratch worktree', async () => {
      // The guard that matters. A fork's cwd is a temp directory orca made; a plain recording's cwd
      // is the user's actual project, and deleting that would be catastrophic.
      const project = await mkdtemp(join(tmpdir(), 'someones-project-'));
      await writeFile(join(project, 'important.ts'), 'do not delete me\n');

      const run = await makeRun(['first']);
      await patchManifest(run, { cwd: project });
      await ageRun(run, 30 * DAY);

      await gcCommand(parseArgs(['gc', '--older-than', '7d']), out, cwd);

      expect(existsSync(run), 'the run itself should be gone').toBe(false);
      expect(existsSync(project), "a recording cwd is not orca's to delete").toBe(true);
    });
  });

  /** Runs recorded milliseconds apart sort unstably; every test states the age it means. */
  async function ageRun(runDir: string, ageMs: number): Promise<void> {
    await patchManifest(runDir, { created_at: new Date(Date.now() - ageMs).toISOString() });
  }

  async function patchManifest(runDir: string, patch: Record<string, unknown>): Promise<void> {
    const path = join(runDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`);
  }

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  /** Independent byte count, so bytesReclaimed is checked against a second implementation. */
  async function fileBytes(dir: string): Promise<number> {
    let total = 0;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) total += await fileBytes(path);
      else total += (await stat(path)).size;
    }
    return total;
  }

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  describe('duration parsing', () => {
    it('accepts the units the help text advertises', () => {
      expect(parseDuration('30m')).toBe(30 * 60_000);
      expect(parseDuration('24h')).toBe(24 * HOUR);
      expect(parseDuration('7d')).toBe(7 * DAY);
      expect(parseDuration('2w')).toBe(14 * DAY);
      expect(parseDuration('90s')).toBe(90_000);
    });

    it('rejects anything it cannot read, rather than guessing a unit', () => {
      // A silently-guessed unit here deletes the wrong runs; every one of these must be a no.
      expect(parseDuration('7')).toBeNull();
      expect(parseDuration('soon')).toBeNull();
      expect(parseDuration('')).toBeNull();
      expect(parseDuration('d7')).toBeNull();
      expect(parseDuration('-3d')).toBeNull();
      expect(parseDuration('7 days')).toBeNull();
      expect(parseDuration('7y')).toBeNull();
    });

    it('fails the command with an example, not just "invalid"', async () => {
      await makeRun();
      await expect(gcCommand(parseArgs(['gc', '--older-than', 'soon']), out, cwd)).rejects.toThrow(
        /7d/,
      );
    });

    it('rejects --older-than with no value instead of treating it as a boolean', async () => {
      await makeRun();
      await expect(gcCommand(parseArgs(['gc', '--older-than']), out, cwd)).rejects.toThrow(
        /older-than/,
      );
    });

    it('rejects a negative --keep', async () => {
      await makeRun();
      await expect(gcCommand(parseArgs(['gc', '--keep', '-1']), out, cwd)).rejects.toThrow(/keep/);
    });
  });

  describe('--older-than', () => {
    it('removes runs older than the window and keeps the rest', async () => {
      const old = await makeRun();
      const fresh = await makeRun();
      await ageRun(old, 9 * DAY);
      await ageRun(fresh, 1 * HOUR);

      const result = await gcCommand(parseArgs(['gc', '--older-than', '7d']), out, cwd);

      expect(result.runsRemoved).toBe(1);
      expect(await exists(old)).toBe(false);
      expect(await exists(fresh)).toBe(true);
    });

    it('leaves a run that is exactly inside the window alone', async () => {
      const run = await makeRun();
      await ageRun(run, 6 * DAY);
      const result = await gcCommand(parseArgs(['gc', '--older-than', '7d']), out, cwd);
      expect(result.runsRemoved).toBe(0);
      expect(await exists(run)).toBe(true);
    });
  });

  describe('--keep', () => {
    it('keeps the n most recent runs and removes the rest', async () => {
      const a = await makeRun();
      const b = await makeRun();
      const c = await makeRun();
      await ageRun(a, 3 * DAY);
      await ageRun(b, 2 * DAY);
      await ageRun(c, 1 * DAY);

      const result = await gcCommand(parseArgs(['gc', '--keep', '1']), out, cwd);

      expect(result.runsRemoved).toBe(2);
      expect(await exists(a)).toBe(false);
      expect(await exists(b)).toBe(false);
      expect(await exists(c)).toBe(true);
    });

    it('keeps the n most recent even when they are older than --older-than', async () => {
      // Both flags are constraints, not alternatives: --keep is a floor under --older-than.
      const a = await makeRun();
      const b = await makeRun();
      await ageRun(a, 30 * DAY);
      await ageRun(b, 20 * DAY);

      const result = await gcCommand(
        parseArgs(['gc', '--older-than', '7d', '--keep', '1']),
        out,
        cwd,
      );

      expect(result.runsRemoved).toBe(1);
      expect(await exists(b), 'the newest run is under the --keep floor').toBe(true);
    });
  });

  describe('with neither flag', () => {
    it('removes no runs at all', async () => {
      const a = await makeRun();
      const b = await makeRun();
      await ageRun(a, 400 * DAY);

      const result = await gcCommand(parseArgs(['gc']), out, cwd);

      expect(result.runsRemoved).toBe(0);
      expect(await exists(a)).toBe(true);
      expect(await exists(b)).toBe(true);
    });

    it('reports what it found and how to actually remove something', async () => {
      await makeRun();
      await gcCommand(parseArgs(['gc']), out, cwd);
      expect(text()).toMatch(/--older-than|--keep/);
    });

    it('says so plainly when there are no runs at all', async () => {
      const result = await gcCommand(parseArgs(['gc']), out, cwd);
      expect(result).toEqual({
        runsRemoved: 0,
        worktreesRemoved: 0,
        blobsRemoved: 0,
        bytesReclaimed: 0,
      });
      expect(text()).toMatch(/no runs/i);
    });
  });

  describe('orphaned blobs', () => {
    it('removes only the blob no event references', async () => {
      // A payload over the 4096-byte inline limit spills to a blob, so the run has a real
      // referenced blob to confuse an over-eager sweep.
      const runDir = await makeRun([`referenced ${'x'.repeat(5000)}`]);
      const store = new BlobStore(join(runDir, 'blobs'));
      const referencedBefore = await store.count();
      const orphan = await store.put(`orphan ${'y'.repeat(5000)}`);

      const result = await gcCommand(parseArgs(['gc']), out, cwd);

      expect(result.blobsRemoved).toBe(1);
      expect(await store.has(orphan), 'the unreferenced blob must go').toBe(false);
      expect(await store.count(), 'every referenced blob must stay').toBe(referencedBefore);
      expect(await exists(runDir), 'pruning blobs must not remove the run').toBe(true);
    });

    it('counts the orphan bytes it reclaimed', async () => {
      const runDir = await makeRun();
      const store = new BlobStore(join(runDir, 'blobs'));
      const body = 'z'.repeat(1234);
      await store.put(body);

      const result = await gcCommand(parseArgs(['gc']), out, cwd);

      expect(result.bytesReclaimed).toBe(Buffer.byteLength(body));
    });

    it('leaves blobs alone for a run that was never sealed, which may still be recording', async () => {
      // A live recording writes the blob before the event that references it. Sweeping an
      // in-flight run would delete a payload the writer is about to point at.
      const writer = await TraceWriter.create(join(cwd, '.orca', 'runs'), {
        adapter: { id: 'test' },
        argv: ['test'],
        cwd,
        orcaVersion: '0.1.0',
      });
      await writer.append({ type: 'run.start', actor: 'orca', turn: 0 });
      const store = new BlobStore(join(writer.runDir, 'blobs'));
      await store.put('a payload whose event has not been written yet');

      const result = await gcCommand(parseArgs(['gc']), out, cwd);

      expect(result.blobsRemoved).toBe(0);
      expect(await store.count()).toBe(1);
    });

    it('leaves blobs alone when events.jsonl cannot be read', async () => {
      // Without a readable event log every blob looks unreferenced. Deleting them would destroy
      // the payloads of a crashed run — exactly the run someone is trying to debug.
      const runDir = await makeRun([`spilled ${'x'.repeat(5000)}`]);
      const store = new BlobStore(join(runDir, 'blobs'));
      const before = await store.count();
      await rm(join(runDir, 'events.jsonl'));

      const result = await gcCommand(parseArgs(['gc']), out, cwd);

      expect(result.blobsRemoved).toBe(0);
      expect(await store.count()).toBe(before);
      expect(text()).toMatch(/events\.jsonl|unreadable/i);
    });
  });

  describe('--dry-run', () => {
    it('reports what it would remove and removes nothing', async () => {
      const a = await makeRun();
      const b = await makeRun();
      await ageRun(a, 3 * DAY);
      await ageRun(b, 1 * DAY);
      const store = new BlobStore(join(b, 'blobs'));
      await store.put('orphan blob content');

      const planned = await gcCommand(parseArgs(['gc', '--keep', '1', '--dry-run']), out, cwd);

      expect(planned.runsRemoved).toBe(1);
      expect(planned.blobsRemoved).toBe(1);
      expect(planned.bytesReclaimed).toBeGreaterThan(0);
      expect(await exists(a), 'a dry run must not delete anything').toBe(true);
      expect(await store.count()).toBe(1);
      expect(text()).toMatch(/dry.run/i);
    });

    it('reports the same numbers the real run then delivers', async () => {
      const a = await makeRun();
      const b = await makeRun();
      await ageRun(a, 3 * DAY);
      await ageRun(b, 1 * DAY);
      await new BlobStore(join(b, 'blobs')).put('orphan blob content');

      const planned = await gcCommand(parseArgs(['gc', '--keep', '1', '--dry-run']), out, cwd);
      const done = await gcCommand(parseArgs(['gc', '--keep', '1']), out, cwd);

      expect(done).toEqual(planned);
    });
  });

  describe('fork provenance', () => {
    it('never removes a run that a surviving run names as its parent', async () => {
      const parent = await makeRun();
      const child = await makeRun();
      await ageRun(parent, 30 * DAY);
      await ageRun(child, 1 * DAY);
      const parentId = (await listRuns(cwd)).find((r) => r.dir === parent)!.runId;
      await patchManifest(child, { parent_run: parentId, fork_point: 1 });

      const result = await gcCommand(parseArgs(['gc', '--older-than', '7d']), out, cwd);

      expect(result.runsRemoved).toBe(0);
      expect(await exists(parent), 'orphaning a fork destroys its provenance').toBe(true);
      expect(text()).toMatch(/parent/i);
    });

    it('protects a parent claimed only by a fork event, which is how forks are recorded', async () => {
      const parent = await makeRun();
      const parentId = (await listRuns(cwd)).find((r) => r.dir === parent)!.runId;

      const writer = await TraceWriter.create(join(cwd, '.orca', 'runs'), {
        adapter: { id: 'test' },
        argv: ['test'],
        cwd,
        orcaVersion: '0.1.0',
      });
      await writer.append({
        type: 'fork',
        actor: 'orca',
        turn: 0,
        attrs: { parent_run: parentId, fork_point: 1 },
      });
      await writer.close(0);
      await ageRun(parent, 30 * DAY);
      await ageRun(writer.runDir, 1 * DAY);

      const result = await gcCommand(parseArgs(['gc', '--older-than', '7d']), out, cwd);

      expect(result.runsRemoved).toBe(0);
      expect(await exists(parent)).toBe(true);
    });

    it('protects a whole chain when only the newest fork survives', async () => {
      const a = await makeRun();
      const b = await makeRun();
      const c = await makeRun();
      await ageRun(a, 5 * DAY);
      await ageRun(b, 4 * DAY);
      await ageRun(c, 3 * DAY);
      const byDir = new Map((await listRuns(cwd)).map((r) => [r.dir, r.runId]));
      await patchManifest(b, { parent_run: byDir.get(a) });
      await patchManifest(c, { parent_run: byDir.get(b) });

      const result = await gcCommand(parseArgs(['gc', '--keep', '1']), out, cwd);

      expect(result.runsRemoved).toBe(0);
      expect(await exists(a), 'the grandparent is reachable through the protected parent').toBe(
        true,
      );
      expect(await exists(b)).toBe(true);
    });

    it('does remove a parent whose only child is going too', async () => {
      const parent = await makeRun();
      const child = await makeRun();
      await ageRun(parent, 30 * DAY);
      await ageRun(child, 20 * DAY);
      const byDir = new Map((await listRuns(cwd)).map((r) => [r.dir, r.runId]));
      await patchManifest(child, { parent_run: byDir.get(parent) });

      const result = await gcCommand(parseArgs(['gc', '--older-than', '7d']), out, cwd);

      expect(result.runsRemoved).toBe(2);
      expect(await exists(parent)).toBe(false);
    });
  });

  describe('accounting', () => {
    it('reports the bytes a removed run actually occupied', async () => {
      const a = await makeRun([`padding ${'x'.repeat(9000)}`]);
      const b = await makeRun();
      await ageRun(a, 30 * DAY);
      await ageRun(b, 1 * DAY);
      const expected = await fileBytes(a);

      const result = await gcCommand(parseArgs(['gc', '--older-than', '7d']), out, cwd);

      expect(expected).toBeGreaterThan(9000);
      expect(result.bytesReclaimed).toBe(expected);
    });
  });

  describe('cli wiring', () => {
    it('is reachable as `orca gc`, not an unknown command', async () => {
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await makeRun();
        expect(await main(['gc', '--dry-run'], cwd)).toBe(0);
      } finally {
        stdout.mockRestore();
      }
    });

    it('exits non-zero when the arguments make no sense', async () => {
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await makeRun();
        expect(await main(['gc', '--older-than', 'whenever'], cwd)).toBe(1);
      } finally {
        stdout.mockRestore();
      }
    });
  });

  describe('what survives', () => {
    it('leaves a surviving run readable and passing its own integrity check', async () => {
      const old = await makeRun();
      const keep = await makeRun([`spilled ${'x'.repeat(5000)}`, 'inline note']);
      await ageRun(old, 30 * DAY);
      await ageRun(keep, 1 * DAY);
      await new BlobStore(join(keep, 'blobs')).put(
        'an orphan that must not take a payload with it',
      );

      await gcCommand(parseArgs(['gc', '--older-than', '7d']), out, cwd);

      const reader = await TraceReader.open(keep);
      const events = await reader.events();
      expect(reader.problems()).toEqual([]);
      expect(events.length).toBeGreaterThan(2);
      const integrity = await reader.verifyIntegrity();
      expect(integrity.ok, 'gc must never touch events.jsonl').toBe(true);

      // The spilled payload is the one that lives in a blob; resolving it proves the sweep did
      // not take a referenced blob with the orphan.
      const spilled = events.find((e) => e.type === 'note' && e.payload !== undefined);
      expect(await reader.resolvePayload(spilled!)).toContain('spilled');
    });
  });
});
