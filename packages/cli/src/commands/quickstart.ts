import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs, type ParsedArgs } from '../args.js';
import { Output } from '../out.js';
import { replayCommand } from './replay.js';
import { showCommand } from './inspect.js';

/**
 * The first two minutes, with nothing installed and nothing spent.
 *
 * Everything orca does well is visual — a timeline, a causal chain, a comparison — and none of it
 * can be seen until a run exists. Producing one costs an agent, a key, a network and real tokens,
 * so the shortest honest path from `npm i` to "oh, I see what this is" ran through four things a
 * person has to arrange first. Most of them do not.
 *
 * So the package carries a run. A real one: a small agent, a real model, a genuine bug in
 * timezone arithmetic that it genuinely fixes. `quickstart` puts the project and the recording
 * somewhere, then replays the recording against the project with the network off — which is the
 * product's own guarantee doing the work of its own demonstration.
 *
 * The agent it was recorded from is a Node script that ships with it, which is the reason replay
 * needs nothing installed: orca already requires the runtime that agent runs on.
 *
 * The default output fits on one screen, and that is the whole design of it. The first version
 * printed the full timeline and the replayed agent's own chatter — sixty-eight lines, with the
 * failing test count and the passing one fifty lines apart. The comparison is the point, and a
 * comparison you have to scroll between is not one. `--full` still prints everything.
 */

/** Where the shipped asset lives, relative to the built `dist/commands/`. */
const ASSET = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'quickstart');

const DEFAULT_DIR = 'orca-quickstart';
const exec = promisify(execFile);

export interface TraceEvent {
  type: string;
  attrs?: Record<string, unknown>;
  payload?: string;
}

async function events(): Promise<TraceEvent[]> {
  const jsonl = await readFile(join(ASSET, 'trace', 'events.jsonl'), 'utf8');
  return jsonl
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TraceEvent);
}

/** Read the run id out of the shipped trace, so nothing has to hardcode it. */
async function shippedRunId(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(ASSET, 'trace', 'manifest.json'), 'utf8')) as {
    run_id?: string;
  };
  const id = manifest.run_id;
  if (id === undefined) throw new Error('the shipped quickstart trace has no run_id');
  return id;
}

/**
 * Whether it is safe to write a project into this path.
 *
 * Only a missing path counts as free. Swallowing every error meant a path that exists and is not a
 * directory read as empty, so `orca quickstart --dir notes.txt` skipped the sentence that explains
 * the problem and surfaced `ENOTDIR: not a directory, mkdir` from three lines further on.
 */
async function isEmptyish(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Tell the trace where it now lives.
 *
 * The shipped manifest names a neutral directory, because a trace records the absolute path it was
 * captured in and publishing one on npm would publish that. But `replay` compares that path against
 * the directory it is running in, and on a mismatch it declines to restore the recorded filesystem
 * — correctly, since restoring a stranger's tree over yours is not a thing to do on a guess.
 *
 * Left alone, that lands on the first person who follows the tour. `orca quickstart` replays with
 * `--in-place` and is unaffected, but the obvious next thing to type is the command from the top of
 * the README, and `orca replay last` in the quickstart directory reported `exact=1` with two
 * divergences and a warning — the flagship guarantee failing on the second look, against a tree the
 * first replay had already changed.
 *
 * So the path is rewritten as the trace is placed. The asset on npm stays neutral, and the copy on
 * disk is honest about where it is. Safe to edit because the integrity digest covers
 * `events.jsonl`, and the replay matcher reads request bodies — neither reads this field.
 */
async function adoptTrace(runDir: string, target: string): Promise<void> {
  const path = join(runDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  manifest['cwd'] = target;
  await writeFile(
    path,
    `${JSON.stringify(manifest, null, 2)}
`,
    'utf8',
  );
}

/**
 * The project's own test suite, summarised.
 *
 * Run before and after, because the arc is the demo: two tests fail, a recording of an agent
 * fixing them is replayed with the network off, and the same two pass. Telling someone to go and
 * check afterwards does not work — by then the replay has already written the fix, so the
 * instruction to "see two failures" would show them four passes.
 */
async function testSummary(dir: string): Promise<{ line: string; failing: string[] }> {
  let tap = '';
  try {
    // The reporter is named, and the environment that could name a second one is taken away.
    //
    // The counts are read out of TAP, and node picks its reporter from the ambient default and
    // from `NODE_OPTIONS`. A developer with `--test-reporter=spec` set — an ordinary thing to have
    // — got `? passing, ? failing` for both halves of the before-and-after, from a command that
    // still reported success. Naming `tap` on the command line does not fix that on its own:
    // reporters accumulate, and two of them with one destination makes node refuse to start at
    // all. So the variable goes, which is right regardless — this is orca running a fixed test
    // file of its own to read two numbers out of it, not the user running their suite.
    ({ stdout: tap } = await exec(
      process.execPath,
      ['--test', '--test-reporter=tap', 'test/schedule.test.js'],
      { cwd: dir, env: withoutNodeOptions(process.env) },
    ));
  } catch (err) {
    tap = (err as { stdout?: string }).stdout ?? '';
  }
  const pass = /^# pass (\d+)/m.exec(tap)?.[1] ?? '?';
  const fail = /^# fail (\d+)/m.exec(tap)?.[1] ?? '?';
  const failing = tap
    .split('\n')
    .filter((l) => l.startsWith('not ok'))
    .map((l) => l.replace(/^not ok \d+ - /, ''));
  return { line: `${pass} passing, ${fail} failing`, failing };
}

/** A copy of the environment with `NODE_OPTIONS` removed. */
function withoutNodeOptions(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy['NODE_OPTIONS'];
  return copy;
}

/** What the recording did, in three lines rather than nineteen. */
export function recordingSummary(all: TraceEvent[]): string[] {
  const turns = all.filter((e) => e.type === 'model.response');
  const model = String(turns[0]?.attrs?.['model'] ?? 'a model').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const tokensIn = turns.reduce((n, e) => n + Number(e.attrs?.['input_tokens'] ?? 0), 0);
  const tokensOut = turns.reduce((n, e) => n + Number(e.attrs?.['output_tokens'] ?? 0), 0);

  const read = new Set<string>();
  for (const e of all) {
    if (e.type !== 'tool.call') continue;
    const input = e.attrs?.['input'] as { path?: string } | undefined;
    if (e.attrs?.['name'] === 'read_file' && input?.path) read.add(input.path);
  }
  // Straight off each event. Reading the path out and then looking the event back up gives two
  // changes to one file the *first* one's counts twice, which is a summary that quietly lies.
  const wrote = all
    .filter((e) => e.type === 'fs.change')
    .map((e) => {
      const a = e.attrs ?? {};
      return `${String(a['path'])} (+${a['insertions']} −${a['deletions']})`;
    });

  const lines = [
    `${all.length} events · ${turns.length} model turns · ${model} · ${tokensIn.toLocaleString()} in · ${tokensOut.toLocaleString()} out`,
  ];
  if (read.size > 0) lines.push(`read ${[...read].join(', ')}`);
  if (wrote.length > 0) lines.push(`wrote ${wrote.join(', ')}`);
  return lines;
}

/** Files the recording changed on disk. */
function writtenPaths(all: TraceEvent[]): string[] {
  return all
    .filter((e) => e.type === 'fs.change')
    .map((e) => String(e.attrs?.['path']))
    .filter((p) => p !== 'undefined');
}

/**
 * What the model said, from the recording rather than from the replayed process.
 *
 * Trimmed to its first sentences and labelled. Unlabelled, eleven lines of an assistant explaining
 * daylight saving read as orca talking — and the recorded reply ends with "If you want, I can also
 * explain the DST edge case in more detail", which in an offline replay invites the obvious
 * question of who it is addressed to.
 */
export function modelSaid(all: TraceEvent[], lines: number): string[] {
  const alreadySaid = writtenPaths(all);
  for (const e of [...all].reverse()) {
    if (e.type !== 'model.response' || !e.payload) continue;
    try {
      const body = JSON.parse(e.payload) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = body.choices?.[0]?.message?.content;
      if (!text) continue;
      const kept = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        // Two lines of excerpt is no place to repeat what the summary three lines above already
        // said. A section header on its own carries nothing, and "Fixed src/schedule.js." is the
        // `wrote src/schedule.js` line again — the excerpt is here for the why, not the what.
        .filter((l) => lines > 4 || (!l.endsWith(':') && !restatesTheSummary(l, alreadySaid)))
        .map((l) => (lines > 4 ? l : plain(l)));
      return kept.slice(0, lines);
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Whether a line only names a file the summary has already reported as written.
 *
 * Short and path-shaped: "Fixed `src/schedule.js`." carries nothing the `wrote` line above did not,
 * and length is what separates it from a sentence that happens to mention the same file while
 * saying something about it.
 */
function restatesTheSummary(line: string, written: string[]): boolean {
  const flat = plain(line);
  return flat.length < 60 && written.some((p) => flat.includes(p));
}

/**
 * The excerpt as it is printed: a label and its lines, or nothing at all.
 *
 * Nothing at all is a real outcome, not a defensive branch. The lines are filtered — section
 * headers dropped, restatements of the file the summary already reported dropped — so a reply made
 * entirely of those leaves the label standing over empty space, which reads as output that went
 * missing rather than as output that was never worth printing.
 */
export function excerptBlock(all: TraceEvent[], lines: number): string[] {
  const said = modelSaid(all, lines);
  if (said.length === 0) return [];
  return [
    '              the model, out of the recording:',
    ...said.map((l) => `                ${l}`),
  ];
}

/** Markdown emphasis and bullet syntax removed, clipped to something a terminal can hold. */
function plain(line: string): string {
  const flat = line
    .replace(/^[-*]\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1');
  return flat.length > 84 ? `${flat.slice(0, 83)}…` : flat;
}

/**
 * Whether the replay demonstrated the thing, rather than merely failing to fail.
 *
 * `turns > 0` is the clause that is easy to leave out and is the whole point. Without it an empty
 * recording makes `0 === 0` true, and the command congratulates itself on a run that never
 * happened — which is what it did, over a project whose tests were still red, until a directory
 * with a space in its name stopped the agent from starting at all.
 */
export function replayDemonstrated(turns: number, served: number, unmatched: number): boolean {
  return turns > 0 && served === turns && unmatched === 0;
}

export interface QuickstartResult {
  dir: string;
  runId: string;
  unmatched: number;
  /** Turns the recording was asked for, from the trace itself rather than from the replay. */
  turns: number;
  /** Turns the recording actually served. */
  served: number;
  ok: boolean;
}

export async function quickstartCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<QuickstartResult> {
  const target = resolve(cwd, args.str('dir') ?? DEFAULT_DIR);
  const full = args.bool('full');
  const runId = await shippedRunId();

  // Refusing rather than merging: this writes a source tree and a trace, and quietly mixing those
  // into a directory someone already has work in is the kind of help nobody asks for twice.
  if (!(await isEmptyish(target))) {
    throw new Error(
      `${target} already exists and is not an empty directory\n` +
        '  pick somewhere else: orca quickstart --dir <path>',
    );
  }

  await mkdir(join(target, '.orca', 'runs'), { recursive: true });
  await cp(join(ASSET, 'project'), target, { recursive: true });
  const runDir = join(target, '.orca', 'runs', runId);
  await cp(join(ASSET, 'trace'), runDir, { recursive: true });
  await adoptTrace(runDir, target);

  const all = await events();
  const before = await testSummary(target);

  out.info('quickstart.ready', { dir: target, run: runId });
  out.plain('');
  out.plain('  A reminder scheduler with a bug in it, and a recording of an agent fixing it.');
  out.plain('  Nothing here needs a key, a network, or an agent installed.');
  out.plain('');
  out.plain(`  Before      ${before.line}`);
  for (const f of before.failing) out.plain(`                  ✗ ${f}`);
  out.plain('');

  const summary = recordingSummary(all);
  out.plain(`  Recorded    ${summary[0]}`);
  for (const l of summary.slice(1)) out.plain(`              ${l}`);
  out.plain('');

  const replayed = await runReplay(target, runId, out, full);

  // The denominator is the recording's, not the replay's. `matchedExact + unmatched` is the number
  // of turns the replay was asked about, which is zero when the agent never started — and `0/0`
  // reads like a pass. Counting the model turns in the trace makes that case print `0/3`.
  const turns = all.filter((e) => e.type === 'model.response').length;
  const ok = replayDemonstrated(turns, replayed.matchedExact, replayed.unmatched);

  if (full) out.plain('');
  out.plain(
    `  Replayed    ${replayed.matchedExact}/${turns} turns from the trace · ` +
      `${replayed.divergences} divergences · ${replayed.liveCalls} live calls · network blocked`,
  );
  out.plain('');
  const excerpt = excerptBlock(all, full ? 40 : 2);
  if (excerpt.length > 0) {
    for (const line of excerpt) out.plain(line);
    out.plain('');
  }

  const after = await testSummary(target);
  out.plain(`  After       ${after.line}`);
  out.plain('');
  // Said rather than hidden, and reflected in the exit code: a quickstart that quietly reports a
  // success it did not have teaches the opposite of the guarantee it exists to demonstrate.
  if (ok) {
    out.plain('  Nothing above talked to a model. The fix came out of the recording.');
  } else if (replayed.matchedExact === 0) {
    out.plain(`  The replay served none of the ${turns} recorded turns — the agent did not run.`);
    out.plain('  Re-run with --full to see what it printed.');
  } else {
    out.plain(`  ${replayed.unmatched} turn(s) could not be served from the recording.`);
  }
  out.plain('');
  out.plain(`  cd ${target}`);
  out.plain('');
  // `orca` is on PATH only after a global install. Saying so here rather than letting someone
  // meet `command not found` as the next thing that happens to them.
  out.plain('  See it      orca ui                       # the timeline, in a browser');
  out.plain('  Dig in      orca show · orca graph · orca export -o run.html');
  out.plain('  Your own    orca record claude -- -p "..."');
  out.plain('');
  out.plain('  Installed locally rather than with -g? Put npx in front: npx orca ui');
  if (!full) out.plain('  --full for the whole timeline and the replay as it happened.');

  return {
    dir: target,
    runId,
    unmatched: replayed.unmatched,
    turns,
    served: replayed.matchedExact,
    ok,
  };
}

interface ReplayNumbers {
  matchedExact: number;
  unmatched: number;
  divergences: number;
  liveCalls: number;
}

/**
 * Replay the shipped run, printing everything or nothing.
 *
 * `--full` calls the command in process, so the timeline and the replayed agent's own output land
 * on the terminal exactly as they would from `orca replay`.
 *
 * The default passes `--json`, which is what `replay` already keys its quiet mode on: the agent is
 * spawned with inherited stdio, so under anything else its output reaches the terminal without
 * passing through something orca could filter. The result document goes to a discarded `Output`,
 * and this command prints the two numbers worth reading instead.
 *
 * Not a child process. Spawning `../cli.js` resolves from `dist` and not from source, which is a
 * split between how the tests run this and how a user does — and a path that only works in one of
 * those is the shape of bug this project keeps finding in other people's harnesses.
 */
async function runReplay(
  target: string,
  runId: string,
  out: Output,
  full: boolean,
): Promise<ReplayNumbers> {
  if (full) {
    out.plain('── the recording ──────────────────────────────────');
    out.plain('');
    await showCommand(parseArgs(['show', runId]), out, target);
    out.plain('');
    out.plain('── replaying it, offline ──────────────────────────');
    out.plain('');
    const result = await replayCommand(parseArgs(['replay', runId, '--in-place']), out, target);
    return {
      matchedExact: result.matchedExact,
      unmatched: result.unmatched,
      divergences: result.divergences,
      liveCalls: result.liveCalls,
    };
  }

  const quiet = new Output({ write: () => {}, color: false, ci: true });
  const result = await replayCommand(
    parseArgs(['replay', runId, '--in-place', '--json', '--quiet']),
    quiet,
    target,
  );
  return {
    matchedExact: result.matchedExact,
    unmatched: result.unmatched,
    divergences: result.divergences,
    liveCalls: result.liveCalls,
  };
}
