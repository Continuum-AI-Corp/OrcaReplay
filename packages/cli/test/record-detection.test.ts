import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-detect-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/**
 * Detection answers "which agent is in use here". It must not answer it when the command line
 * already did.
 *
 * `detect` is machine-wide by construction — every adapter's is `detectAgent(binaries, homePaths)`,
 * which asks whether a binary is on PATH or a directory exists under `$HOME`. Neither is a fact
 * about `cwd`. That is the right question for "is this agent even installed", and the wrong one for
 * "what should I launch", and `orca record -- python my_graph.py` was answering the second with the
 * first:
 *
 *     $ orca record -- python my_graph.py     # in a LangGraph project
 *     info adapter.detected id=claude-code
 *     API Error: 400 unknown provider for model claude-opus-5
 *
 * Claude Code ran. `python my_graph.py` was handed to it as arguments and never launched. The run
 * was recorded, so the failure looks like a bad API key rather than like orca starting the wrong
 * program.
 *
 * A command after `--` is not a hint about the environment. It is the answer.
 */
describe('orca record, when the command line already says what to run', () => {
  const timeout = 60_000;
  const bare = { ...process.env, NO_COLOR: '1', OPENAI_API_KEY: 'stub-key' };

  /** Run the built CLI, returning what it printed whether or not it succeeded. */
  async function orca(
    argv: string[],
    env: NodeJS.ProcessEnv = {},
  ): Promise<{ code: number; said: string }> {
    try {
      const { stdout, stderr } = await run(process.execPath, [cli, ...argv], {
        cwd: dir,
        env: { ...bare, ...env },
        timeout: timeout - 10_000,
      });
      return { code: 0, said: `${stdout}${stderr}` };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? -1, said: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  it(
    'does not detect an agent when a command was given after --',
    async () => {
      await writeFile(join(dir, 'agent.mjs'), "process.stdout.write('MINE RAN');\n");
      const { said } = await orca(['record', '--', 'node', 'agent.mjs']);

      expect(said, 'it picked an agent instead of running the command').not.toMatch(
        /adapter\.detected/,
      );
      expect(said, 'the command on the line was not the one that ran').toContain('MINE RAN');
    },
    timeout,
  );

  /**
   * And the adapter it falls back to has to redirect something.
   *
   * `exec` was the first choice here and it is the wrong one: both it and `generic-openai` decline
   * to guess what the command is, but only the second redirects anything. `exec` points the agent
   * nowhere and warns that interception is required — correct for a Go binary with its origin
   * compiled in, and useless as a default, since most things run this way read a base-URL variable.
   * Sending everyone to `--tls-intercept` to record a Python script would be a worse answer than the
   * bug it replaced.
   */
  it(
    'falls back to an adapter that actually redirects',
    async () => {
      await writeFile(
        join(dir, 'shows-env.mjs'),
        `process.stdout.write('BASE=' + (process.env.OPENAI_BASE_URL ?? 'unset'));${'\n'}`,
      );
      const { said } = await orca(['record', '--', 'node', 'shows-env.mjs']);
      expect(said).toMatch(/BASE=http:\/\/127\.0\.0\.1:\d+/);
      expect(said, 'it fell back to something that redirects nothing').not.toMatch(
        /tls\.intercept_required/,
      );
    },
    timeout,
  );

  /**
   * And it still detects when there is nothing else to go on — the case detection was written for,
   * and the one this must not break.
   *
   * Detection reads `PATH` and `$HOME`, so the test supplies both: a `claude` shim at the front of
   * PATH, and a home with no agent config under it. That makes the answer the same on every
   * machine, and — the reason it is written this way — means the run launches the shim rather than
   * whatever real agent the machine running the suite happens to have installed.
   */
  it(
    'still detects when no command and no agent name were given',
    async () => {
      const bin = join(dir, 'bin');
      await mkdir(bin);
      const shim = join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
      const script =
        process.platform === 'win32'
          ? ['@echo off', 'echo SHIM RAN'].join('\r\n')
          : ['#!/bin/sh', 'echo SHIM RAN'].join('\n');
      await writeFile(shim, `${script}\n`);
      await chmod(shim, 0o755);

      // Prepended, not replaced. `hasBinary` shells out to `which` on POSIX, and a PATH holding
      // only the shim dir cannot find `which` itself — detection then answers false for every
      // adapter and the test fails on Linux for a reason that has nothing to do with the code
      // under it. Prepending is enough to make the answer deterministic anyway: `claude-code` is
      // the first adapter the registry tries, and PATH is walked in order, so the shim wins over
      // any real agent the machine running the suite happens to have installed.
      const path = `${bin}${delimiter}${process.env.PATH ?? ''}`;
      const { said } = await orca(['record'], {
        PATH: path,
        Path: path,
        HOME: dir,
        USERPROFILE: dir,
      });

      expect(said, 'detection no longer runs when there is nothing else to go on').toMatch(
        /adapter\.detected id=claude-code/,
      );
      expect(said, 'it detected an agent and then did not launch it').toContain('SHIM RAN');
    },
    timeout,
  );

  it(
    'still uses the agent when one is named, even with a command after --',
    async () => {
      const { said } = await orca(['record', 'generic-openai', '--', 'node', '-e', '0']);
      expect(said, 'a named agent should not be re-detected').not.toMatch(/adapter\.detected/);
      expect(said).toMatch(/adapter=generic-openai/);
    },
    timeout,
  );
});
