import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceWriter } from '@orcareplay/core';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { stripAnsi } from '../src/out.js';
import { doctorCommand, type DoctorCheck, type DoctorResult } from '../src/commands/doctor.js';
import { main } from '../src/main.js';

/**
 * `orca doctor` exists because this tool injects environment variables into someone else's
 * process and shells out to git. When that does not work the user has no way to see why, so the
 * one thing doctor may never do is be vague — or be wrong about its own verdict.
 */
describe('orca doctor — the capture layers', () => {
  /**
   * `orca doctor` answers "will recording actually work here", and it checked node, git, the
   * workspace, disk, a port and which agents are installed — but not two of the four capture
   * layers it exists to vouch for. Both fail in the same quiet way: the shim is never reached, the
   * agent runs perfectly, and the trace is simply missing a layer nobody notices until they go
   * looking for an exit code that was never recorded.
   *
   * `mcp.ts` even had a `shimIsRunnable()` whose docstring reads "Exposed for the doctor command".
   * Nothing imported it.
   */
  it('checks the shell shim, since a broken one loses exit codes silently', async () => {
    const lines: string[] = [];
    const out = new Output({ write: (l) => void lines.push(l), isTTY: false });
    const result = await doctorCommand(parseArgs(['doctor']), out, process.cwd());
    const check = result.checks.find((c) => c.name.includes('shell'));
    expect(
      check,
      `no shell check in: ${result.checks.map((c) => c.name).join(', ')}`,
    ).toBeDefined();
    expect(check!.status).toBe('ok');
  });

  it('checks the MCP shim', async () => {
    const lines: string[] = [];
    const out = new Output({ write: (l) => void lines.push(l), isTTY: false });
    const result = await doctorCommand(parseArgs(['doctor']), out, process.cwd());
    const check = result.checks.find((c) => c.name.includes('mcp'));
    expect(check, `no mcp check in: ${result.checks.map((c) => c.name).join(', ')}`).toBeDefined();
    expect(check!.status).toBe('ok');
  });
});

describe('doctor', () => {
  let cwd: string;
  let out: Output;
  let lines: string[];
  const realVersion = process.version;
  const realPath = process.env['PATH'];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-doctor-'));
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
  });

  afterEach(async () => {
    Object.defineProperty(process, 'version', { value: realVersion, configurable: true });
    process.env['PATH'] = realPath;
    await rm(cwd, { recursive: true, force: true });
  });

  const text = () => stripAnsi(lines.join(''));
  const find = (result: DoctorResult, name: string): DoctorCheck => {
    const check = result.checks.find((c) => c.name === name);
    if (!check) throw new Error(`no check named ${name}: ${result.checks.map((c) => c.name)}`);
    return check;
  };
  const run = () => doctorCommand(parseArgs(['doctor']), out, cwd);

  describe('shape', () => {
    it('reports every check with a status and a detail worth reading', async () => {
      const result = await run();
      expect(result.checks.length).toBeGreaterThanOrEqual(7);
      for (const check of result.checks) {
        expect(check.name, 'a check needs a name').toBeTruthy();
        expect(['ok', 'warn', 'fail']).toContain(check.status);
        expect(check.detail, `${check.name} has no detail`).toBeTruthy();
      }
    });

    it('gives every non-ok check something to actually do about it', async () => {
      process.env['PATH'] = cwd; // no git, no which: several checks go non-ok at once
      const result = await run();
      const notOk = result.checks.filter((c) => c.status !== 'ok');
      expect(notOk.length, 'this fixture must produce at least one non-ok check').toBeGreaterThan(
        0,
      );
      for (const check of notOk) {
        expect(check.fix, `${check.name} is ${check.status} with no fix`).toBeTruthy();
      }
    });

    it('prints the table people will paste into a bug report', async () => {
      await run();
      expect(text()).toMatch(/CHECK\s+STATUS\s+DETAIL/);
    });
  });

  describe('verdict', () => {
    it('is not ok when a check fails', async () => {
      Object.defineProperty(process, 'version', { value: 'v18.20.0', configurable: true });
      const result = await run();
      expect(find(result, 'node version').status).toBe('fail');
      expect(result.ok, 'a failing check must make the whole command fail').toBe(false);
    });

    it('stays ok when checks only warn', async () => {
      // A bare temp directory is not a git repo, so this run warns and must still pass.
      const result = await run();
      expect(result.checks.some((c) => c.status === 'warn')).toBe(true);
      expect(result.checks.some((c) => c.status === 'fail')).toBe(false);
      expect(result.ok).toBe(true);
    });
  });

  describe('node version', () => {
    it('fails below 20 and says what to install', async () => {
      Object.defineProperty(process, 'version', { value: 'v18.20.0', configurable: true });
      const check = find(await run(), 'node version');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('18');
      expect(check.fix).toMatch(/20/);
    });

    it('passes on the version actually running these tests', async () => {
      expect(find(await run(), 'node version').status).toBe('ok');
    });
  });

  describe('git', () => {
    it('warns rather than fails when git is missing, because capture only degrades', async () => {
      process.env['PATH'] = cwd;
      const result = await run();
      expect(find(result, 'git').status).toBe('warn');
      expect(result.ok, 'no git is a worse experience, not a broken one').toBe(true);
    });

    it('finds the git on this machine', async () => {
      const check = find(await run(), 'git');
      expect(check.status).toBe('ok');
      expect(check.detail).toMatch(/\d+\.\d+/);
    });

    it('warns that a non-repo workspace makes filesystem diffs less useful', async () => {
      const check = find(await run(), 'git workspace');
      expect(check.status).toBe('warn');
      expect(check.fix).toMatch(/git init/);
    });
  });

  describe('.orca writable', () => {
    it('passes against a real writable directory and leaves nothing behind', async () => {
      const check = find(await run(), '.orca writable');
      expect(check.status).toBe('ok');
      expect(await readdir(cwd), 'the probe file must be cleaned up').toEqual([]);
    });

    it('probes inside .orca when it already exists', async () => {
      await mkdir(join(cwd, '.orca'));
      const check = find(await run(), '.orca writable');
      expect(check.status).toBe('ok');
      expect(check.detail).toContain('.orca');
      expect(await readdir(join(cwd, '.orca'))).toEqual([]);
    });

    it('fails when .orca cannot be written to', async () => {
      // A file where the directory belongs: unwritable in a way that does not depend on uid,
      // since tests may well be running as root.
      await writeFile(join(cwd, '.orca'), 'not a directory');
      const check = find(await run(), '.orca writable');
      expect(check.status).toBe('fail');
      expect(check.fix).toBeTruthy();
    });
  });

  describe('proxy port', () => {
    it('really binds a loopback port and releases it', async () => {
      const check = find(await run(), 'proxy port');
      expect(check.status).toBe('ok');
      expect(check.detail).toContain('127.0.0.1');
    });
  });

  describe('agents', () => {
    it('reports which adapters claim this workspace', async () => {
      const check = find(await run(), 'agents detected');
      expect(['ok', 'warn']).toContain(check.status);
      if (check.status === 'warn') expect(check.fix).toMatch(/record/);
    });
  });

  describe('cli wiring', () => {
    it('exits 0 through main when nothing failed', async () => {
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        expect(await main(['doctor'], cwd)).toBe(0);
      } finally {
        stdout.mockRestore();
      }
    });

    it('exits 1 through main when a check failed, so CI notices', async () => {
      Object.defineProperty(process, 'version', { value: 'v18.20.0', configurable: true });
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        expect(await main(['doctor'], cwd)).toBe(1);
      } finally {
        stdout.mockRestore();
      }
    });
  });

  describe('disk and runs', () => {
    it('reports disk space without falling over where statfs is unavailable', async () => {
      const check = find(await run(), 'disk space');
      expect(['ok', 'warn']).toContain(check.status);
    });

    it('counts the runs already recorded here', async () => {
      const writer = await TraceWriter.create(join(cwd, '.orca', 'runs'), {
        adapter: { id: 'test' },
        argv: ['test'],
        cwd,
        orcaVersion: '0.1.0',
      });
      await writer.append({ type: 'run.start', actor: 'orca', turn: 0 });
      await writer.close(0);

      const check = find(await run(), 'existing runs');
      expect(check.status).toBe('ok');
      expect(check.detail).toMatch(/\b1 run\b/);
    });

    it('says none rather than 0 runs when the workspace is fresh', async () => {
      expect(find(await run(), 'existing runs').detail).toMatch(/none|no runs/i);
    });
  });
});
