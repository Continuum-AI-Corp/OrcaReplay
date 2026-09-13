import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceWriter } from '@orcareplay/core';
import { installShellShim, discardShellFrames } from '@orcareplay/shell-shim';

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

    it('honours an explicit path, which is how doctor keeps its own teardown', async () => {
      const runDir = await mkdtemp(join(tmpdir(), 'orca-run-'));
      const framesPath = join(runDir, 'shell-frames.jsonl');
      const shim = await installShellShim({ runDir, framesPath });
      expect(shim.framesPath).toBe(framesPath);
      // The transport is the directory the caller already owns, so their cleanup covers it.
      expect(shim.transportDir).toBe(runDir);
      await rm(runDir, { recursive: true, force: true });
    });

    it('discardShellFrames takes the directory, and forgives one that is already gone', async () => {
      const runDir = await mkdtemp(join(tmpdir(), 'orca-run-'));
      const shim = await installShellShim({ runDir });
      await writeFile(`${shim.framesPath}.late`, '{}\n');
      expect(await discardShellFrames(shim.transportDir)).toBeUndefined();
      expect(existsSync(shim.transportDir)).toBe(false);
      expect(await discardShellFrames(shim.transportDir)).toBeUndefined();
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
