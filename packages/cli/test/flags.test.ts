import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import {
  BY_COMMAND,
  GLOBAL,
  POSITIONAL_COUNTS,
  assertKnownFlags,
  assertNoStrayPositionals,
} from '../src/flags.js';

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

/**
 * The list is hand-written, and a hand-written mirror of the code drifts the moment the code moves.
 * These two read the source and hold it to the same standard the file claims for itself.
 *
 * Both were written after the list shipped with real holes in it: `orca export --card` — a picture
 * command the README documents and `inspect.ts` implements — was rejected outright, and `graph`
 * had no entry at all, so every flag it took went unchecked. One file, `inspect.ts`, serves show,
 * graph, export and ui, and the list was built a command at a time; the flags of the other three
 * were simply never looked for.
 */
describe('the allowlist against the source it mirrors', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

  /** Every `args.bool|str|num|list('name')` in the CLI's own source. */
  function flagsReadInSource(): Set<string> {
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) {
          const src = readFileSync(path, 'utf8');
          for (const m of src.matchAll(/args\.(?:bool|str|num|list)\('([^']+)'\)/g)) {
            found.add(m[1]!);
          }
        }
      }
    };
    walk(SRC);
    return found;
  }

  it('allows every flag the CLI actually reads somewhere', () => {
    const allowed = new Set<string>([...GLOBAL, ...Object.values(BY_COMMAND).flat()]);
    const unreachable = [...flagsReadInSource()].filter((name) => !allowed.has(name)).sort();
    // A flag the code reads and no command allows can never be passed: the command throws first.
    expect(unreachable).toEqual([]);
  });

  it('has an entry for every command the dispatcher handles', () => {
    const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
    const dispatched = [...main.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]!);
    // Without an entry, assertKnownFlags returns early and the command validates nothing at all —
    // silently, which is the failure this whole file exists to prevent.
    const unvalidated = dispatched.filter((c) => BY_COMMAND[c] === undefined).sort();
    expect(unvalidated).toEqual([]);
  });
});

/**
 * The other half of the command line. `orca record codex exec "fix auth.ts"` recorded
 * `argv: ["codex"]` — the agent started with no arguments at all, did nothing it was asked, and
 * the run was reported as a success. Nothing in the output said the words had been dropped.
 */
describe('assertNoStrayPositionals', () => {
  const check = (argv: string[]) => () => assertNoStrayPositionals(parseArgs(argv));

  it('rejects the agent arguments that were silently dropped, and shows where they go', () => {
    expect(check(['record', 'codex', 'exec', 'fix auth.ts'])).toThrow(
      /unexpected arguments for "orca record": exec "fix auth\.ts"/,
    );
    expect(check(['record', 'codex', 'exec', 'fix auth.ts'])).toThrow(
      /orca record codex -- exec "fix auth\.ts"/,
    );
  });

  it('leaves the correct form alone, because that is where the agent arguments belong', () => {
    expect(check(['record', 'codex', '--', 'exec', 'fix auth.ts'])).not.toThrow();
    expect(check(['record', 'claude'])).not.toThrow();
    expect(check(['record'])).not.toThrow();
  });

  it('rejects a stray on a read command too, without offering the -- advice', () => {
    expect(check(['show', 'last', 'extra'])).toThrow(/unexpected argument for "orca show": extra/);
    expect(check(['show', 'last', 'extra'])).not.toThrow(/--/);
  });

  /**
   * Seven commands read no positional at all, so allowing one everywhere would have left the same
   * silence in place for them. `orca attach claude` reads as naming the agent and does not: the
   * flag that names it is `--for`.
   */
  it('rejects the first argument on a command that reads none', () => {
    expect(check(['attach', 'claude'])).toThrow(/unexpected argument for "orca attach": claude/);
    expect(check(['attach', 'claude'])).toThrow(
      /takes no arguments; everything it needs is a flag/,
    );
    expect(check(['list', 'foo'])).toThrow(/unexpected argument for "orca list": foo/);
    expect(check(['doctor', 'foo'])).toThrow(/unexpected argument/);
  });

  it('leaves those commands alone when they are given none', () => {
    expect(check(['attach', '--for', 'claude'])).not.toThrow();
    expect(check(['list'])).not.toThrow();
    expect(check(['gc', '--older-than', '7d'])).not.toThrow();
  });

  it('says nothing about an unknown command, which the dispatcher reports better', () => {
    expect(check(['bogus', 'a', 'b'])).not.toThrow();
  });

  /**
   * The rule is "one positional", and it holds only while no command reads further. Asserted
   * against the source rather than trusted, so a command that starts taking two arguments fails
   * here instead of having them rejected at the door.
   */
  it('holds because no command reads past the first positional', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const beyondFirst: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) {
          for (const m of readFileSync(path, 'utf8').matchAll(/positionals\[(\d+)\]/g)) {
            if (Number(m[1]) > 0) beyondFirst.push(`${entry.name}: positionals[${m[1]}]`);
          }
        }
      }
    };
    walk(src);
    expect(beyondFirst).toEqual([]);
  });
});

/**
 * The counts are hand-written and the code they describe is not. These hold one against the other
 * so a command that starts or stops reading a positional fails here rather than silently dropping
 * an argument again.
 */
describe('the positional counts against the source they mirror', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

  it('gives a count to every command the flag list knows', () => {
    const missing = Object.keys(BY_COMMAND)
      .filter((c) => POSITIONAL_COUNTS[c] === undefined)
      .sort();
    expect(missing).toEqual([]);
  });

  it('never claims a command reads more than the source does', () => {
    // A count above 1 would mean somewhere reads `positionals[1]`, and nothing does.
    const overclaimed = Object.entries(POSITIONAL_COUNTS)
      .filter(([, n]) => n > 1)
      .map(([c]) => c);
    expect(overclaimed).toEqual([]);
  });

  it('claims zero only for commands whose implementation reads none', () => {
    // One file per command where the mapping is one to one; inspect.ts and main.ts serve several,
    // so they are excluded rather than guessed at.
    const wrong: string[] = [];
    for (const [command, n] of Object.entries(POSITIONAL_COUNTS)) {
      const file = join(SRC, 'commands', `${command}.ts`);
      if (!existsSync(file)) continue;
      const reads = readFileSync(file, 'utf8').includes('positionals[0]');
      if (reads !== (n === 1))
        wrong.push(`${command}: table says ${n}, source ${reads ? 'reads' : 'does not read'} one`);
    }
    expect(wrong).toEqual([]);
  });
});
