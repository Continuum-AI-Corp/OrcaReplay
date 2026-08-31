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
const GLOBAL = ['ci', 'json', 'verbose', 'color', 'help', 'version', 'h'] as const;

/** Read by `config.ts` for any command that can reach a provider. */
const UPSTREAM = ['upstream-anthropic', 'upstream-openai'] as const;

/** Read by `tls-capture.ts`, which record, replay and compare all set up. */
const TLS = ['tls-intercept', 'tls-hosts'] as const;

const BY_COMMAND: Record<string, readonly string[]> = {
  record: ['fs', 'shell', 'mcp-config', ...TLS, ...UPSTREAM],
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
  ],
  compare: ['from', 'models', 'verify', 'share', 'loose', ...TLS, ...UPSTREAM],
  show: [],
  checkpoints: [],
  export: ['o', 'out'],
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
  if (unknown.length === 0) return;

  const [first] = unknown;
  const suggestion = nearest(first!, known);
  throw new Error(
    `unknown flag --${first} for "orca ${args.command}"` +
      (suggestion === undefined ? '' : `\n  did you mean --${suggestion}?`) +
      `\n  flags for this command: ${allowed.length === 0 ? '(none)' : allowed.map((f) => `--${f}`).join(' ')}`,
  );
}
