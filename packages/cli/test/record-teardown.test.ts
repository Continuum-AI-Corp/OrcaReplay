import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
  dir = await mkdtemp(join(tmpdir(), 'orca-teardown-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A run that dies before the agent starts still has to let go of the terminal.
 *
 * `orca record` opens a listening proxy before it does anything else, and a listening server keeps
 * Node's event loop alive on its own. So every throw between opening the proxy and the child's exit
 * printed its error and then hung — the process never returned, and the only way out was Ctrl-C.
 *
 * The teardown existed, but it started at the spawn. It covered the failure it was written for, an
 * agent that is not on PATH, and missed the one that comes first: an adapter validates the
 * invocation in `prepare`, before anything is spawned. `orca record node agent.mjs`, with the `--`
 * left out, printed exactly the right message about the missing `--` and then hung forever, which
 * is the first thing a new user does with the first command they run.
 *
 * Asserted by running the built CLI, because the thing under test is whether the process exits.
 * A test that called the command in-process would return, pass, and prove nothing.
 */
describe('orca record, when the run dies before the agent starts', () => {
  const timeout = 60_000;
  const bare = { ...process.env, NO_COLOR: '1' };

  /** The command exits, and the reason survives to say why. */
  const failsWith = async (argv: string[], expected: RegExp): Promise<void> => {
    const attempt = run(process.execPath, [cli, ...argv], {
      cwd: dir,
      env: bare,
      timeout: timeout - 5_000,
    });
    // A hang shows up here as `killed`, which is what this test exists to catch — so it is
    // distinguished from an ordinary non-zero exit rather than lumped in with it.
    const err = (await attempt.catch((e: unknown) => e)) as {
      killed?: boolean;
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    expect(err.killed, 'the command hung instead of exiting').not.toBe(true);
    expect(err.code, 'the command succeeded when it should have failed').toBe(1);
    expect(`${err.stdout ?? ''}${err.stderr ?? ''}`).toMatch(expected);
  };

  it(
    'exits when the adapter rejects the invocation',
    async () => {
      // `--` with nothing after it: the adapter has no command to run and says so in `prepare`,
      // which is where the proxy is already listening and the hang used to happen.
      //
      // `orca record node agent.mjs` — the `--` left out entirely — was the original way in, and
      // `assertNoStrayPositionals` now refuses that before the proxy is ever opened. Better for the
      // user and useless here: the point is to throw *inside* the guarded window, so the case has
      // to be one that reaches `prepare` rather than one that is turned away before it.
      await failsWith(['record', 'node', '--'], /needs the command to run/);
    },
    timeout,
  );

  it(
    'exits when the agent is not on PATH',
    async () => {
      await failsWith(
        ['record', 'node', '--', 'orca-no-such-binary'],
        /could not launch "orca-no-such-binary"/,
      );
    },
    timeout,
  );

  it(
    'exits when the adapter name is not one it knows',
    async () => {
      await failsWith(['record', 'no-such-adapter', '--', 'node', '-e', '0'], /unknown adapter/);
    },
    timeout,
  );

  /**
   * A run that died is sealed rather than discarded, so it can be read — and reading it has to say
   * that it died.
   *
   * The trace is sealed with its exit code deliberately absent, because a run whose agent never
   * started has no exit code rather than a zero one. `orca show` rendered that absence as
   * `exit 0`, so the one run you would open precisely because something went wrong presented
   * itself as a clean success. `--json` had it right as `null` the whole time.
   */
  it('seals a died run so it can be read, and does not call it a success', async () => {
    await run(process.execPath, [cli, 'record', 'node', '--', 'orca-no-such-binary'], {
      cwd: dir,
      env: bare,
      timeout: 60_000,
    }).catch(() => undefined);

    const runs = join(dir, '.orca', 'runs');
    const [id] = await readdir(runs);
    expect(id, 'the failed run left no trace at all').toBeDefined();

    // Sealed: the fields `verifyIntegrity` needs to call it finished rather than tampered with.
    const manifest = JSON.parse(await readFile(join(runs, id!, 'manifest.json'), 'utf8')) as {
      ended_at?: string;
      integrity?: unknown;
      exit_code?: number;
    };
    expect(manifest.ended_at).toBeDefined();
    expect(manifest.integrity).toBeDefined();
    expect(manifest.exit_code, 'an unknown exit code must not be recorded as one').toBeUndefined();

    const { stdout } = await run(process.execPath, [cli, 'show', id!], { cwd: dir, env: bare });
    expect(stdout).not.toMatch(/events {2}exit 0/);
    expect(stdout).toContain('never finished');
  }, 60_000);
});
