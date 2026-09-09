import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const mainSource = join(here, '..', 'src', 'main.ts');

/** The `case 'x':` labels of one switch. */
function commandsIn(source: string): Set<string> {
  return new Set([...source.matchAll(/^\s*case '([a-z-]+)':/gm)].map((m) => m[1]!));
}

/**
 * `--json` answers one view the terminal does not, and `--help` lists it in the same `·`-separated
 * line as seven that it does:
 *
 *     --json         one JSON document on stdout, diagnostics on stderr
 *                    list · show · events · checkpoints · graph · record · replay · compare
 *
 * Seven of those are commands. `events` is not, and typing it said so in the flattest terms
 * available:
 *
 *     $ orca events
 *     error unknown_command
 *       there is no "events" command
 *
 * from a tool whose own `--help` had just named it — which reads as the CLI contradicting itself
 * rather than as one view being data-only.
 *
 * Adding `orca events` as a terminal command was the other option and is the wrong one:
 * `buildTimeline` is `events.map(...)`, so `orca show` already renders every event in the trace.
 * A second table of the same rows would be a worse `show`. What was missing was the sentence
 * saying so.
 */
describe('commands that only --json answers', () => {
  it('are exactly the ones JSON_ONLY names', async () => {
    const source = await readFile(mainSource, 'utf8');
    // Everything before `jsonMain` is the terminal switch; everything after is the `--json` one.
    const split = source.indexOf('async function jsonMain(');
    expect(split, 'main.ts no longer has a jsonMain to split on').toBeGreaterThan(0);

    const terminal = commandsIn(source.slice(0, split));
    const json = commandsIn(source.slice(split));
    const jsonOnly = [...json].filter((c) => !terminal.has(c)).sort();

    const declared = /const JSON_ONLY = new Set\((\[[^\]]*\])\)/.exec(source);
    expect(declared, 'JSON_ONLY is gone or no longer a literal set').not.toBeNull();
    const named = (JSON.parse(declared![1]!.replace(/'/g, '"')) as string[]).sort();

    // The whole point of the set. A new `--json`-only view that nobody adds here would otherwise
    // bring the "there is no X command" answer back for a name `--help` lists.
    expect(named).toEqual(jsonOnly);
  });

  it('say which route answers them, rather than that they do not exist', async () => {
    const { stdout, stderr } = await run(process.execPath, [cli, 'events'], {
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 30_000,
    }).catch((e: { stdout?: string; stderr?: string }) => ({
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }));
    const said = `${stdout}${stderr}`;

    expect(said, 'help lists it, so the CLI must not deny it exists').not.toMatch(
      /there is no "events" command/,
    );
    // Naming the route is the fix. A message that only says "not here" leaves the reader where
    // they started.
    expect(said).toContain('orca events --json');
  });

  it('leaves a genuine typo answering as a typo', async () => {
    const { stdout, stderr } = await run(process.execPath, [cli, 'evnets'], {
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 30_000,
    }).catch((e: { stdout?: string; stderr?: string }) => ({
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }));
    expect(`${stdout}${stderr}`).toMatch(/there is no "evnets" command/);
  });
});
