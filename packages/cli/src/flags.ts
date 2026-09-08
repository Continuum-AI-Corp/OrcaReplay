import { NUMERIC, VALUELESS } from './args.js';
import type { ParsedArgs } from './args.js';

/**
 * Which flags each command accepts.
 *
 * The parser takes any flag it is given, which is right for parsing and wrong for a CLI: a
 * mistyped or invented flag was accepted in silence and simply had no effect, so a run that did
 * something other than what was asked reported success.
 *
 * Every entry below is a flag the code actually reads — collected from the `args.bool/str/num/list`
 * calls in each command and in the helpers it shares — not from what the documentation describes.
 * Building it the other way round is how a flag that never existed came to be recommended in the
 * first place, and a list that allows more than the code understands would rebuild exactly that.
 */
export const GLOBAL = ['ci', 'json', 'verbose', 'color', 'help', 'version', 'h'] as const;

/** Read by `config.ts` for any command that can reach a provider. */
const UPSTREAM = ['upstream-anthropic', 'upstream-openai'] as const;

/** Read by `tls-capture.ts`, which record, replay and compare all set up. */
const TLS = ['tls-intercept', 'tls-hosts'] as const;

export const BY_COMMAND: Record<string, readonly string[]> = {
  record: ['fs', 'shell', 'mcp-config', ...TLS, ...UPSTREAM],
  attach: [
    'for',
    'bind',
    'advertise',
    'port',
    'remote-ca-path',
    'replay',
    'loose',
    ...TLS,
    ...UPSTREAM,
  ],
  replay: [
    'from',
    'model',
    'fs',
    'in-place',
    'worktree',
    'loose',
    'trace',
    'port',
    'ui',
    'mcp-config',
    ...TLS,
    ...UPSTREAM,
    'quiet',
  ],
  compare: ['from', 'models', 'verify', 'share', 'loose', ...TLS, ...UPSTREAM],
  show: [],
  checkpoints: [],
  events: [],
  // `inspect.ts` serves graph, export and ui from one file, so the flags of all three are read
  // there. Reading a file rather than a command is how the first version of this list came to
  // give `export` two flags and lose the three it needs — `--card`, `--graph-card` and `--to`
  // are the picture commands the README documents, and rejecting them broke a working feature.
  graph: ['to'],
  export: ['o', 'out', 'card', 'graph-card', 'to'],
  ui: ['port'],
  scrub: ['match', 'matches', 'dry-run', 'drop-fs'],
  list: [],
  gc: ['older-than', 'keep', 'dry-run'],
  doctor: [],
  setup: ['gateway', 'key', 'key-env', 'models'],
  models: [],
  mcp: [],
  help: [],
};

/** The closest known flag, for a name that is probably a typo rather than an invention. */
function nearest(name: string, known: readonly string[]): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const candidate of known) {
    // Prefix and containment both catch the realistic slips: `--worktre`, `--model-s`.
    const prefix = candidate.startsWith(name) || name.startsWith(candidate) ? 2 : 0;
    const contains = candidate.includes(name) || name.includes(candidate) ? 1 : 0;
    const score = Math.max(prefix, contains);
    if (score > 0 && (best === undefined || score > best.score)) best = { name: candidate, score };
  }
  return best?.name;
}

/**
 * Reject a flag this command does not have.
 *
 * Throws rather than warns. A flag is an instruction, and carrying on having ignored one produces
 * a run that did something other than what was asked while reporting success — which is the
 * failure this whole tool exists to make visible.
 */
export function assertKnownFlags(args: ParsedArgs): void {
  const allowed = BY_COMMAND[args.command];
  // An unknown command is reported by the dispatcher, which can say more about it than this can.
  if (allowed === undefined) return;
  const known = [...allowed, ...GLOBAL];
  const unknown = Object.keys(args.flags).filter((name) => !known.includes(name));
  // Names first: "unknown flag --modle" is a better answer than "--modle needs a value".
  if (unknown.length === 0) {
    assertUsableValues(args, known);
    return;
  }

  const [first] = unknown;
  const suggestion = nearest(first!, known);
  throw new Error(
    `unknown flag ${dashed(first!)} for "orca ${args.command}"` +
      (suggestion === undefined ? '' : `\n  did you mean --${suggestion}?`) +
      `\n  flags for this command: ${allowed.length === 0 ? '(none)' : allowed.map((f) => `--${f}`).join(' ')}`,
  );
}

/**
 * How many positional arguments each command reads.
 *
 * Counted from the `positionals[0]` call sites, the same way the flag list above is counted from
 * the `args.*` ones. `record` reads an agent name and the run commands read a selector; the seven
 * that read none genuinely take none — `attach` is configured entirely by flags, and `list`, `gc`,
 * `doctor`, `setup`, `models` and `mcp` take nothing at all.
 */
const POSITIONALS: Record<string, number> = {
  record: 1,
  replay: 1,
  compare: 1,
  show: 1,
  events: 1,
  checkpoints: 1,
  graph: 1,
  export: 1,
  ui: 1,
  scrub: 1,
  attach: 0,
  list: 0,
  gc: 0,
  doctor: 0,
  setup: 0,
  models: 0,
  mcp: 0,
  help: 0,
};

/** Exposed so a test can hold {@link POSITIONALS} against the source it mirrors. */
export const POSITIONAL_COUNTS: Readonly<Record<string, number>> = POSITIONALS;

/**
 * Reject a positional argument the command does not read.
 *
 * The parser collects every token that is not a flag, and each command reads at most the first.
 * Anything past that was dropped in silence — and for `record` that is the worst shape available:
 * the arguments meant for the agent never reach it, the harness starts with none, and orca reports
 * a successful recording of a run that was never asked to do anything.
 *
 *   orca record codex exec "fix auth.ts"    ->  manifest argv: ["codex"]
 *
 * The agent's own arguments go after `--`, which is the one thing that message has to say. Counting
 * per command rather than allowing one everywhere matters for the seven that read none: `orca
 * attach claude` looks like it names the agent, and `--for` is what actually does.
 */
export function assertNoStrayPositionals(args: ParsedArgs): void {
  // An unknown command is the dispatcher's to report, as above.
  const takes = POSITIONALS[args.command];
  if (takes === undefined) return;
  const stray = args.positionals.slice(takes);
  if (stray.length === 0) return;

  const quote = (a: string): string => (/\s/.test(a) ? `"${a}"` : a);
  const listed = stray.map(quote).join(' ');
  const takesLine =
    takes === 0
      ? `\n  "orca ${args.command}" takes no arguments; everything it needs is a flag`
      : `\n  "orca ${args.command}" takes one: ${quote(args.positionals[0]!)}`;
  // Only `record` hands its tail to something else, so only `record` can say where the tail goes.
  const forAgent =
    args.command === 'record'
      ? `\n  arguments for the agent go after --: orca record ${quote(args.positionals[0]!)} -- ${listed}`
      : '';
  throw new Error(
    `unexpected argument${stray.length > 1 ? 's' : ''} for "orca ${args.command}": ${listed}` +
      takesLine +
      forAgent,
  );
}

/**
 * A flag as the person would have typed it.
 *
 * Every short flag here is one character, so the count of dashes follows from the length. Telling
 * someone `--o needs a value` when they typed `-o` sends them looking for a flag that does not
 * exist.
 */
function dashed(name: string): string {
  return name.length === 1 ? `-${name}` : `--${name}`;
}

/**
 * Reject a flag whose value cannot be honoured.
 *
 * `assertKnownFlags` settled the names; the values were still taken on trust. Every accessor falls
 * back in silence when a value is missing or of the wrong shape, so the instruction vanished and
 * the run reported success having done something else:
 *
 *   `--model` with nothing after it turned a fork into a plain replay, and the two models being
 *   compared agreed because only one of them ever ran. `--match a --match b` redacted `b` alone and
 *   reported its count as though that were the whole job. `--from four` replayed everything instead
 *   of forking at a checkpoint. `--json=maybe` turned JSON output off while it was being asked for.
 *
 * Same reasoning as `assertNoStrayPositionals` beside it, third part of the command line: an
 * instruction orca cannot carry out must not be carried past in silence.
 *
 * `orca gc --keep` checked its own by hand and was the only command that did. Doing it here is the
 * same check for all of them, and one place to fix when it is wrong.
 */
function assertUsableValues(args: ParsedArgs, allowed: readonly string[]): void {
  for (const name of Object.keys(args.flags)) {
    const value = args.flags[name];

    // Repeating a flag is how most CLIs take a list, so people write it. Say which form is one here
    // rather than only saying no.
    if (args.conflicting.has(name)) {
      const listForm = [`${name}s`, `${name}es`].find((f) => allowed.includes(f));
      throw new Error(
        `${dashed(name)} given more than once, and only the last would have counted` +
          (listForm === undefined
            ? '\n  give it once'
            : `\n  for several, use one --${listForm}: --${listForm} a,b,c`),
      );
    }

    if (NUMERIC.has(name)) {
      if (args.missingValue.has(name) || typeof value === 'string') {
        throw new Error(`${dashed(name)} needs a number, like ${dashed(name)} 4`);
      }
      continue;
    }

    // `--flag`, `--flag=true` and `--no-flag` all arrive as a boolean. Anything else is a value on
    // a switch, and the switch would then have read as off.
    if (VALUELESS.has(name)) {
      if (typeof value === 'string') {
        throw new Error(`${dashed(name)} takes no value; it is either given or it is not`);
      }
      continue;
    }

    if (args.missingValue.has(name)) throw new Error(`${dashed(name)} needs a value`);
  }
}
