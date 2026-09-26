import { describe, expect, it } from 'vitest';
import { cdCommand, Output, removeDirCommand, shellArg, stripAnsi } from '../src/out.js';

const ESC = String.fromCharCode(27);

/**
 * §14 of the design: the CLI is ~90% of the product surface. Most of these assertions exist
 * because the output ends up in a CI log, a pipe, or a pasted GitHub issue — not a terminal.
 */
describe('--no-color', () => {
  /**
   * `--no-color` is listed in `orca --help`, and nothing read it: `parseArgs` set the flag and
   * `Output` computed colour from `isTTY`/`ci`/`NO_COLOR` alone, so on a terminal the flag was
   * inert and `orca show --no-color` still emitted ANSI. A documented flag that does nothing is
   * worse than an undocumented one — it is the flag people pipe through when a log ends up
   * unreadable.
   */
  it('suppresses ANSI on a TTY when the flag is set', () => {
    const lines: string[] = [];
    const out = new Output({
      write: (s) => void lines.push(s),
      isTTY: true,
      color: false,
    });
    out.warn('divergence', { seq: 3 });
    expect(lines.join('')).not.toMatch(/\u001b\[/);
  });

  it('still colours a TTY when the flag is absent', () => {
    const lines: string[] = [];
    const out = new Output({ write: (s) => void lines.push(s), isTTY: true });
    out.warn('divergence', { seq: 3 });
    expect(lines.join('')).toMatch(/\u001b\[/);
  });
});

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
    expect(stripAnsi(s.lines[0]!).trim()).toBe(
      'info replay.done matched=68 total=68 divergences=0',
    );
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

/**
 * A TABLE IS NOT A TERMINAL PROGRAM.
 *
 * Every string in a row came from somewhere else — the gateway's run listing, a trace's event
 * detail, a trace a colleague sent you — and the renderer printed all of it verbatim. Measured
 * against `orca list --remote` answered by a hostile listing: a newline split one row into two
 * and the second was a run the gateway never held, a carriage return rewrote OUTCOME after it
 * was printed, and `ESC [ 2 J` cleared the screen. The fix belongs here rather than at each
 * caller, because "one row is one line" is a property of the table, not of whoever fills it.
 */
describe('table cells cannot drive the terminal', () => {
  const sink = () => {
    const lines: string[] = [];
    return { lines, write: (s: string) => void lines.push(s) };
  };
  const ESC_C = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);

  const render = (rows: string[][]): string[] => {
    const s = sink();
    new Output({ write: s.write, isTTY: false }).table(['A', 'B'], rows);
    return stripAnsi(s.lines.join('')).trim().split('\n');
  };

  it('does not let a newline invent a row that was never listed', () => {
    const rows = render([[`cc${LF}run_deadbeefcafe  gateway`, 'x']]);
    // One row in, one row out — header plus one.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('\\x0a');
    expect(rows[1]).toContain('run_deadbeefcafe');
  });

  it('does not let a carriage return rewrite what was already printed', () => {
    const rows = render([['ok', `exit 0${CR}exit 137`]]);
    expect(rows[1]).not.toContain(CR);
    expect(rows[1]).toContain('\\x0d');
  });

  it('shows an escape sequence instead of performing it', () => {
    const rows = render([
      [`${ESC_C}[2J${ESC_C}[Hgotcha`, `${ESC_C}]8;;https://evil${BEL}text${ESC_C}]8;;${BEL}`],
    ]);
    expect(rows.join('\n')).not.toContain(ESC_C);
    expect(rows.join('\n')).not.toContain(BEL);
    expect(rows[1]).toContain('\\x1b[2J');
    expect(rows[1]).toContain('\\x07');
  });

  it('pads on what is printed, so a tamed cell still lines up', () => {
    const rows = render([
      [`a${LF}b`, 'end'],
      ['aaaaaaaaaa', 'end'],
    ]);
    // `a@B@x0ab` is 7 wide, `aaaaaaaaaa` is 10, so both second cells start at the same column.
    expect(rows[1]!.indexOf('end')).toBe(rows[2]!.indexOf('end'));
  });

  /** A cell is a value, and `info key=value` has always replaced a secret-shaped value whole. */
  it('redacts a secret-shaped cell, as the key=value path does', () => {
    const rows = render([['sk-abcdefghij0123456789klmn', 'ok']]);
    expect(rows[1]).not.toContain('sk-abcdefghij');
    expect(rows[1]).toContain('<redacted>');
  });

  /**
   * A CHARACTER THAT REORDERS IS OBEYED JUST AS READILY AS ONE THAT MOVES THE CURSOR.
   *
   * The first version of this taming covered C0 and C1 — the ranges that move the cursor — and
   * stopped there. U+202E and its family are not in those ranges and a terminal honours them all
   * the same: they reverse what follows, and the effect runs to the end of the LINE rather than
   * the cell, so one field shuffles the columns beside it and a run key reads as a name it is
   * not. In a listing whose purpose is to hand `orca pull` an id, that is the same lie a newline
   * told, spelled differently.
   */
  describe('bidirectional controls are shown, not obeyed', () => {
    const sink = () => {
      const lines: string[] = [];
      return { lines, write: (s: string) => void lines.push(s) };
    };
    const render = (cell: string): string => {
      const s = sink();
      new Output({ write: s.write, isTTY: false }).table(['RUN', 'APP'], [[cell, 'app']]);
      return stripAnsi(s.lines.join('')).trim().split('\n')[1] ?? '';
    };

    const REORDERING = [
      '\u061C',
      '\u200E',
      '\u200F',
      '\u202A',
      '\u202B',
      '\u202C',
      '\u202D',
      '\u202E',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
    ];

    it.each(REORDERING)('escapes %j instead of letting it reorder the row', (ch) => {
      const row = render(`run_${ch}daeh_ekaf`);
      expect(row).not.toContain(ch);
      expect(row).toContain('\\u' + ch.codePointAt(0)!.toString(16).padStart(4, '0'));
      // Still one row, and the column beside it is still beside it.
      expect(row).toContain('app');
    });

    /**
     * The counterpart, and the reason this is a list rather than "every invisible character":
     * these COMPOSE text. They are how a family emoji, a heart and a Scotland flag are spelled,
     * and a trace's event detail is allowed to contain any of them. Mangling them would damage
     * legitimate content to defend against nothing — an invisible character does not lie about
     * the order of what is around it.
     */
    it.each([
      ['family emoji, joined by U+200D', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
      ['heart with U+FE0F', '\u2764\uFE0F'],
      [
        'flag spelled with tag characters',
        '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
      ],
      ['CJK', '网关网关'],
    ])('leaves %s exactly as it arrived', (_label, value) => {
      expect(render(value)).toContain(value);
    });

    /** A one-byte control is still spelled at one byte, as every other test here asserts. */
    it('keeps the two-digit spelling for C0', () => {
      expect(render('a\nb')).toContain('a\\x0ab');
    });
  });

  /**
   * ORDER, AND THEN POSITION.
   *
   * Two findings, one line apart. The taming first ran before the secret check, and every pattern
   * is anchored with `\b`: tamed, an ESC is spelled `\x1b`, whose last character is a hex digit —
   * a word character — so a control character immediately BEFORE a key-shaped token removed the
   * boundary the anchor needs. Testing the raw string fixed that and not the next case: a control
   * character INSIDE the token matched nothing either way, because the character class stops at
   * the first byte outside it — while every character of the key still reached the terminal, in
   * order. What a reader can reassemble is what has to be judged, so `looksSecret` strips control
   * characters before testing as well. That also closes it for `info key=value`, which had the
   * same blind spot from the same cause.
   */
  describe('a key survives no placement of a control character', () => {
    const sink = () => {
      const lines: string[] = [];
      return { lines, write: (s: string) => void lines.push(s) };
    };
    const KEY = 'sk-abcdefghij0123456789kl';
    const at = (code: number, cut: number): string =>
      KEY.slice(0, cut) + String.fromCharCode(code) + KEY.slice(cut);

    // 0 is before the token; 3 is just after `sk-`; 8 and 20 are inside the run of key characters.
    const places: [number, number][] = [];
    for (const code of [27, 9, 10, 13, 0])
      for (const cut of [0, 3, 8, 20]) places.push([code, cut]);

    it.each(places)('table(): control %i at offset %i', (code, cut) => {
      const s = sink();
      new Output({ write: s.write, isTTY: false }).table(['A'], [[at(code, cut)]]);
      const row = stripAnsi(s.lines.join(''));
      // Recoverable = every character of the key reaches the reader, however it is spelled.
      expect(row.replace(/\\x[0-9a-f]{2}/g, '')).not.toContain(KEY);
      expect(row).toContain('<redacted>');
    });

    it.each(places)('info key=value: control %i at offset %i', (code, cut) => {
      const s = sink();
      new Output({ write: s.write, isTTY: false }).info('probe', { models: at(code, cut) });
      const line = stripAnsi(s.lines.join(''));
      expect(line.replace(/\\[nrt]|\u00[0-9a-f]{2}/g, '')).not.toContain(KEY);
      expect(line).toContain('<redacted>');
    });
  });

  /**
   * THE CLASS, NOT THE CASE.
   *
   * Two earlier fixes here each closed the character that had been found — a control character
   * before a key, then one inside it — and review then found a zero-width space inside one, which
   * neither covered. Every invisible character does the same thing: the reader sees the key whole,
   * and the pattern's character class stops at the character it cannot see. So this asserts the
   * class, on both output paths, and the characters are named rather than generated so a reader of
   * the test can see what each one is.
   */
  describe('a key survives no invisible character inside it', () => {
    const sink = () => {
      const lines: string[] = [];
      return { lines, write: (s: string) => void lines.push(s) };
    };
    const KEY = 'sk-abcdefghij0123456789klmn';
    const INVISIBLE: [string, string][] = [
      ['zero-width space', '\u200B'],
      ['zero-width non-joiner', '\u200C'],
      ['zero-width joiner', '\u200D'],
      ['word joiner', '\u2060'],
      ['byte-order mark', '\uFEFF'],
      ['soft hyphen', '\u00AD'],
      ['variation selector 16', '\uFE0F'],
      ['combining grapheme joiner', '\u034F'],
      ['combining acute accent', '\u0301'],
      ['tag character', '\u{E0041}'],
      // Outside Cf and M, and blank all the same — review found these after the first version of
      // this list claimed to cover "everything a reader does not see". They are in core's set now.
      ['Hangul filler', '\u3164'],
      ['Hangul choseong filler', '\u115F'],
      ['Hangul jungseong filler', '\u1160'],
      ['halfwidth Hangul filler', '\uFFA0'],
      ['braille pattern blank', '\u2800'],
    ];
    const places = [3, 8, 20];
    const cases = INVISIBLE.flatMap(([name, ch]) => places.map((at) => [name, ch, at] as const));

    it.each(cases)('table(): %s at offset %i', (_name, ch, at) => {
      const s = sink();
      const cell = KEY.slice(0, at) + ch + KEY.slice(at);
      new Output({ write: s.write, isTTY: false }).table(['A'], [[cell]]);
      expect(stripAnsi(s.lines.join(''))).toContain('<redacted>');
    });

    it.each(cases)('info key=value: %s at offset %i', (_name, ch, at) => {
      const s = sink();
      const value = KEY.slice(0, at) + ch + KEY.slice(at);
      new Output({ write: s.write, isTTY: false }).info('probe', { models: value });
      expect(stripAnsi(s.lines.join(''))).toContain('<redacted>');
    });

    /** Stripped only to be JUDGED: what is printed is untouched, so an emoji still arrives whole. */
    it('changes nothing about how an ordinary cell is printed', () => {
      const s = sink();
      const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
      new Output({ write: s.write, isTTY: false }).table(['A'], [[family]]);
      expect(stripAnsi(s.lines.join(''))).toContain(family);
    });
  });

  /** A failure is a sentence this code composed; taming it must not blank the explanation. */
  it('tames a failure message without discarding it', () => {
    const s = sink();
    new Output({ write: s.write, isTTY: false }).failure({
      event: 'list.failed',
      what: `gateway answered 403: denied${CR}all clear`,
    });
    const text = stripAnsi(s.lines.join(''));
    expect(text).not.toContain(CR);
    expect(text).toContain('gateway answered 403: denied');
    expect(text).toContain('\\x0d');
  });
});

/**
 * A PATH IN A HINT HAS TO BE ONE ARGUMENT WHEN PASTED.
 *
 * `rm -rf ${runDir}` and `cd ${target}` were printed bare, so a path with a space in it pasted as
 * two arguments: the scrub hint, run from under a directory named `John Smith`, removed `…/John`
 * instead of the run it named. On Windows `rm -rf` was not a command at all in PowerShell, whose
 * `rm` is Remove-Item with `-Recurse` and no `-rf`.
 */
describe('paths printed inside a suggested command', () => {
  // Windows paths through String.raw. In an ordinary string literal `\U` is `U` and `\r` is a
  // carriage return, and the first version of these tests wrote them that way — so every "Windows
  // path" under test held no backslash at all, and the delete-command one held a carriage return.
  const win = (s: TemplateStringsArray): string => String.raw(s);
  const BACKSLASH = String.fromCharCode(92);

  it('leaves an ordinary path as it was', () => {
    expect(shellArg('/home/u/proj/.orca/runs/run_x', 'linux')).toBe(
      '/home/u/proj/.orca/runs/run_x',
    );
    expect(shellArg(win`C:\Users\dev\proj`, 'win32')).toBe(win`C:\Users\dev\proj`);
    expect(shellArg('/home/u/工作区', 'linux')).toBe('/home/u/工作区');
  });

  it('quotes a path with a space the way each platform expects', () => {
    expect(shellArg('/home/u/John Smith/p', 'linux')).toBe("'/home/u/John Smith/p'");
    expect(shellArg(win`C:\Users\John Smith\p`, 'win32')).toBe(win`"C:\Users\John Smith\p"`);
  });

  it('keeps an apostrophe in a POSIX path inside the quoting', () => {
    expect(shellArg("/tmp/it's here", 'linux')).toBe(String.raw`'/tmp/it'\''s here'`);
  });

  it('uses literal quotes for a Windows path PowerShell would otherwise expand', () => {
    expect(shellArg(win`C:\pay$day files\p`, 'win32')).toBe(win`'C:\pay$day files\p'`);
  });

  /** The first version of these tests could not have noticed a backslash going missing. */
  it('keeps every backslash of a Windows path', () => {
    const quoted = shellArg(win`C:\Users\John Smith\r`, 'win32');
    expect([...quoted].filter((c) => c === BACKSLASH)).toHaveLength(3);
  });

  /**
   * Remove-Item's default `-Path` reads `[dev]` as a character class — quoting stops the shell
   * from globbing, not the cmdlet. With a neighbour `John d\run_x`, the hint without
   * `-LiteralPath` deleted the neighbour and left the run.
   */
  it('names a delete command the platform shell has, taking the path literally', () => {
    expect(removeDirCommand('/home/u/John Smith/r', 'linux')).toBe("rm -rf '/home/u/John Smith/r'");
    expect(removeDirCommand(win`C:\Users\John [dev]\r`, 'win32')).toBe(
      win`Remove-Item -Recurse -Force -LiteralPath "C:\Users\John [dev]\r"`,
    );
  });

  /** Set-Location globs the same way; `-LiteralPath` only where a bracket makes the shells differ. */
  it('takes a bracketed Windows directory literally in cd, and only that one', () => {
    expect(cdCommand(win`C:\Users\John [dev]\proj`, 'win32')).toBe(
      win`cd -LiteralPath "C:\Users\John [dev]\proj"`,
    );
    expect(cdCommand(win`C:\Users\John Smith\proj`, 'win32')).toBe(
      win`cd "C:\Users\John Smith\proj"`,
    );
    expect(cdCommand('/home/u/John [dev]/proj', 'linux')).toBe("cd '/home/u/John [dev]/proj'");
  });
});
