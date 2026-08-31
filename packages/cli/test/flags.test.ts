import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { assertKnownFlags } from '../src/flags.js';

/**
 * A flag is an instruction. The parser takes any it is given, which is right for parsing and wrong
 * for a CLI: an invented one was accepted in silence and simply had no effect, so a run that did
 * something other than what was asked reported success. Someone told to use a flag that does not
 * exist got a normal run and no hint of it.
 */
describe('assertKnownFlags', () => {
  const check = (argv: string[]) => () => assertKnownFlags(parseArgs(argv));

  it('accepts the flags a command actually has', () => {
    expect(check(['replay', 'last', '--from', '4', '--model', 'x', '--in-place'])).not.toThrow();
    expect(check(['record', 'claude', '--no-shell', '--mcp-config', 'm.json'])).not.toThrow();
    expect(check(['gc', '--older-than', '7d', '--dry-run'])).not.toThrow();
  });

  it('rejects one the command does not have, and says so', () => {
    expect(check(['replay', 'last', '--explain-miss'])).toThrow(/unknown flag --explain-miss/);
  });

  // A flag that exists somewhere else is exactly the kind that reads as working.
  it('rejects a flag that belongs to another command', () => {
    expect(check(['list', '--from', '4'])).toThrow(/unknown flag --from/);
  });

  it('names the nearest flag when it looks like a typo', () => {
    expect(check(['replay', 'last', '--worktre'])).toThrow(/did you mean --worktree/);
  });

  it('lists what the command does take, so the error is enough to act on', () => {
    expect(check(['scrub', 'last', '--nope'])).toThrow(/--match --matches --dry-run --drop-fs/);
  });

  it('allows the global flags everywhere', () => {
    expect(check(['show', 'last', '--json', '--verbose', '--ci'])).not.toThrow();
  });

  // `--no-shell` is `shell: false`; the negation must not read as a flag named `no-shell`.
  it('understands a negated flag as the flag it negates', () => {
    expect(check(['record', 'claude', '--no-fs', '--no-shell'])).not.toThrow();
    expect(check(['replay', 'last', '--no-trace'])).not.toThrow();
  });

  /**
   * The list is built from what the code reads, not from what the docs describe. `--no-trace` is
   * a replay flag and record never looks at it, so record has to reject it — the alternative is
   * the shape of failure this check exists for, with the flag ignored and the run reporting fine.
   */
  it('rejects a real flag on a command that does not read it', () => {
    expect(check(['record', 'claude', '--no-trace'])).toThrow(/unknown flag --trace/);
  });

  it('says nothing about an unknown command, which the dispatcher reports better', () => {
    expect(check(['bogus', '--whatever'])).not.toThrow();
  });
});
