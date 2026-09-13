import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceWriter } from '@orcareplay/core';
import { installShellShim, discardShellFrames } from '@orcareplay/shell-shim';
import { installAgentSpans, sweepStaleTransports } from '../src/agent-spans.js';

/**
 * Watching the transport rather than looking for it.
 *
 * The obvious test — "no `orca-shell-*` directory is left in the temp dir" — is not deterministic:
 * vitest runs test files in parallel and several of them record, so another file's transport can
 * appear in the window between the snapshots. And the path cannot be fixed from here either:
 * `record` passes it to the shim through the generated script's argv, not through the environment
 * (`record.ts:385` sets `PATH` and nothing else), so a fixture cannot be pointed at a known file.
 * What is actually under test is that `record` disposes of what it minted, so that is what is
 * asserted.
 */
const shimSpy = vi.hoisted(() => ({ minted: [] as string[], discarded: [] as string[] }));
vi.mock('@orcareplay/shell-shim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcareplay/shell-shim')>();
  return {
    ...actual,
    installShellShim: async (options: Parameters<typeof actual.installShellShim>[0]) => {
      const shim = await actual.installShellShim(options);
      shimSpy.minted.push(shim.transportDir);
      return shim;
    },
    discardShellFrames: async (dir: string) => {
      shimSpy.discarded.push(dir);
      return actual.discardShellFrames(dir);
    },
  };
});
import { parseArgs } from '../src/args.js';
import { recordCommand } from '../src/commands/record.js';
import { scrubCommand } from '../src/commands/scrub.js';
import { Output } from '../src/out.js';

/**
 * A run directory is shared material, and not all of it is the trace.
 *
 * Three files were written by something other than `TraceWriter`, so none of them had been through
 * the redactor: the agent-spans transport, the shell shim's frames, and the MCP frames. The first
 * two are transports — read once, during the run that made them — and they are gone from the run
 * directory. The third is not: a replay answers the agent's MCP calls out of it, so it stays, and
 * what has to change is that `orca scrub` stops claiming it looked.
 */
describe('what a run directory is left holding', () => {
  const exec = promisify(execFile);
  let workspace: string;

  beforeEach(async () => {
    shimSpy.minted.length = 0;
    shimSpy.discarded.length = 0;
    workspace = await mkdtemp(join(tmpdir(), 'orca-sidecar-'));
    await exec('git', ['init', '-q'], { cwd: workspace });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: workspace });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  /** One recorded run in the workspace, and where it landed. */
  async function record(): Promise<{ runDir: string; runId: string }> {
    const agent = join(workspace, 'agent.mjs');
    await writeFile(agent, "console.log('GOT: done');\n");
    const result = await recordCommand(
      parseArgs(['record', 'generic-openai', '--', process.execPath, agent]),
      new Output({ write: () => {}, isTTY: false }),
      workspace,
    );
    return { runDir: join(workspace, '.orca', 'runs', result.runId), runId: result.runId };
  }

  /** Everything `orca scrub` said, as one string. */
  async function scrub(runId: string, match: string): Promise<string> {
    const lines: string[] = [];
    await scrubCommand(
      parseArgs(['scrub', runId, '--match', match]),
      new Output({ write: (text: string) => lines.push(text), isTTY: false }),
      workspace,
    );
    return lines.join('\n');
  }

  describe('the shell frames transport', () => {
    it('is not in the run directory, and the bootstrap still is', async () => {
      const runDir = await mkdtemp(join(tmpdir(), 'orca-run-'));
      const shim = await installShellShim({ runDir });
      expect(shim.framesPath.startsWith(runDir), 'the frames are in the run directory').toBe(false);
      expect(shim.transportDir.startsWith(runDir)).toBe(false);
      expect(shim.dir.startsWith(runDir), 'the shims belong with the run').toBe(true);
      // Existence, not mode: NTFS has no mode bits, so the 0600 assertion can only run on POSIX and
      // without this a pre-create that stopped happening would be caught on Linux and nowhere else.
      expect(existsSync(shim.framesPath), 'orca did not create the transport itself').toBe(true);
      await rm(runDir, { recursive: true, force: true });
      await rm(shim.transportDir, { recursive: true, force: true });
    });

    /**
     * A caller who names the path owns the directory, and orca does not get to delete it.
     *
     * This asserted the opposite — `transportDir === runDir` — with a comment calling it fine
     * because "their cleanup covers it". It does not: `discardShellFrames` is `rm -rf`, and
     * `record` deletes every registered transport when a run throws. Nothing wired the two
     * together, so nothing was broken, but the test had written the shape into the specification,
     * which is where the next person would have read it.
     */
    it('claims no transport when the caller named the path', async () => {
      const runDir = await mkdtemp(join(tmpdir(), 'orca-run-'));
      const framesPath = join(runDir, 'shell-frames.jsonl');
      const shim = await installShellShim({ runDir, framesPath });
      expect(shim.framesPath).toBe(framesPath);
      expect(shim.transportDir, 'orca claimed a directory it did not mint').toBeUndefined();
      await rm(runDir, { recursive: true, force: true });
    });

    it('records the process that minted it, which is how a sweep tells it apart', async () => {
      const runDir = await mkdtemp(join(tmpdir(), 'orca-run-'));
      const shim = await installShellShim({ runDir });
      const spans = await installAgentSpans(runDir);
      for (const dir of [shim.transportDir!, spans.transportDir]) {
        expect(await readFile(join(dir, 'owner.pid'), 'utf8')).toBe(String(process.pid));
      }
      await rm(runDir, { recursive: true, force: true });
      await rm(shim.transportDir!, { recursive: true, force: true });
      await rm(spans.transportDir, { recursive: true, force: true });
    });

    it('discardShellFrames takes the directory, and forgives one that is already gone', async () => {
      const runDir = await mkdtemp(join(tmpdir(), 'orca-run-'));
      const shim = await installShellShim({ runDir });
      await writeFile(`${shim.framesPath}.late`, '{}\n');
      const transportDir = shim.transportDir!;
      expect(await discardShellFrames(transportDir)).toBeUndefined();
      expect(existsSync(transportDir)).toBe(false);
      expect(await discardShellFrames(transportDir)).toBeUndefined();
      await rm(runDir, { recursive: true, force: true });
    });

    /**
     * The command line is the point. A frame holds `argv` verbatim — `curl -H 'Authorization:
     * Bearer …'`, `git clone https://user:token@host/…` — while the `shell.exec` event derived from
     * the same frame goes through the redactor. Leaving the file in the run directory meant the
     * trace was redacted and the copy beside it was not.
     */
    it('leaves no command line in the run directory, while the event still carries it redacted', async () => {
      const agent = join(workspace, 'agent.mjs');
      await writeFile(agent, "console.log('GOT: done');\n");
      const out = new Output({ write: () => {}, isTTY: false });
      const result = await recordCommand(
        parseArgs(['record', 'generic-openai', '--', process.execPath, agent]),
        out,
        workspace,
      );
      const runDir = join(workspace, '.orca', 'runs', result.runId);

      expect(
        (await readdir(runDir)).filter((f) => f.startsWith('shell-frames')),
        'the frames transport is in the trace',
      ).toEqual([]);

      expect(shimSpy.minted.length, 'no shim transport was minted').toBe(1);
      expect(shimSpy.discarded, 'the transport outlived the run').toEqual(shimSpy.minted);
      expect(existsSync(shimSpy.minted[0]!), 'the transport directory is still there').toBe(false);
    }, 60_000);

    /**
     * The failure path, which is where a transport is most likely to be left: the run threw, so
     * nothing reached the drain that would have removed it. `recordCommand` owns it for exactly
     * this case — the same shape as the CA it already disposes of there.
     */
    it('takes the transport with it when the run throws', async () => {
      const agent = join(workspace, 'agent.mjs');
      await writeFile(agent, "console.log('GOT: done');\n");
      // Fail late, after the shim is installed and the agent has run, which is the window the
      // teardown exists for.
      let appends = 0;
      const spy = vi.spyOn(TraceWriter.prototype, 'append').mockImplementation(async function (
        this: TraceWriter,
        ...args: unknown[]
      ) {
        appends += 1;
        if (appends > 2) throw new Error('appending failed on purpose');
        return (
          TraceWriter.prototype.append as unknown as (...a: unknown[]) => Promise<unknown>
        ).apply(this, args) as never;
      } as never);

      try {
        await expect(
          recordCommand(
            parseArgs(['record', 'generic-openai', '--', process.execPath, agent]),
            new Output({ write: () => {}, isTTY: false }),
            workspace,
          ),
        ).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }

      expect(shimSpy.minted.length, 'no shim transport was minted').toBe(1);
      // Possibly twice — the drain reached it before the append threw, and the catch is
      // belt-and-braces. `rm` with `force` is idempotent, so what matters is that it happened.
      expect(shimSpy.discarded, 'a failed run left its transport behind').toContain(
        shimSpy.minted[0],
      );
      expect(existsSync(shimSpy.minted[0]!), 'the transport directory is still there').toBe(false);
    }, 60_000);
  });

  /**
   * A transport outlives its run when orca is killed — `SIGKILL`, `taskkill`, a power cut — because
   * the drain and the failure path both need orca's own process to still be running. Nothing at
   * exit can help, so the only thing that ever comes across an orphan is the next run.
   *
   * Whose it is, not how old it is. Age was the first answer and it was wrong: a transport
   * directory's mtime never moves after `mkdtemp` creates it, because every frame afterwards is an
   * append to the file inside, and appending does not touch the containing directory. "Older than
   * a day" therefore meant "this recording started more than a day ago", so a second `orca record`
   * would collect a live transport and that run would capture nothing more — silently, because
   * both writers swallow their errors by design.
   */
  describe('transports left by a run that never came back', () => {
    /** A pid that is certainly not running: a child that has already exited. */
    async function deadPid(): Promise<number> {
      const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
      const pid = child.pid!;
      await new Promise((resolve) => child.on('exit', resolve));
      return pid;
    }

    /**
     * A pid that is running and is *not* this process.
     *
     * Using our own passed while the code still had a `owner === process.pid` short-circuit in
     * front of the liveness probe, so the test never reached the line it was for.
     */
    const alive: { child?: ReturnType<typeof spawn> } = {};
    function livePid(): number {
      alive.child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
        stdio: 'ignore',
      });
      return alive.child.pid!;
    }
    afterEach(() => {
      alive.child?.kill();
      alive.child = undefined;
    });

    /**
     * A transport under `root`, belonging to `owner`, with a frame already in it.
     *
     * `idleHours` ages its *contents*, which is what the sweep reads — appending moves the file's
     * mtime and never the directory's, and reading the directory's is what the version before last
     * got wrong.
     */
    async function transport(
      root: string,
      name: string,
      owner: number,
      idleHours = 0,
    ): Promise<string> {
      const dir = join(root, name);
      await mkdir(dir);
      await writeFile(join(dir, 'shell-frames.jsonl'), '{"argv":["sh","-c","echo hi"]}\n');
      await writeFile(join(dir, 'owner.pid'), String(owner));
      if (idleHours > 0) {
        const when = new Date(Date.now() - idleHours * 60 * 60 * 1000);
        for (const name of ['shell-frames.jsonl', 'owner.pid']) {
          await utimes(join(dir, name), when, when);
        }
      }
      return dir;
    }

    /** A directory of this test's own, so a sweep here cannot reach anything else running. */
    async function sweepRoot(): Promise<string> {
      return mkdtemp(join(tmpdir(), 'orca-sweep-root-'));
    }
    // In a directory of its own, because sweeping the machine's temp directory from a test takes
    // whatever else is running with it.
    it('takes one whose owner has gone and leaves one whose owner has not', async () => {
      const root = await sweepRoot();
      const gone = await transport(root, 'orca-shell-gone', await deadPid(), 48);
      const live = await transport(root, 'orca-spans-live', livePid());

      expect(await sweepStaleTransports(root)).toBe(1);
      expect(existsSync(gone), 'an abandoned transport was left behind').toBe(false);
      expect(existsSync(live), 'a transport whose owner is still running was taken').toBe(true);
      await rm(root, { recursive: true, force: true });
    });

    /**
     * The case the age test could never have caught: a recording that has been going a long time
     * and is still appending. Its directory's mtime is as old as the run, and its owner is alive.
     */
    it('leaves a long-running recording’s transport alone however old the directory is', async () => {
      const root = await sweepRoot();
      // Owner alive, directory ancient, contents idle: the owner alone decides, and none of the
      // rest is consulted.
      const live = await transport(root, 'orca-shell-ancient', livePid(), 48);
      const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await utimes(live, ancient, ancient);

      expect(await sweepStaleTransports(root)).toBe(0);
      expect(existsSync(live), 'a live run’s transport was swept for being old').toBe(true);
      await rm(root, { recursive: true, force: true });
    });

    it.each([
      ['no owner file at all', undefined],
      ['an owner that is not a number', 'not-a-pid'],
      // `0` is this process's group and `-1` is every process the user may signal. Neither may ever
      // reach the liveness probe, let alone anything that deletes.
      ['an owner of 0', '0'],
      ['an owner of -1', '-1'],
    ])('leaves a directory with %s alone', async (_what, owner) => {
      const root = await sweepRoot();
      const dir = join(root, 'orca-shell-odd');
      await mkdir(dir);
      await writeFile(join(dir, 'shell-frames.jsonl'), '{}\n');
      if (owner !== undefined) await writeFile(join(dir, 'owner.pid'), owner);
      // Long silent, so the owner check is the only thing that can be keeping it. With fresh
      // contents the idle gate saves it whatever the owner says, and the assertion passes without
      // reaching the line it exists for.
      const long = new Date(Date.now() - 48 * 60 * 60 * 1000);
      for (const name of await readdir(dir)) await utimes(join(dir, name), long, long);

      expect(await sweepStaleTransports(root)).toBe(0);
      expect(existsSync(dir), 'a directory it could not reason about was deleted').toBe(true);
      await rm(root, { recursive: true, force: true });
    });

    /**
     * A pid means nothing outside the namespace it was written in.
     *
     * A temp directory can be shared across them — `/tmp` bind-mounted into a devcontainer, a CI
     * job with a shared tmp volume, an NFS `/tmp` — and there the owner of a live recording is
     * simply absent from this process's pid table. `ESRCH` then says "no such process" about a run
     * that is still writing, which is why an unresolvable owner is not enough on its own.
     */
    it('leaves a transport whose owner is unresolvable but whose frames are fresh', async () => {
      const root = await sweepRoot();
      // Not in this pid table, and not a process that ever will be.
      const elsewhere = await transport(root, 'orca-shell-elsewhere', 987_654);

      expect(await sweepStaleTransports(root)).toBe(0);
      expect(existsSync(elsewhere), 'a live run in a shared temp directory was collected').toBe(
        true,
      );
      await rm(root, { recursive: true, force: true });
    });

    /**
     * A transport that cannot be listed is not evidence of anything, least of all of abandonment.
     * POSIX only: making a directory unlistable on NTFS needs an ACL edit, and the suite should not
     * be editing ACLs.
     */
    it.skipIf(process.platform === 'win32')(
      'leaves a transport it cannot look inside alone',
      async () => {
        const root = await sweepRoot();
        const dir = await transport(root, 'orca-shell-sealed', 987_654, 48);
        await chmod(dir, 0o000);
        try {
          expect(await sweepStaleTransports(root)).toBe(0);
          expect(existsSync(dir), 'a transport it could not read was deleted').toBe(true);
        } finally {
          await chmod(dir, 0o700);
        }
        await rm(root, { recursive: true, force: true });
      },
    );

    it('takes one whose owner is unresolvable and whose frames have not moved in a day', async () => {
      const root = await sweepRoot();
      const abandoned = await transport(root, 'orca-shell-abandoned', 987_654, 48);

      expect(await sweepStaleTransports(root)).toBe(1);
      expect(existsSync(abandoned), 'a genuine orphan was left behind').toBe(false);
      await rm(root, { recursive: true, force: true });
    });

    /**
     * Exists, but belongs to somebody else: the probe gets `EPERM` rather than an answer, and that
     * counts as running. `/tmp` is shared, and deleting another user's live transport is the same
     * mistake as deleting our own.
     */
    it('leaves a transport whose owner belongs to another user alone', async () => {
      const root = await sweepRoot();
      // A process that is certainly there and certainly not ours.
      const systemPid = process.platform === 'win32' ? 4 : 1;
      // Silent for two days, so `EPERM counts as running` is the only thing keeping it.
      const dir = await transport(root, 'orca-spans-elsewhere', systemPid, 48);

      expect(await sweepStaleTransports(root)).toBe(0);
      expect(existsSync(dir), 'another user’s live transport was deleted').toBe(true);
      await rm(root, { recursive: true, force: true });
    });

    /**
     * Through `record`, not by calling the sweep: what has to hold is that a recording collects
     * what a killed one left, and a test that calls the sweep itself keeps passing when nothing
     * calls it.
     */
    it('is what a recording does before anything else', async () => {
      const orphan = await mkdtemp(join(tmpdir(), 'orca-shell-'));
      await writeFile(join(orphan, 'shell-frames.jsonl'), '{"argv":["sh","-c","echo hi"]}\n');
      await writeFile(join(orphan, 'owner.pid'), String(await deadPid()));
      const long = new Date(Date.now() - 48 * 60 * 60 * 1000);
      for (const name of ['shell-frames.jsonl', 'owner.pid']) {
        await utimes(join(orphan, name), long, long);
      }

      await record();

      expect(existsSync(orphan), 'a recording walked past an orphaned transport').toBe(false);
    }, 60_000);

    it('is silent about a temp directory it has no business in', async () => {
      const root = await sweepRoot();
      const other = join(root, 'not-orca-at-all');
      await mkdir(other);
      // Owned by a process that is gone, so only the name is keeping it alive.
      await writeFile(join(other, 'owner.pid'), String(await deadPid()));
      expect(await sweepStaleTransports(root)).toBe(0);
      expect(existsSync(other), 'the sweep took a directory that was not orca’s').toBe(true);
      await rm(root, { recursive: true, force: true });
    });
  });

  describe('orca scrub over what it does not rewrite', () => {
    /**
     * `mcp-frames.jsonl` cannot be deleted — a replay answers from it — and must not be rewritten:
     * the frames are keyed on the request, so an edited one is not missed, it is *mismatched*, and
     * the replay is served a different recorded response with nothing reported. Searching it is
     * what is left, and it is enough to stop the lie.
     */
    it('names a file it did not rewrite instead of reporting nothing matched', async () => {
      const secret = 'sk-scrubcanary0123456789abcdefgh';
      const agent = join(workspace, 'agent.mjs');
      await writeFile(agent, "console.log('GOT: done');\n");
      const out = new Output({ write: () => {}, isTTY: false });
      const result = await recordCommand(
        parseArgs(['record', 'generic-openai', '--', process.execPath, agent]),
        out,
        workspace,
      );
      const runDir = join(workspace, '.orca', 'runs', result.runId);
      // As a replay would have left it.
      await writeFile(
        join(runDir, 'mcp-frames.jsonl'),
        `${JSON.stringify({ name: 's', direction: 'out', message: { result: { token: secret } } })}\n`,
      );

      const lines: string[] = [];
      const scrubOut = new Output({ write: (s: string) => lines.push(s), isTTY: false });
      await scrubCommand(
        parseArgs(['scrub', result.runId, '--match', secret]),
        scrubOut,
        workspace,
      );
      const said = lines.join('\n');

      expect(said, 'a clean bill over a file it never opened').not.toContain('nothing matched');
      expect(said).toContain('not_scrubbed');
      expect(said).toContain('mcp-frames.jsonl');
      // And it did not rewrite it, because rewriting it would corrupt the replay silently.
      expect(await readFile(join(runDir, 'mcp-frames.jsonl'), 'utf8')).toContain(secret);
    }, 60_000);

    /**
     * The covered set has to be right in both directions. Naming a file scrub rewrote would send
     * the reader to delete a run over something that was about to be removed anyway — and the scan
     * runs before the rewrite lands, so a wrong covered set is not self-correcting.
     *
     * `--dry-run` and a literal the redactor does not catch: a secret-shaped one never reaches
     * `events.jsonl` verbatim, because the write path already removed it.
     */
    it('does not name a file it rewrites, only one it never opened', async () => {
      const literal = `internal-${process.pid}.corp.invalid`;
      const agent = join(workspace, 'agent.mjs');
      await writeFile(agent, "console.log('GOT: done');\n");
      // Through the recorded argv, which reaches `manifest.json` — a file scrub does rewrite. A
      // shell command would have been the closer fixture, but `sh` is not dependable here, and a
      // secret-shaped literal never reaches the trace verbatim because the write path removes it.
      const result = await recordCommand(
        parseArgs([
          'record',
          'generic-openai',
          '--',
          process.execPath,
          agent,
          `--endpoint=https://${literal}/x`,
        ]),
        new Output({ write: () => {}, isTTY: false }),
        workspace,
      );
      const runDir = join(workspace, '.orca', 'runs', result.runId);
      expect(
        await readFile(join(runDir, 'manifest.json'), 'utf8'),
        'the fixture never got the literal into a covered file',
      ).toContain(literal);

      const lines: string[] = [];
      await scrubCommand(
        parseArgs(['scrub', result.runId, '--match', literal, '--dry-run']),
        new Output({ write: (t: string) => lines.push(t), isTTY: false }),
        workspace,
      );
      const said = lines.join('\n');
      // The dry-run plan does name `manifest.json` — as a file it *would* rewrite. What must not
      // appear is the warning for files it never opened.
      expect(said, 'scrub named a file it was about to rewrite').not.toContain('not_scrubbed');
    }, 60_000);

    /**
     * The all-clear must never be printed over a file nobody opened, and every reason a read fails
     * is a reason to say so: a file another process holds open, a path this user cannot read, a
     * file past the runtime's string limit. Swallowing them was a clean bill over a file the scan
     * skipped — the one failure SECURITY.md says a scrubber must not have.
     *
     * The fixture is the string-limit one because it is the only portable one: `ftruncate` makes a
     * sparse file of any size in no time and costs no disk, while a locked file needs Windows and a
     * mode-zero file needs POSIX.
     */
    it('says it could not read a file rather than calling the run clean', async () => {
      const { runDir, runId } = await record();
      const handle = await open(join(runDir, 'mcp-frames.jsonl'), 'w');
      try {
        await handle.truncate(600 * 1024 * 1024); // past MAX_STRING_LENGTH; sparse, so instant
      } finally {
        await handle.close();
      }

      const said = await scrub(runId, 'sk-whatever0000000000000000000');
      expect(said, 'a clean bill over a file it could not open').not.toContain('nothing matched');
      expect(said).toContain('not_searched');
      expect(said).toContain('mcp-frames.jsonl');
    }, 60_000);

    /**
     * Two answers, two messages. "the hostname you named is still in this file" and "this file
     * contains a base64 image" have different correct next steps, and one sentence serving both
     * made the alarming case indistinguishable from the routine one — a recorded screenshot trips
     * the entropy sweep on every MCP run.
     */
    it('separates a file holding what was asked for from one the detectors merely flag', async () => {
      const { runDir, runId } = await record();
      const frames = join(runDir, 'mcp-frames.jsonl');

      // Nothing but an image: the detectors flag it, the caller never asked about it.
      const image = randomBytes(400).toString('base64');
      await writeFile(frames, `${JSON.stringify({ result: { image } })}\n`);
      const onlyDetected = await scrub(runId, 'sk-absent00000000000000000000');
      expect(onlyDetected).toContain('not_scrubbed_detected');
      expect(
        onlyDetected,
        'an image was reported as the thing the caller asked to remove',
      ).not.toContain('not_scrubbed path');
      expect(onlyDetected).not.toContain('nothing matched');

      // The literal the caller named.
      const secret = `sk-named${process.pid}abcdefghijklmnop`;
      await writeFile(frames, `${JSON.stringify({ result: { token: secret } })}\n`);
      const named = await scrub(runId, secret);
      expect(named).toContain('not_scrubbed path');
      expect(named).toContain('still hold what you asked to remove');
    }, 60_000);

    // POSIX only: NTFS needs an ACL edit to make a directory unlistable, and the suite should not
    // be editing ACLs. The file case above is portable and covers the same swallow.
    it.skipIf(process.platform === 'win32')(
      'says it could not list a directory rather than calling the run clean',
      async () => {
        const { runDir, runId } = await record();
        const hidden = join(runDir, 'logs');
        await mkdir(hidden);
        await writeFile(join(hidden, 'agent.log'), 'sk-inthere000000000000000000000\n');
        await chmod(hidden, 0o000);
        try {
          const said = await scrub(runId, 'sk-inthere000000000000000000000');
          expect(said, 'a clean bill over a directory it could not list').not.toContain(
            'nothing matched',
          );
          expect(said).toContain('not_searched');
        } finally {
          await chmod(hidden, 0o700);
        }
      },
      60_000,
    );

    it('still says nothing matched when there is genuinely nothing', async () => {
      const agent = join(workspace, 'agent.mjs');
      await writeFile(agent, "console.log('GOT: done');\n");
      const out = new Output({ write: () => {}, isTTY: false });
      const result = await recordCommand(
        parseArgs(['record', 'generic-openai', '--', process.execPath, agent]),
        out,
        workspace,
      );
      const lines: string[] = [];
      const scrubOut = new Output({ write: (s: string) => lines.push(s), isTTY: false });
      await scrubCommand(
        parseArgs(['scrub', result.runId, '--match', 'sk-absent0000000000000000000000']),
        scrubOut,
        workspace,
      );
      const said = lines.join('\n');
      expect(said, 'the all-clear must still be reachable').toContain('nothing matched');
      expect(said).not.toContain('not_scrubbed');
    }, 60_000);
  });
});
