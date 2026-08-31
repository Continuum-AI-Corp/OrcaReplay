/**
 * Argument parsing.
 *
 * Hand-rolled on purpose: a debugger you install to diagnose a broken environment should not drag
 * in a dependency tree of its own. The one rule worth stating is that everything after a bare
 * `--` belongs to the child agent, never to us — `orca record claude -- -p "fix the test"` has to
 * forward those bytes untouched.
 */

export type FlagValue = string | number | boolean;

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, FlagValue>;
  /** Everything after a bare `--`, forwarded verbatim to the agent. */
  passthrough: string[];
  /** Read a flag as a comma-separated list. */
  list(name: string): string[];
  has(name: string): boolean;
  str(name: string, fallback?: string): string | undefined;
  num(name: string, fallback?: number): number | undefined;
  bool(name: string, fallback?: boolean): boolean;
}

/**
 * Flags that never take a value.
 *
 * Without this list any flag followed by a non-flag token swallowed it, so the flag read as false
 * *and* the positional vanished. `orca replay --worktree last` then restored the recorded tree over
 * the working directory — the exact opposite of what `--worktree` promises — and
 * `orca record --tls-intercept codex` turned interception off while losing the agent name, so
 * record auto-detected and could capture a different harness. Neither said anything.
 *
 * A list rather than a heuristic, because the alternative is guessing from the shape of the next
 * token, and `orca compare --models last` would guess wrong. `--flag=value` and `--no-flag` still
 * work for these; they are handled before this point.
 */
const VALUELESS = new Set([
  'ui',
  'json',
  'loose',
  'in-place',
  'worktree',
  'trace',
  'fs',
  'shell',
  'ci',
  'verbose',
  'color',
  'dry-run',
  'drop-fs',
  'tls-intercept',
  'version',
  'help',
]);

function coerce(raw: string): FlagValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // Only a complete numeric literal becomes a number; "5.3-flash" must stay a string.
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** A token is a flag only if it is not a negative number: `--from -1` passes -1 as a value. */
function isFlag(token: string): boolean {
  return token.startsWith('-') && token !== '-' && !/^-?\d+(\.\d+)?$/.test(token);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  let passthrough: string[] = [];

  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv.slice() : argv.slice(0, separator);
  if (separator !== -1) passthrough = argv.slice(separator + 1);

  for (let i = 0; i < own.length; i += 1) {
    const token = own[i]!;
    if (!isFlag(token)) {
      positionals.push(token);
      continue;
    }

    const isLong = token.startsWith('--');
    const body = isLong ? token.slice(2) : token.slice(1);

    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = coerce(body.slice(eq + 1));
      continue;
    }

    if (isLong && body.startsWith('no-')) {
      flags[body.slice(3)] = false;
      continue;
    }

    const next = own[i + 1];
    if (!VALUELESS.has(body) && next !== undefined && !isFlag(next)) {
      flags[body] = coerce(next);
      i += 1;
    } else {
      flags[body] = true;
    }
  }

  const command = positionals.shift() ?? 'help';

  return {
    command,
    positionals,
    flags,
    passthrough,
    list(name) {
      const v = flags[name];
      if (v === undefined || typeof v === 'boolean') return [];
      return String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    },
    has(name) {
      return name in flags;
    },
    str(name, fallback) {
      const v = flags[name];
      return v === undefined || typeof v === 'boolean' ? fallback : String(v);
    },
    num(name, fallback) {
      const v = flags[name];
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
      return fallback;
    },
    bool(name, fallback = false) {
      const v = flags[name];
      return typeof v === 'boolean' ? v : fallback;
    },
  };
}
