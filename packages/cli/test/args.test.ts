import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';

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
