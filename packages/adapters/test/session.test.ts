import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from 'node:fs';
import {
  captureSession,
  claudeCodeAdapter,
  codexAdapter,
  openCodeAdapter,
  claudeSession,
  claudeProjectSlug,
  codexSession,
  contentText,
  parseJsonl,
  snapshotDir,
} from '../src/index.js';
import { bunOptionsWithHook, nodeOptionsWithHook } from '@orcareplay/node-instrument';

/**
 * The half of a run orca cannot see from the wire.
 *
 * Every other capture layer records what the agent *did*. None record what it was *asked*, because
 * that was typed into a terminal — which is why an interactive recording replayed into a blank
 * agent while an `-p` one replayed perfectly. These cover reading it back out of the transcript
 * the harness wrote for itself.
 */

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-session-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function write(rel: string, text: string, mtime?: number): string {
  const path = join(scratch, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  if (mtime !== undefined) utimesSync(path, mtime / 1000, mtime / 1000);
  return path;
}

describe('snapshotDir', () => {
  it('lists files recursively, since Codex nests transcripts under a date', async () => {
    write('sessions/2026/08/31/a.jsonl', 'x');
    write('sessions/b.jsonl', 'y');
    const seen = await snapshotDir(join(scratch, 'sessions'));
    expect([...seen.keys()].sort()).toEqual(['2026/08/31/a.jsonl', 'b.jsonl']);
  });

  // A harness that has never run has no directory, and that must not fail a recording.
  it('is empty rather than throwing for a directory that is not there', async () => {
    await expect(snapshotDir(join(scratch, 'nope'))).resolves.toEqual(new Map());
    await expect(snapshotDir(undefined)).resolves.toEqual(new Map());
  });
});

describe('captureSession', () => {
  const support = {
    dir: () => join(scratch, 'sessions'),
    parse: (bytes: Uint8Array) => ({ id: 'sid', prompts: [new TextDecoder().decode(bytes)] }),
    resumeArgs: (id: string) => ['--resume', id],
  };

  it('picks the transcript this run wrote, not one that was already there', async () => {
    write('sessions/old.jsonl', 'old', 1_000_000);
    const before = await snapshotDir(join(scratch, 'sessions'));
    write('sessions/new.jsonl', 'new', 2_000_000);
    const captured = await captureSession(support, '/work', {}, before);
    expect(captured?.relPath).toBe('new.jsonl');
    expect(captured?.prompts).toEqual(['new']);
    expect(captured?.id).toBe('sid');
  });

  // A resumed session appends to the file it already had; that session is still this run's.
  it('picks a file whose mtime moved, not only one that is new', async () => {
    write('sessions/a.jsonl', 'a', 1_000_000);
    const before = await snapshotDir(join(scratch, 'sessions'));
    write('sessions/a.jsonl', 'a then more', 2_000_000);
    expect((await captureSession(support, '/work', {}, before))?.relPath).toBe('a.jsonl');
  });

  it('is undefined when the harness wrote nothing', async () => {
    write('sessions/a.jsonl', 'a', 1_000_000);
    const before = await snapshotDir(join(scratch, 'sessions'));
    await expect(captureSession(support, '/work', {}, before)).resolves.toBeUndefined();
  });

  // Bytes a human can still read are worth keeping even when orca cannot parse them.
  it('keeps the transcript when parsing throws, losing only the prompts', async () => {
    const before = await snapshotDir(join(scratch, 'sessions'));
    write('sessions/x.jsonl', 'body', 2_000_000);
    const captured = await captureSession(
      {
        ...support,
        parse: () => {
          throw new Error('unknown format');
        },
      },
      '/work',
      {},
      before,
    );
    expect(new TextDecoder().decode(captured?.bytes)).toBe('body');
    expect(captured?.prompts).toEqual([]);
  });
});

describe('parseJsonl', () => {
  it('skips a half-written final line, which is normal for a harness that just exited', () => {
    const bytes = new TextEncoder().encode('{"a":1}\n{"b":2}\n{"c":');
    expect(parseJsonl(bytes)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('contentText', () => {
  it('flattens both shapes a harness uses for message content', () => {
    expect(contentText('plain')).toBe('plain');
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'thinking' }, { text: 'b' }])).toBe(
      'ab',
    );
    expect(contentText(undefined)).toBe('');
  });
});

describe('claudeSession', () => {
  it('names the project directory the way Claude Code does', () => {
    expect(claudeProjectSlug('C:\\Users\\d\\proj')).toBe('C--Users-d-proj');
    expect(claudeProjectSlug('/home/d/proj')).toBe('-home-d-proj');
  });

  /**
   * Checked against a real install rather than inferred. An earlier version folded only the path
   * separators and the drive colon, which was right for every path it happened to be tested
   * against and wrong for the first one carrying an underscore: the computed name missed the real
   * directory by a single character, and the capture then found nothing and said nothing.
   */
  it('folds every character a path may carry that the directory name does not', () => {
    // One real directory covering all three at once: `slug_test.dir v2` -> `slug-test-dir-v2`.
    expect(claudeProjectSlug('slug_test.dir v2')).toBe('slug-test-dir-v2');
    expect(claudeProjectSlug('C:\\src\\my_project\\app')).toBe('C--src-my-project-app');
    // Hyphens already present are kept, so a folded name and an original one stay distinguishable.
    expect(claudeProjectSlug('already-hyphenated')).toBe('already-hyphenated');
  });

  it('honours CLAUDE_CONFIG_DIR, so a relocated install is still found', () => {
    const home = join(scratch, 'cfg');
    mkdirSync(join(home, 'projects', '-work'), { recursive: true });
    expect(claudeSession.dir('/work', { CLAUDE_CONFIG_DIR: home })).toBe(
      join(home, 'projects', '-work'),
    );
  });

  /**
   * The slug is a guess about someone else's naming, and a wrong guess loses the capture in
   * silence — which is exactly what happened the first time this met a path with an underscore.
   * Falling back to the whole projects tree keeps the run findable whatever it ended up called.
   */
  it('watches the whole projects tree when the named directory is not there', () => {
    const home = join(scratch, 'cfg-empty');
    mkdirSync(join(home, 'projects'), { recursive: true });
    expect(claudeSession.dir('/work', { CLAUDE_CONFIG_DIR: home })).toBe(join(home, 'projects'));
  });

  it('reads the session id and the turns a person actually typed', () => {
    const bytes = new TextEncoder().encode(
      [
        JSON.stringify({ type: 'user', sessionId: 'abc', message: { content: 'first question' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'text', text: 'second question' }] },
        }),
      ].join('\n'),
    );
    expect(claudeSession.parse(bytes)).toEqual({
      id: 'abc',
      prompts: ['first question', 'second question'],
    });
  });

  /**
   * Tool results and spliced reminders arrive with the same `user` role as a typed turn. Driving a
   * replay with one would ask the model something the recording never asked.
   */
  it('drops the turns the harness synthesised for itself', () => {
    const bytes = new TextEncoder().encode(
      [
        JSON.stringify({
          type: 'user',
          message: { content: '<system-reminder>x</system-reminder>' },
        }),
        JSON.stringify({ type: 'user', message: { content: '   ' } }),
        JSON.stringify({ type: 'user', message: { content: 'real' } }),
      ].join('\n'),
    );
    expect(claudeSession.parse(bytes).prompts).toEqual(['real']);
  });

  it('resumes by id', () => {
    expect(claudeSession.resumeArgs('abc')).toEqual(['--resume', 'abc']);
  });
});

describe('codexSession', () => {
  it('honours CODEX_HOME', () => {
    expect(codexSession.dir('/work', { CODEX_HOME: '/cx' })).toBe(join('/cx', 'sessions'));
  });

  it('reads the session id and the input_text turns out of a rollout', () => {
    const bytes = new TextEncoder().encode(
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'sid-1', cwd: '/w' } }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            content: [{ type: 'input_text', text: '<skills>x</skills>' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', content: [{ type: 'input_text', text: 'the real ask' }] },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', content: [{ type: 'output_text', text: 'PONG' }] },
        }),
      ].join('\n'),
    );
    expect(codexSession.parse(bytes)).toEqual({ id: 'sid-1', prompts: ['the real ask'] });
  });

  it('resumes by id', () => {
    expect(codexSession.resumeArgs('sid-1')).toEqual(['exec', 'resume', 'sid-1']);
  });
});

describe('driveArgs', () => {
  /**
   * The recording's own flags still have to shape the replay: a run made with `--model x` that
   * replays without it is a different run, and would diverge on every request.
   */
  it('extends the recorded argv rather than replacing it', () => {
    expect(claudeCodeAdapter.driveArgs?.(['ask'], ['--model', 'x'])).toEqual([
      '--model',
      'x',
      '-p',
      'ask',
    ]);
  });

  it('gives Codex the exec form when the recording had none', () => {
    expect(codexAdapter.driveArgs?.(['ask'], [])).toEqual(['exec', '--skip-git-repo-check', 'ask']);
  });

  // `codex exec` with the prompt on stdin already carries the subcommand and its flags.
  it('appends the prompt to an exec recording, keeping its flags', () => {
    expect(codexAdapter.driveArgs?.(['ask'], ['exec', '--skip-git-repo-check'])).toEqual([
      'exec',
      '--skip-git-repo-check',
      'ask',
    ]);
  });

  it('drives nothing when the transcript yielded no prompt', () => {
    expect(claudeCodeAdapter.driveArgs?.([], [])).toBeUndefined();
    expect(codexAdapter.driveArgs?.([], [])).toBeUndefined();
  });
});

describe('openCodeAdapter credentials', () => {
  /**
   * The placeholder exists so an unconfigured OpenCode still starts, and so that inventing one
   * provider's key cannot flip which provider it chooses — hence all-or-nothing. What it did not
   * account for is `opencode auth login`, which writes a credential file the environment knows
   * nothing about. Inventing both variables in front of that is the failure Claude Code showed:
   * the harness prefers the environment and authenticates as nobody.
   */
  function isolateHome(withAuth: boolean): void {
    const home = join(scratch, `home-${withAuth ? 'auth' : 'bare'}`);
    if (withAuth) {
      const dir = join(home, '.local', 'share', 'opencode');
      mkdirSync2(dir, { recursive: true });
      writeFileSync2(join(dir, 'auth.json'), '{}');
    } else {
      mkdirSync2(home, { recursive: true });
    }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  }

  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  });

  const ctx = () => ({
    runId: 'run_abc123',
    cwd: '/work',
    proxyUrl: 'http://127.0.0.1:51733',
    runDir: '/work/.orca/runs/run_abc123',
    userArgs: [],
    env: {},
  });

  it('invents no key when OpenCode has signed in on its own', async () => {
    isolateHome(true);
    const launch = await openCodeAdapter.prepare(ctx());
    expect('OPENAI_API_KEY' in launch.env).toBe(false);
    expect('ANTHROPIC_API_KEY' in launch.env).toBe(false);
  });

  // Unchanged where it was right: an OpenCode with no credentials anywhere still needs to start.
  it('still substitutes placeholders when there is no credential anywhere', async () => {
    isolateHome(false);
    const launch = await openCodeAdapter.prepare(ctx());
    expect(launch.env.OPENAI_API_KEY).toBe('orca-recorded');
    expect(launch.env.ANTHROPIC_API_KEY).toBe('orca-recorded');
  });
});

describe('bunOptionsWithHook', () => {
  /**
   * Bun parses `BUN_OPTIONS` with a parser that treats a backslash as an escape, so a Windows path
   * reached the loader with its separators eaten. Quoting made it worse: Bun accepted the argument
   * and loaded nothing, which is the silent miss the hook exists to prevent.
   */
  it('hands Bun a path its own parser will survive', () => {
    const out = bunOptionsWithHook(String.raw`C:\Users\d\run\hook.cjs`, undefined, 'win32');
    expect(out).not.toContain(String.fromCharCode(92));
    expect(out).toBe('--preload C:/Users/d/run/hook.cjs');
  });

  /**
   * A backslash is a legal character in a POSIX filename, so the rewrite is Windows-only: applying
   * it everywhere would turn one real path into another real path that does not exist. Asserted
   * rather than assumed, because the guard is what makes the rewrite above safe to do at all.
   */
  it('leaves a POSIX path alone, where a backslash is part of the name', () => {
    const path = '/home/d/run' + String.fromCharCode(92) + 'odd/hook.cjs';
    expect(bunOptionsWithHook(path, undefined, 'linux')).toBe(`--preload ${path}`);
  });

  // Node resolves `--require` from `NODE_OPTIONS` without that escaping, so it is left alone.
  it('leaves the Node form as it was', () => {
    const path = String.raw`C:\Users\d\run\hook.cjs`;
    expect(nodeOptionsWithHook(path, undefined)).toBe(`--require ${path}`);
  });
});
