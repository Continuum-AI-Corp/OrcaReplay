/**
 * Terminal output.
 *
 * The CLI is most of this product's surface, and most of its output ends up somewhere that is not
 * a terminal — a CI log, a pipe into grep, a pasted GitHub issue. So: colour only on a real TTY,
 * no animation that corrupts a log, one greppable `level event key=value` line per fact, and
 * errors that say what happened, what it means, and what to run next.
 */

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

const STYLE = {
  dim: `${CSI}2m`,
  bold: `${CSI}1m`,
  reset: `${CSI}0m`,
} as const;

/** Matches SGR sequences without embedding a raw control character in source. */
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * NOTHING THIS PROCESS DID NOT WRITE MAY MOVE THE CURSOR.
 *
 * A table cell and a failure message are both printed verbatim, and both carry strings that came
 * from somewhere else: a run listing is the gateway's, an event detail is the trace's, a refusal
 * is whatever the host chose to say, and a trace can be one a colleague sent you. Measured against
 * `orca list --remote` answered by a hostile listing:
 *
 *   - a newline in a cell breaks one row into two, and the second is a FABRICATED RUN — in a
 *     listing whose entire purpose is to hand `orca pull` an id, an id the gateway never held;
 *   - a carriage return overwrites the row already on screen, so OUTCOME can read `exit 0` in the
 *     data and `exit 137` on the terminal;
 *   - `ESC [ 2 J` clears the screen, and `ESC ] 8` makes the text say one thing while the link
 *     underneath goes somewhere else.
 *
 * None of that is a rendering fault — it is a value being executed instead of shown. So a control
 * character is printed as what it is. `\x0a` in a cell is ugly, and is meant to be: it shows up
 * only when something put a control character where a name belongs.
 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

export function tame(text: string): string {
  return text.replace(CONTROL_RE, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/**
 * Shapes that must never reach a terminal. §7 applies to output, not only to disk: terminals
 * scroll into screenshots, and a key printed once is a key leaked forever.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

/** Keys whose value is secret by name, whatever it happens to look like. */
const SECRET_KEYS = /^(api[_-]?key|key|token|secret|password|authorization|cookie)$/i;

export type Scalar = string | number | boolean | null | undefined;
export type Fields = Record<string, Scalar>;

/**
 * One structured fact, before it is turned into a line of text.
 *
 * The same record that becomes `warn capture.empty exchanges=0 …` on a terminal. A caller that
 * embedded orca has no stdout to read, and an agent asking for `--json` should not be handed
 * prose to parse — so every fact is available as data at the point it is emitted, and the line is
 * a rendering of it rather than the only form it ever takes.
 *
 * Fields arrive redacted, exactly as the terminal would show them: a key must not reach a JSON
 * consumer just because it took a different route out.
 */
export interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  event: string;
  fields: Record<string, Scalar>;
}

export interface OutputOptions {
  write: (s: string) => void;
  /** Receives every fact as data, in the order it was emitted. */
  sink?: (entry: LogEntry) => void;
  isTTY?: boolean;
  env?: Record<string, string | undefined>;
  verbose?: boolean;
  ci?: boolean;
  /** Explicit override from `--no-color`. Wins over TTY detection and NO_COLOR alike. */
  color?: boolean;
}

export interface Failure {
  event: string;
  /** What happened. */
  what: string;
  /** What it means — the part that turns a message into an explanation. */
  why?: string;
  /** The next command to run. An error without this is a bug report we will receive instead. */
  next?: string;
}

export class Output {
  readonly #write: (s: string) => void;
  readonly #color: boolean;
  readonly #tty: boolean;
  readonly #verbose: boolean;
  readonly #ci: boolean;
  readonly #sink: ((entry: LogEntry) => void) | undefined;

  constructor(opts: OutputOptions) {
    const env = opts.env ?? {};
    this.#write = opts.write;
    this.#sink = opts.sink;
    this.#tty = opts.isTTY ?? false;
    this.#ci = opts.ci ?? false;
    this.#verbose = opts.verbose ?? false;
    // NO_COLOR is honoured whatever its value; see no-color.org. An explicit `color: false` from
    // `--no-color` overrides everything — it is the flag people reach for when a log has come out
    // unreadable, so it has to win rather than be one input among several.
    this.#color = opts.color ?? (this.#tty && !this.#ci && env.NO_COLOR === undefined);
  }

  get isVerbose(): boolean {
    return this.#verbose;
  }

  info(event: string, fields: Fields = {}): void {
    this.#line('info', event, fields);
  }

  warn(event: string, fields: Fields = {}): void {
    this.#line('warn', event, fields, STYLE.bold);
  }

  error(event: string, fields: Fields = {}): void {
    this.#line('error', event, fields, STYLE.bold);
  }

  debug(event: string, fields: Fields = {}): void {
    if (!this.#verbose) return;
    this.#line('debug', event, fields, STYLE.dim);
  }

  /** One line per phase. Always printed, including under --ci. */
  phase(event: string, fields: Fields = {}): void {
    this.#line('info', event, fields);
  }

  /**
   * Transient status. Printed only on an interactive TTY: in a pipe it is noise, and in CI it
   * turns a log into thousands of lines of escape codes.
   */
  progress(message: string): void {
    if (!this.#tty || this.#ci) return;
    this.#write(`${this.#paint(STYLE.dim)}${message}${this.#paint(STYLE.reset)}\n`);
  }

  /** Free-form text for help and reports, where key=value would be worse than prose. */
  plain(message = ''): void {
    this.#write(`${message}\n`);
  }

  failure(f: Failure): void {
    this.error(f.event, {});
    // Tamed but not redacted: a failure is a SENTENCE this code composed, and blanking all of it
    // because one substring looked like a key would throw away the explanation. A cell is a value
    // and can be replaced whole; a sentence cannot.
    this.plain(`  ${tame(f.what)}`);
    if (f.why) this.plain(`  ${tame(f.why)}`);
    if (f.next) this.plain(`  next: ${tame(f.next)}`);
  }

  /** Aligned columns, no box drawing — a table people can pipe into awk. */
  table(headers: string[], rows: string[][]): void {
    // BEFORE THE WIDTHS, because a cell is as wide as what is printed, and what is printed is the
    // tamed form. A cell is a value, so a secret shape replaces the whole of it, exactly as
    // `info key=value` has always done — §7 is about output, not about which door it left by.
    // RAW FIRST, then tame — the order `formatValue` has always used. Taming before judging put a
    // hex digit where a control character had been, and every pattern is anchored with `\b`: an
    // ESC, tab or newline immediately before a key-shaped token therefore removed the boundary
    // the anchor needs, and the cell printed in full. The taming let through exactly the input it
    // exists for. `looksSecret` now also judges the control-stripped form, which is what closes
    // the same trick played one character later, inside the token.
    const clean = (c: string): string => (looksSecret(c) ? '<redacted>' : tame(c));
    const heads = headers.map(clean);
    const cells = rows.map((r) => heads.map((_, i) => clean(r[i] ?? '')));
    const widths = heads.map((h, i) =>
      Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length)),
    );
    const render = (row: string[]): string =>
      row
        .map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd();
    this.#write(`${this.#paint(STYLE.dim)}${render(heads)}${this.#paint(STYLE.reset)}\n`);
    for (const row of cells) this.#write(`${render(row)}\n`);
  }

  #paint(code: string): string {
    return this.#color ? code : '';
  }

  #line(level: string, event: string, fields: Fields, style?: string): void {
    const parts = [level, event];
    const structured: Record<string, Scalar> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      // Redacted once, for both destinations. A secret must not reach a JSON consumer merely
      // because it left by a different door than the terminal.
      structured[k] = redactValue(k, v);
      parts.push(`${k}=${formatValue(k, v)}`);
    }
    this.#sink?.({ level: level as LogEntry['level'], event, fields: structured });
    const body = parts.join(' ');
    this.#write(
      `${style ? this.#paint(style) : ''}${body}${style ? this.#paint(STYLE.reset) : ''}\n`,
    );
  }
}

/**
 * By shape alone — what a table cell can be judged on, having no key to be named by.
 *
 * JUDGED ON WHAT A READER COULD REASSEMBLE, not only on the bytes as they arrived. Every pattern
 * is anchored and its character class stops at the first byte outside it, so `sk-` followed by an
 * ESC and then the rest of the key matched nothing at all — while printing every character of
 * that key, in order, to the terminal. Removing the control characters before testing closes it,
 * and closes it for `info key=value` too, which had the same blind spot from the same cause.
 */
function looksSecret(raw: string): boolean {
  const stripped = raw.replace(CONTROL_RE, '');
  return SECRET_PATTERNS.some((re) => re.test(raw) || re.test(stripped));
}

function isSecret(key: string, raw: string): boolean {
  return SECRET_KEYS.test(key) || looksSecret(raw);
}

/** The value as data — the number or boolean kept as itself, anything secret replaced. */
function redactValue(key: string, value: Scalar): Scalar {
  return isSecret(key, String(value)) ? '<redacted>' : (value ?? null);
}

function formatValue(key: string, value: Scalar): string {
  const raw = String(value);
  const text = isSecret(key, raw) ? '<redacted>' : raw;
  return /[\s"]/.test(text) ? JSON.stringify(text) : text;
}
