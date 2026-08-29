import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installShellShim, readShellFrames } from '../src/index.js';

const run = promisify(execFile);

/**
 * The shim sits in the middle of a command the agent is running for real. Every assertion here is
 * about not breaking that: the output must be byte-identical, the exit code must survive, and a
 * failure in the capture path must cost the capture, never the command.
 */
describe('shell shim', () => {
  let runDir: string;
  let shim: Awaited<ReturnType<typeof installShellShim>>;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'orca-shell-'));
    shim = await installShellShim({ runDir });
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  /** Run a command through a PATH that has the shim directory first, as `orca record` does. */
  async function through(command: string, args: string[]) {
    return run(command, args, {
      env: { ...process.env, PATH: `${shim.dir}${':'}${process.env.PATH ?? ''}` },
      cwd: runDir,
    }).catch(
      (err: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => ({
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        code: err.code,
      }),
    );
  }

  it('passes stdout through byte for byte', async () => {
    // Compared against the *unshimmed* command rather than a hand-written expectation: the
    // property that matters is "the shim changes nothing", and writing the bytes out by hand
    // tests the author's understanding of printf instead — which is how the first version of
    // this test failed while the shim was correct.
    const script = "printf 'plain ascii \xc2\xb7 unicode \xe2\x9c\x93 \xf0\x9f\x90\x8b\n'";
    const shimmed = await run('sh', ['-c', script], {
      env: { ...process.env, PATH: `${shim.dir}:${process.env.PATH ?? ''}` },
      encoding: 'buffer',
    });
    const direct = await run('sh', ['-c', script], { encoding: 'buffer' });
    expect(Buffer.compare(shimmed.stdout as Buffer, direct.stdout as Buffer)).toBe(0);
    expect((shimmed.stdout as Buffer).length).toBeGreaterThan(0);
  });

  it('keeps stdout and stderr on their own streams', async () => {
    const result = await through('sh', ['-c', 'printf out; printf err 1>&2']);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });

  it('forwards a non-zero exit code', async () => {
    const result = await through('sh', ['-c', 'exit 3']);
    expect((result as { code?: number }).code).toBe(3);
  });

  it('does not re-execute itself when the shim dir is first on PATH', async () => {
    // If resolution ever returns the shim, this hangs or blows the process table rather than
    // failing cleanly — so the assertion is really "this returned at all".
    const result = await through('sh', ['-c', 'echo alive']);
    expect(result.stdout.trim()).toBe('alive');
  });

  it('records argv, cwd, exit code and duration', async () => {
    await through('sh', ['-c', 'exit 2']);
    const frames = await readShellFrames(shim.framesPath);
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.name).toBe('sh');
    expect(frame.argv).toEqual(['-c', 'exit 2']);
    expect(frame.exitCode).toBe(2);
    expect(frame.cwd).toContain('orca-shell-');
    expect(frame.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records the byte counts the model never sees', async () => {
    await through('sh', ['-c', 'printf 12345; printf 678 1>&2']);
    const [frame] = await readShellFrames(shim.framesPath);
    expect(frame!.stdoutBytes).toBe(5);
    expect(frame!.stderrBytes).toBe(3);
  });

  it('appends one frame per invocation, in order', async () => {
    await through('sh', ['-c', 'true']);
    await through('sh', ['-c', 'false']);
    const frames = await readShellFrames(shim.framesPath);
    expect(frames.map((f) => f.exitCode)).toEqual([0, 1]);
  });

  it('handles a large output without truncating or reordering it', async () => {
    const result = await through('sh', [
      '-c',
      'i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done',
    ]);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(2000);
    expect(lines[0]).toBe('line0');
    expect(lines[1999]).toBe('line1999');
  });

  it('keeps working when the frames file cannot be written', async () => {
    // Capture is a nice-to-have; the command the user is running is not.
    const broken = await installShellShim({ runDir, framesPath: '/proc/definitely/not/writable' });
    const result = await run('sh', ['-c', 'echo survived'], {
      env: { ...process.env, PATH: `${broken.dir}:${process.env.PATH ?? ''}` },
    });
    expect(result.stdout.trim()).toBe('survived');
  });

  it('reports a clear error rather than hanging when the real binary is gone', async () => {
    const result = await run(join(shim.dir, 'sh'), ['-c', 'true'], {
      env: { ...process.env, PATH: shim.dir },
    }).catch((err: NodeJS.ErrnoException & { stderr?: string; code?: number }) => ({
      stderr: err.stderr ?? '',
      code: err.code,
    }));
    expect((result as { code?: number }).code).not.toBe(0);
    expect((result as { stderr: string }).stderr).toMatch(/orca/i);
  });

  it('shims the shells an agent actually uses', async () => {
    const contents = await readFile(join(shim.dir, 'bash'), 'utf8').catch(() => '');
    expect(contents).not.toBe('');
    expect(shim.shimmed).toContain('sh');
    expect(shim.shimmed).toContain('bash');
  });
});
