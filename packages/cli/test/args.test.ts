import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';

describe('flags that never take a value', () => {
  /**
   * The parser had no notion of a value-less flag: any flag followed by a non-flag token consumed
   * it, and `bool()` then returned its fallback because the value was a string. So the flag was
   * silently off *and* the positional was gone.
   *
   * Two of those are dangerous rather than merely wrong. `orca replay --worktree last` is
   * documented as "never touches your files", and with `--worktree` swallowed it restores the
   * recorded tree over the working directory instead. `orca record --tls-intercept codex` turns
   * interception off and loses the agent name, so record auto-detects and may capture a different
   * harness entirely. Neither warned.
   *
   * Flag-then-positional is the more natural order, and every existing test happened to put the
   * flag last, which is why nothing caught it.
   */
  it('leaves the positional alone and reads as true', () => {
    for (const flag of ['--worktree', '--in-place', '--loose', '--ui', '--dry-run', '--verbose']) {
      const args = parseArgs(['replay', flag, 'last']);
      expect(args.positionals, `${flag} ate the positional`).toEqual(['last']);
      expect(args.bool(flag.slice(2)), `${flag} did not read as true`).toBe(true);
    }
  });

  it('keeps the agent name when interception is asked for', () => {
    const args = parseArgs(['record', '--tls-intercept', 'codex']);
    expect(args.positionals).toEqual(['codex']);
    expect(args.bool('tls-intercept')).toBe(true);
  });

  it('still lets a value-taking flag take its value', () => {
    const args = parseArgs(['compare', 'last', '--models', 'a,b', '--from', '4']);
    expect(args.positionals).toEqual(['last']);
    expect(args.list('models')).toEqual(['a', 'b']);
    expect(args.num('from')).toBe(4);
  });

  it('still honours an explicit --flag=value for a boolean', () => {
    expect(parseArgs(['replay', '--loose=false', 'last']).bool('loose')).toBe(false);
    expect(parseArgs(['replay', '--no-worktree', 'last']).bool('worktree', true)).toBe(false);
  });
});

describe('parseArgs', () => {
  it('reads the command and its positionals', () => {
    const a = parseArgs(['record', 'claude']);
    expect(a.command).toBe('record');
    expect(a.positionals).toEqual(['claude']);
  });

  it('parses long flags with = and with a following value', () => {
    expect(parseArgs(['replay', 'last', '--model=gpt-5.2']).flags.model).toBe('gpt-5.2');
    expect(parseArgs(['replay', 'last', '--model', 'gpt-5.2']).flags.model).toBe('gpt-5.2');
  });

  it('parses booleans and --no- negation', () => {
    expect(parseArgs(['record', '--ui']).flags.ui).toBe(true);
    expect(parseArgs(['record', '--no-fs']).flags.fs).toBe(false);
  });

  it('parses numbers where the value is numeric', () => {
    expect(parseArgs(['replay', 'last', '--from', '17']).flags.from).toBe(17);
  });

  it('splits comma lists', () => {
    expect(parseArgs(['compare', 'last', '--models', 'a,b,c']).list('models')).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps everything after -- as passthrough argv for the child agent', () => {
    const a = parseArgs(['record', 'claude', '--ui', '--', '--dangerously-skip', '-p', 'hi']);
    expect(a.flags.ui).toBe(true);
    expect(a.passthrough).toEqual(['--dangerously-skip', '-p', 'hi']);
    expect(a.positionals).toEqual(['claude']);
  });

  it('supports short flags', () => {
    expect(parseArgs(['export', 'last', '-o', 'bug.html']).flags.o).toBe('bug.html');
  });

  it('treats a bare invocation as the help command', () => {
    expect(parseArgs([]).command).toBe('help');
  });

  it('does not swallow a negative number as a flag value', () => {
    expect(parseArgs(['replay', 'last', '--from', '-1']).flags.from).toBe(-1);
  });
});
