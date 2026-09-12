import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it.skipIf(process.platform === 'win32')('passes stdout through byte for byte', async () => {
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

  it.skipIf(process.platform === 'win32')(
    'keeps stdout and stderr on their own streams',
    async () => {
      const result = await through('sh', ['-c', 'printf out; printf err 1>&2']);
      expect(result.stdout).toBe('out');
      expect(result.stderr).toBe('err');
    },
  );

  it.skipIf(process.platform === 'win32')('forwards a non-zero exit code', async () => {
    const result = await through('sh', ['-c', 'exit 3']);
    expect((result as { code?: number }).code).toBe(3);
  });

  it.skipIf(process.platform === 'win32')(
    'does not re-execute itself when the shim dir is first on PATH',
    async () => {
      // If resolution ever returns the shim, this hangs or blows the process table rather than
      // failing cleanly — so the assertion is really "this returned at all".
      const result = await through('sh', ['-c', 'echo alive']);
      expect(result.stdout.trim()).toBe('alive');
    },
  );

  it.skipIf(process.platform === 'win32')('records argv, cwd, exit code and duration', async () => {
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

  it.skipIf(process.platform === 'win32')(
    'records the byte counts the model never sees',
    async () => {
      await through('sh', ['-c', 'printf 12345; printf 678 1>&2']);
      const [frame] = await readShellFrames(shim.framesPath);
      expect(frame!.stdoutBytes).toBe(5);
      expect(frame!.stderrBytes).toBe(3);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'appends one frame per invocation, in order',
    async () => {
      await through('sh', ['-c', 'true']);
      await through('sh', ['-c', 'false']);
      const frames = await readShellFrames(shim.framesPath);
      expect(frames.map((f) => f.exitCode)).toEqual([0, 1]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'handles a large output without truncating or reordering it',
    async () => {
      const result = await through('sh', [
        '-c',
        'i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done',
      ]);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(2000);
      expect(lines[0]).toBe('line0');
      expect(lines[1999]).toBe('line1999');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps working when the frames file cannot be written',
    async () => {
      // Capture is a nice-to-have; the command the user is running is not.
      const broken = await installShellShim({
        runDir,
        framesPath: '/proc/definitely/not/writable',
      });
      const result = await run('sh', ['-c', 'echo survived'], {
        env: { ...process.env, PATH: `${broken.dir}:${process.env.PATH ?? ''}` },
      });
      expect(result.stdout.trim()).toBe('survived');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports a clear error rather than hanging when the real binary is gone',
    async () => {
      const result = await run(join(shim.dir, 'sh'), ['-c', 'true'], {
        env: { ...process.env, PATH: shim.dir },
      }).catch((err: NodeJS.ErrnoException & { stderr?: string; code?: number }) => ({
        stderr: err.stderr ?? '',
        code: err.code,
      }));
      expect((result as { code?: number }).code).not.toBe(0);
      expect((result as { stderr: string }).stderr).toMatch(/orca/i);
    },
  );

  it.skipIf(process.platform === 'win32')('shims the shells an agent actually uses', async () => {
    const contents = await readFile(join(shim.dir, 'bash'), 'utf8').catch(() => '');
    expect(contents).not.toBe('');
    expect(shim.shimmed).toContain('sh');
    expect(shim.shimmed).toContain('bash');
    // zsh is the shell OpenCode's tool resolves to on macOS, where it execs `$SHELL` by absolute
    // path — the shim only captures anything there because a `zsh` shim exists to point at.
    expect(shim.shimmed).toContain('zsh');
    expect(await readFile(join(shim.dir, 'zsh'), 'utf8').catch(() => '')).not.toBe('');
  });

  // Where zsh exists at all, its shim must pass a command through and record it. macOS has one
  // at /bin/zsh; a minimal Linux image may not, and that is a fact about the image, not the shim.
  const zshOnPath = ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh'].some((p) => existsSync(p));
  it.skipIf(process.platform === 'win32' || !zshOnPath)(
    'passes a zsh command through byte for byte and records it',
    async () => {
      const result = await through('zsh', ['-c', 'printf zsh-out']);
      expect(result.stdout).toBe('zsh-out');
      const [frame] = await readShellFrames(shim.framesPath);
      expect(frame).toMatchObject({ name: 'zsh', argv: ['-c', 'printf zsh-out'] });
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'writes command shims Windows can launch from PATH',
    async () => {
      const contents = await readFile(join(shim.dir, 'sh.cmd'), 'utf8');
      expect(contents).toContain('@echo off');
      expect(contents).toContain('%*');
      expect(await readFile(join(shim.dir, 'bash.cmd'), 'utf8')).not.toBe('');
      expect(shim.shimmed).toEqual(['sh', 'bash', 'zsh']);
    },
  );

  it('skips a line that parsed but is not a frame', async () => {
    // Tolerating a bad line has to mean more than surviving `JSON.parse`. Every shim appends to
    // this file at once, so an interleaved write can leave a line that is valid JSON and not a
    // frame — and the only consumer spreads `frame.argv` into an event, which threw at the point
    // the trace was being sealed.
    const good = {
      name: 'sh',
      argv: ['-c', 'true'],
      cwd: '/tmp',
      exitCode: 0,
      signal: null,
      startedAt: '2026-09-12T00:00:00.000Z',
      durationMs: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    const lines = [
      'null',
      '7',
      '"a string"',
      '[1,2]',
      JSON.stringify({ name: 'sh', argv: 'not-an-array', cwd: '/tmp' }),
      JSON.stringify({ argv: [], cwd: '/tmp' }),
      // The one a check on `name`/`argv` alone lets through, and the one that actually ends a run:
      // the consumer adds `durationMs` to the parsed `startedAt`, so a frame torn between those two
      // fields becomes `new Date(<ms> + undefined)` — an Invalid Date, which throws
      // `RangeError: Invalid time value` inside `TraceWriter.append`, where the trace is sealed.
      JSON.stringify({ ...good, durationMs: undefined }),
      JSON.stringify({ ...good, durationMs: '5' }),
      // Right type, unusable magnitude: a splice can leave one duration's digits followed by the
      // tail of the neighbour's number. `Number.isFinite` passes all three. From a 2026 stamp, 3e14
      // formats as `+011533-…` and the schema types `ts` as `date-time`, which admits a four-digit
      // year and nothing else; 9e15 does not format at all.
      JSON.stringify({ ...good, durationMs: 1234567890000000 }),
      JSON.stringify({ ...good, durationMs: 3e14 }),
      JSON.stringify({ ...good, durationMs: -9e15 }),
      JSON.stringify({ ...good, startedAt: '+275760-09-13T00:00:00.000Z' }),
      JSON.stringify(good),
      '{"name":"sh","argv":[',
      '',
    ];
    await writeFile(shim.framesPath, lines.join('\n'), 'utf8');
    const frames = await readShellFrames(shim.framesPath);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.argv).toEqual(['-c', 'true']);
    expect(frames[0]!.durationMs).toBe(1);
    // A `startedAt` that is not a string is *not* on that list: `Date.parse` is NaN for it, the
    // consumer degrades the same way it does for an absent one, and the frame is a command that
    // ran. Only the three above reach the arithmetic.
  });

  it('keeps a frame whose startedAt is absent, which the consumer also handles', async () => {
    // The bound applies only when there is an instant to bound, and "absent" is one of the two
    // ways there is none. Requiring a *string* rejected it — out of step with the MCP reader
    // written in the same change, and with this file's own reasoning: `Date.parse` is NaN either
    // way, and the consumer guards both uses of the instant with the same test.
    const frame = {
      name: 'sh',
      argv: ['-c', 'true'],
      cwd: '/tmp',
      exitCode: 0,
      signal: null,
      durationMs: 5,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    await writeFile(
      shim.framesPath,
      `${JSON.stringify(frame)}
`,
      'utf8',
    );
    expect(await readShellFrames(shim.framesPath)).toHaveLength(1);
  });

  it('keeps a frame whose startedAt does not parse, because that one degrades a field', async () => {
    // The bound applies only when there is an instant to bound. An unparseable `startedAt` already
    // has a defined outcome — the consumer drops `occurredAt` and stamps the event from the drain's
    // own clock — so rejecting it here would throw away a command the agent really ran.
    const frame = {
      name: 'sh',
      argv: ['-c', 'true'],
      cwd: '/tmp',
      exitCode: 0,
      signal: null,
      startedAt: 'not a date',
      durationMs: 9e15,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    await writeFile(shim.framesPath, `${JSON.stringify(frame)}\n`, 'utf8');
    expect(await readShellFrames(shim.framesPath)).toHaveLength(1);
  });
});
