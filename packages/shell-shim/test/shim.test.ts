import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installShellShim, readShellFrames } from '../src/index.js';

/**
 * The transport holds `shell-frames.jsonl` — argv and cwd verbatim, the most secret-dense text in
 * a run. `mkdtemp` gives 0700 on POSIX and, on Windows, whatever `%TEMP%` hands down: measured on
 * one machine that was a local group and a second account, both with Modify. So the check is the
 * ACL there, where `(I)` marks an entry inherited from outside.
 */
async function expectOwnerOnly(path: string): Promise<void> {
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777, path).toBe(0o700);
    return;
  }
  const icacls = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const { stdout } = await promisify(execFile)(icacls, [path]);
  expect(stdout, path).not.toContain('(I)');
  const granted = stdout.split(/\r?\n/).filter((line) => line.includes(':(')).length;
  expect(granted, `${path}: expected owner, SYSTEM and Administrators only`).toBe(3);
}

const run = promisify(execFile);

/**
 * The shim sits in the middle of a command the agent is running for real. Every assertion here is
 * about not breaking that: the output must be byte-identical, the exit code must survive, and a
 * failure in the capture path must cost the capture, never the command.
 */
describe('shell shim', () => {
  it('narrows the transport before a single frame can land in it', async () => {
    // Before the writes, not after: `icacls` does not re-propagate to children that already exist,
    // so a directory narrowed once `owner.pid` and the frames file were there would leave both of
    // them holding the ACL they inherited. Asserting the files too is how that ordering is pinned.
    const runDir = await mkdtemp(join(tmpdir(), 'orca-shim-acl-'));
    const shim = await installShellShim({ runDir });
    expect(shim.transportDir, 'no transport was minted').toBeDefined();
    await expectOwnerOnly(shim.transportDir!);
    if (process.platform === 'win32') {
      const { stdout } = await promisify(execFile)(
        join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe'),
        [shim.framesPath],
      );
      // Inherited — from the directory this test just proved is owner-only, which is the point.
      expect(stdout.split(/\r?\n/).filter((l) => l.includes(':(')).length).toBe(3);
    }
  });
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
    // The reader's recovery of a torn line is anchored on this, so the writer has to keep
    // producing it: `record()` builds the object with `name` first and `JSON.stringify` keeps
    // insertion order.
    const firstLine = (await readFile(shim.framesPath, 'utf8')).split('\n')[0]!;
    expect(
      firstLine.startsWith('{"name":'),
      `a frame now starts \`${firstLine.slice(0, 12)}\``,
    ).toBe(true);
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

  it('keeps the frame a real tear produces, where the duration went with the timestamp', async () => {
    // The two cases above supply a `durationMs`, and a real tear does not. The shim writes
    // `... signal, startedAt, durationMs, stdoutBytes, stderrBytes` in that order, so an
    // interleaved append closed by a neighbour's brace loses the timestamp and everything after
    // it — both of that pair, together. Asking about the duration before asking whether there was
    // an instant to add it to therefore dropped exactly the frame this reader exists to keep, and
    // both events for a command that really ran went missing from the trace.
    const torn = '{"name":"sh","argv":["-c","npm test"],"cwd":"/tmp","exitCode":1,"signal":null}';
    await writeFile(shim.framesPath, `${torn}\n`, 'utf8');

    const frames = await readShellFrames(shim.framesPath);
    expect(frames, 'a torn frame took the command it belonged to with it').toHaveLength(1);
    expect(frames[0]!.argv).toEqual(['-c', 'npm test']);
  });

  /**
   * A short write does not lose one frame, it loses two.
   *
   * `record()` appends a frame with one `appendFileSync`, which is not one `write` syscall — a
   * full disk, a quota, or a process killed inside it leaves a prefix with no newline behind it,
   * and the next shim's whole line lands straight on the end. A prefix of a balanced object is
   * unbalanced and gluing a balanced one onto it cannot rebalance it, so the line failed to parse
   * and was skipped entire. The torn frame is unrecoverable; the complete one behind it was being
   * thrown away with it, so a command that ran and was recorded in full went missing from the
   * trace because a *different* shim was interrupted.
   */
  it('recovers the frame a torn write glued its fragment onto', async () => {
    const fragment =
      '{"name":"sh","argv":["-c","interrupted"],"cwd":"/tmp","exitCode":1,"signal":null';
    const whole = JSON.stringify({
      name: 'bash',
      argv: ['-c', 'npm test'],
      cwd: '/tmp',
      exitCode: 0,
      signal: null,
      startedAt: '2026-09-12T00:00:00.000Z',
      durationMs: 5,
      stdoutBytes: 0,
      stderrBytes: 0,
    });
    await writeFile(shim.framesPath, `${fragment}${whole}\n`, 'utf8');

    const frames = await readShellFrames(shim.framesPath);
    expect(frames, 'a complete frame went with the fragment it was glued to').toHaveLength(1);
    expect(frames[0]!.argv).toEqual(['-c', 'npm test']);
  });

  /**
   * The same short write, the other way round: the complete frame comes *first*.
   *
   * A write can be short by only its newline, and then the next one lands a few bytes before dying
   * too. Cutting the line at the next frame opening cannot find a boundary there — the fragment is
   * shorter than the opening is long — so the complete frame in front of it was swallowed with it.
   * Cutting where the JSON object *ends* finds both directions, and stops the reader depending on
   * which key the writer happens to put first.
   */
  it.each([
    ['shorter than a frame opening', '{"nam'],
    ['a single byte', '{'],
    ['exactly a frame opening', '{"name":'],
    [
      'a whole second frame',
      '{"name":"sh","argv":["-c","echo hi"],"cwd":"/tmp","exitCode":0,"signal":null,"startedAt":"2026-09-12T00:00:01.000Z","durationMs":2,"stdoutBytes":0,"stderrBytes":0}',
    ],
  ])('recovers a complete frame whose newline was lost, followed by %s', async (_what, next) => {
    const whole = JSON.stringify({
      name: 'bash',
      argv: ['-c', 'npm test'],
      cwd: '/tmp',
      exitCode: 0,
      signal: null,
      startedAt: '2026-09-12T00:00:00.000Z',
      durationMs: 5,
      stdoutBytes: 0,
      stderrBytes: 0,
    });
    await writeFile(shim.framesPath, `${whole}${next}\n`, 'utf8');

    const frames = await readShellFrames(shim.framesPath);
    expect(
      frames.map((frame) => frame.argv.join(' ')),
      'a frame recorded in full was lost to the bytes written after it',
    ).toContain('-c npm test');
  });

  /**
   * A brace in a command is a brace in a string, not the end of the frame.
   *
   * `sh -c 'echo "}"'` is an ordinary thing for an agent to run, and it puts both of the characters
   * the scan has to be careful about into one value: a `}` that is text, and an escaped quote in
   * front of it. Reading either structurally cuts the frame short, and the piece that comes out
   * does not parse — so a command that ran would be lost to what it happened to contain.
   */
  it('does not end a frame at a brace inside one of its own values', async () => {
    const whole = JSON.stringify({
      name: 'sh',
      argv: ['-c', 'echo "}"'],
      cwd: '/tmp',
      exitCode: 0,
      signal: null,
      startedAt: '2026-09-12T00:00:00.000Z',
      durationMs: 5,
      stdoutBytes: 0,
      stderrBytes: 0,
    });
    // Followed by a stub, so the line goes through the recovery rather than straight to JSON.parse.
    await writeFile(shim.framesPath, `${whole}{"nam\n`, 'utf8');

    const frames = await readShellFrames(shim.framesPath);
    expect(frames, 'a frame was cut short at a brace in its own argv').toHaveLength(1);
    expect(frames[0]!.argv).toEqual(['-c', 'echo "}"']);
  });

  /**
   * Why the search for what is whole is anchored, rather than started at any `{`.
   *
   * A fragment that stops inside a string leaves an odd number of quotes behind it, and a brace
   * walk begun anywhere after that reads every quote on the wrong side: the braces in the complete
   * frame that follows are counted as text, the walk reports a boundary past it, and the frame is
   * skipped without ever being looked at. Started at `{"name":` the walk always begins outside a
   * string, because JSON escapes the quotes inside one and the sequence cannot occur there.
   *
   * Measured before this was anchored: taking one ordinary frame and using each of its 166 cut
   * points as the fragment, the complete frame behind it was lost for 122 of them.
   */
  it('recovers a frame behind a fragment that stopped inside a string', async () => {
    const whole = JSON.stringify({
      name: 'sh',
      argv: ['-c', 'echo "}"'],
      cwd: '/tmp',
      exitCode: 0,
      signal: null,
      startedAt: '2026-09-12T00:00:00.000Z',
      durationMs: 5,
      stdoutBytes: 0,
      stderrBytes: 0,
    });
    // `{"name` is the shortest fragment that ends mid-string, and the one a short write is likeliest
    // to leave.
    await writeFile(shim.framesPath, `{"name${whole}\n`, 'utf8');

    const frames = await readShellFrames(shim.framesPath);
    expect(frames, 'the complete frame was read past, not read').toHaveLength(1);
    expect(frames[0]!.argv).toEqual(['-c', 'echo "}"']);
  });

  it('keeps a frame whose fields are in some other order, having never looked for one', async () => {
    // A line that parses is one frame and needs none of the recovery below it. That is every line
    // of every ordinary capture, and it is also the only thing that reads a frame written by
    // something that ordered its fields differently — recovery is anchored on `name` coming first,
    // and an ordinary line must not depend on that.
    const frame = {
      argv: ['-c', 'true'],
      name: 'sh',
      cwd: '/tmp',
      exitCode: 0,
      signal: null,
      startedAt: '2026-09-12T00:00:00.000Z',
      durationMs: 5,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    await writeFile(shim.framesPath, `${JSON.stringify(frame)}\n`, 'utf8');

    const frames = await readShellFrames(shim.framesPath);
    expect(frames, 'an ordinary line was put through the recovery and lost').toHaveLength(1);
    expect(frames[0]!.argv).toEqual(['-c', 'true']);
  });

  it('still has nothing to recover from a fragment on its own', async () => {
    // The partial final line this reader has always tolerated: a process killed mid-write with
    // nothing after it. Recovery must not turn an unreadable prefix into a frame invented from it.
    const fragment =
      '{"name":"sh","argv":["-c","interrupted"],"cwd":"/tmp","exitCode":1,"signal":null';
    await writeFile(shim.framesPath, `${fragment}\n`, 'utf8');
    expect(await readShellFrames(shim.framesPath)).toHaveLength(0);
  });

  it('drops one whose timestamp is out of range even when the duration brings it back', async () => {
    // The two bounds are not one check written twice. `shell.exec` is stamped with the instant
    // alone, so `startedAt` is bounded for its own sake — and a large enough negative duration puts
    // `endedMs` back inside the window while the exec event stays unrepresentable. Without this
    // case the list above still passes with the `startedAt` bound deleted, because every fixture in
    // it fails the `endedMs` bound as well.
    const frame = {
      name: 'sh',
      argv: ['-c', 'true'],
      cwd: '/tmp',
      exitCode: 0,
      signal: null,
      // The largest instant a `Date` can hold, brought back to the epoch by the duration.
      startedAt: '+275760-09-13T00:00:00.000Z',
      durationMs: -8_640_000_000_000_000,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    await writeFile(shim.framesPath, `${JSON.stringify(frame)}\n`, 'utf8');
    expect(await readShellFrames(shim.framesPath)).toHaveLength(0);
  });

  it('still drops one whose timestamp parses and whose duration does not', async () => {
    // The control for the case above, and the reason the check is conditional rather than gone.
    // Here there *is* an instant, so the consumer builds `new Date(startedAt + durationMs)` — and
    // an absent duration makes that an Invalid Date, which throws `RangeError: Invalid time value`
    // inside `TraceWriter.append`, where the trace is being sealed.
    const frame = {
      name: 'sh',
      argv: ['-c', 'true'],
      cwd: '/tmp',
      exitCode: 0,
      signal: null,
      startedAt: '2026-09-12T00:00:00.000Z',
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    await writeFile(shim.framesPath, `${JSON.stringify(frame)}\n`, 'utf8');
    expect(await readShellFrames(shim.framesPath)).toHaveLength(0);
  });
});
