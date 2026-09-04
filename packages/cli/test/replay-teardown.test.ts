import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-replay-teardown-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A replay whose agent cannot be launched has to let go of the terminal.
 *
 * `orca replay` opens a listening proxy, and a listening server keeps node's event loop alive on
 * its own — so a throw from the spawn printed `could not launch` and then hung, with Ctrl-C the
 * only way out. The fork path in the same file already handled this and says so in a comment; this
 * was the third of the three and the one still missing it.
 *
 * The agent that was recorded is not always installed where the recording is replayed. That is half
 * the point of having a trace, and `spawn <agent> ENOENT` is what it looks like from inside the
 * replay.
 */
describe('orca replay, when the recorded agent will not launch', () => {
  const timeout = 90_000;
  const bare = { ...process.env, NO_COLOR: '1' };

  /** Record a real run, then point its manifest at an agent that is not installed. */
  async function runWithMissingAgent(): Promise<string> {
    await writeFile(join(dir, 'a.mjs'), "process.stdout.write('HI');\n");
    await run(process.execPath, [cli, 'record', 'node', '--', 'node', 'a.mjs'], {
      cwd: dir,
      env: bare,
      timeout: timeout - 10_000,
    });
    const runs = join(dir, '.orca', 'runs');
    const [id] = await readdir(runs);
    const path = join(runs, id!, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as { argv: string[] };
    manifest.argv = ['node', 'orca-no-such-binary', 'a.mjs'];
    await writeFile(path, JSON.stringify(manifest, null, 2));
    return id!;
  }

  it(
    'exits instead of hanging, and says why',
    async () => {
      const id = await runWithMissingAgent();
      const attempt = run(process.execPath, [cli, 'replay', id, '--in-place'], {
        cwd: dir,
        env: bare,
        timeout: timeout - 20_000,
      });
      // A hang arrives here as `killed`, which is the whole point of the test and is therefore
      // distinguished from an ordinary non-zero exit rather than lumped in with it.
      const err = (await attempt.catch((e: unknown) => e)) as {
        killed?: boolean;
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      expect(err.killed, 'the replay hung instead of exiting').not.toBe(true);
      expect(err.code).toBe(1);
      expect(`${err.stdout ?? ''}${err.stderr ?? ''}`).toMatch(/could not launch/);
    },
    timeout,
  );

  /**
   * And the trace the replay was writing is sealed rather than left open, for the reason the fork
   * path gives: a run that failed to launch is still a run someone will want to read, and an
   * unsealed trace has no `ended_at` or `integrity`, so `verifyIntegrity` reports it as tampered
   * with rather than as unfinished. The exit code stays absent, because there was never one.
   */
  it(
    'seals the trace it was writing, with the reason and without an exit code',
    async () => {
      const id = await runWithMissingAgent();
      await run(process.execPath, [cli, 'replay', id, '--in-place'], {
        cwd: dir,
        env: bare,
        timeout: timeout - 20_000,
      }).catch(() => undefined);

      const runs = join(dir, '.orca', 'runs');
      const written = (await readdir(runs)).filter((r) => r !== id);
      expect(written, 'the replay left no trace of its own').toHaveLength(1);

      const manifest = JSON.parse(
        await readFile(join(runs, written[0]!, 'manifest.json'), 'utf8'),
      ) as { ended_at?: string; integrity?: unknown; exit_code?: number };
      expect(manifest.ended_at).toBeDefined();
      expect(manifest.integrity).toBeDefined();
      expect(manifest.exit_code, 'an exit code that never happened must not be recorded').toBe(
        undefined,
      );

      const events = await readFile(join(runs, written[0]!, 'events.jsonl'), 'utf8');
      expect(events).toMatch(/could not launch/);
    },
    timeout,
  );

  /** The working tree is still put back, which the `finally` was already there to guarantee. */
  it(
    'restores the working tree it replayed over',
    async () => {
      const id = await runWithMissingAgent();
      await run(process.execPath, [cli, 'replay', id], {
        cwd: dir,
        env: bare,
        timeout: timeout - 20_000,
      }).catch(() => undefined);
      await expect(readFile(join(dir, 'a.mjs'), 'utf8')).resolves.toContain('HI');
    },
    timeout,
  );
});
