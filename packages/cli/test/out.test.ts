import { describe, expect, it } from 'vitest';
import { Output, stripAnsi } from '../src/out.js';

const ESC = String.fromCharCode(27);

/**
 * §14 of the design: the CLI is ~90% of the product surface. Most of these assertions exist
 * because the output ends up in a CI log, a pipe, or a pasted GitHub issue — not a terminal.
 */
describe('Output', () => {
  const sink = () => {
    const lines: string[] = [];
    return { lines, write: (s: string) => void lines.push(s) };
  };

  it('emits no ANSI when the stream is not a TTY', () => {
    const s = sink();
    new Output({ write: s.write, isTTY: false }).info('recording', { run: 'run_abc' });
    expect(s.lines.join('')).not.toContain(ESC);
  });

  it('emits ANSI when the stream is a TTY', () => {
    const s = sink();
    new Output({ write: s.write, isTTY: true }).warn('divergence', { level: 'minor' });
    expect(s.lines.join('')).toContain(ESC);
  });

  it('honours NO_COLOR even on a TTY', () => {
    const s = sink();
    new Output({ write: s.write, isTTY: true, env: { NO_COLOR: '1' } }).error('nope');
    expect(s.lines.join('')).not.toContain(ESC);
  });

  it('writes greppable level + event + key=value lines', () => {
    const s = sink();
    new Output({ write: s.write, isTTY: false }).info('replay.done', {
      matched: 68,
      total: 68,
      divergences: 0,
    });
    expect(stripAnsi(s.lines[0]!).trim()).toBe('info replay.done matched=68 total=68 divergences=0');
  });

  it('quotes values containing spaces so the line stays parseable', () => {
    const s = sink();
    new Output({ write: s.write, isTTY: false }).info('fork', { model: 'a b' });
    expect(s.lines[0]).toContain('model="a b"');
  });

  it('suppresses progress in ci mode but still prints one line per phase', () => {
    const s = sink();
    const out = new Output({ write: s.write, isTTY: true, ci: true });
    out.progress('recording');
    out.phase('capture', { layers: 3 });
    const joined = s.lines.join('');
    expect(joined).not.toContain('recording');
    expect(joined).toContain('capture');
    expect(joined).not.toContain(ESC);
  });

  it('prints progress only on an interactive TTY', () => {
    const tty = sink();
    new Output({ write: tty.write, isTTY: true }).progress('working');
    expect(tty.lines.join('')).toContain('working');

    const pipe = sink();
    new Output({ write: pipe.write, isTTY: false }).progress('working');
    expect(pipe.lines.join('')).toBe('');
  });

  it('hides debug lines unless verbose', () => {
    const quiet = sink();
    new Output({ write: quiet.write, isTTY: false }).debug('detail', {});
    expect(quiet.lines).toHaveLength(0);

    const loud = sink();
    new Output({ write: loud.write, isTTY: false, verbose: true }).debug('detail', {});
    expect(loud.lines).toHaveLength(1);
  });

  it('renders an error as what happened, what it means, and what to run next', () => {
    const s = sink();
    new Output({ write: s.write, isTTY: false }).failure({
      event: 'replay.no_match',
      what: 'no recorded response matched request 14',
      why: 'the agent asked something the recording never saw',
      next: 'orca replay last --loose',
    });
    const text = s.lines.join('');
    expect(text).toContain('no recorded response matched request 14');
    expect(text).toContain('the agent asked something the recording never saw');
    expect(text).toContain('orca replay last --loose');
  });

  it('never prints a value that looks like a secret, even to a TTY', () => {
    const s = sink();
    new Output({ write: s.write, isTTY: true }).info('provider', {
      key: 'sk-abcdefghijklmnopqrstuvwxyz012345',
      base: 'https://api.example.com',
    });
    const text = stripAnsi(s.lines.join(''));
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(text).toContain('<redacted>');
    expect(text).toContain('https://api.example.com');
  });

  it('formats a table with aligned columns and no box drawing', () => {
    const s = sink();
    new Output({ write: s.write, isTTY: false }).table(
      ['MODEL', 'VERDICT', 'COST'],
      [
        ['claude-opus-5', 'pass', '$5.81'],
        ['glm-5.3-flash', 'fail', '$0.61'],
      ],
    );
    const text = stripAnsi(s.lines.join(''));
    expect(text).not.toMatch(/[┌│└─┐┘├]/);
    const rows = text.trim().split('\n');
    expect(rows[0]).toMatch(/^MODEL\s+VERDICT\s+COST$/);
    expect(rows).toHaveLength(3);
  });
});
