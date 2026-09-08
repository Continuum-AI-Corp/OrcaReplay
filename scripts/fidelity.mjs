#!/usr/bin/env node
/**
 * Replay fidelity scoreboard.
 *
 * "Replay is reliable" is the load-bearing claim of this project and it has been prose. Prose does
 * not regress visibly: a change to the matcher, a dialect, or the redactor can quietly turn an
 * exact replay into a lossy one, and nothing says so until someone is debugging at 2am with a
 * trace that no longer reproduces.
 *
 * So: replay a corpus of real recordings, assert the numbers, and write them down. A run is judged
 * on three counts the replay already reports —
 *
 *   unmatched   turns the recording could not serve at all. The budget for this is zero. A turn
 *               orca cannot answer from the trace is the failure the whole feature exists to
 *               prevent, and there is no honest way to spend a budget on it.
 *   exact       turns matched byte for byte. Below `minExact` is a regression even when nothing
 *               is unmatched, because a run that only matches loosely is a run whose fidelity is
 *               being carried by the match ladder rather than by the capture.
 *   divergences reported differences. Allowed a budget, because some are inherent: a harness that
 *               stamps a fresh session id into every request diverges by construction.
 *
 * Each entry names its own budget rather than sharing one. A corpus with a single global
 * threshold is a corpus where the worst entry sets the bar for all of them.
 *
 *   node scripts/fidelity.mjs           # check, and write docs/fidelity.md
 *   node scripts/fidelity.mjs --check   # check only; fail on regression, write nothing
 */
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'packages', 'cli', 'dist', 'cli.js');

/**
 * The corpus.
 *
 * One entry per harness whose capture this project claims to support. Each names a trace, the
 * project state that trace was recorded against, and what its replay is expected to achieve.
 * Adding a harness to the README's support table without adding it here is how "we support X"
 * goes back to being a sentence.
 */
const CORPUS = [
  {
    id: 'node-agent',
    harness: 'a Node agent over chat completions',
    trace: join(root, 'packages', 'cli', 'quickstart', 'trace'),
    project: join(root, 'packages', 'cli', 'quickstart', 'project'),
    note: 'the run `orca quickstart` ships and replays on every invocation',
    budget: { minExact: 3, maxDivergences: 0 },
  },
];

/** Replay one entry in a scratch copy and read the numbers back out of the JSON. */
async function replay(entry) {
  const dir = await mkdtemp(join(tmpdir(), 'orca-fidelity-'));
  try {
    const manifest = JSON.parse(await readFile(join(entry.trace, 'manifest.json'), 'utf8'));
    await cp(entry.project, dir, { recursive: true });
    await cp(entry.trace, join(dir, '.orca', 'runs', manifest.run_id), { recursive: true });

    // `--in-place` because the project is copied in at the state the run started from; restoring
    // would mean writing over a directory the recording never saw.
    // A halted replay exits non-zero and still prints its numbers, which are exactly the numbers
    // worth reporting — "it did not complete" hides whether one turn was unmatched or twenty.
    let stdout;
    try {
      ({ stdout } = await exec(
        process.execPath,
        [cli, 'replay', manifest.run_id, '--in-place', '--json'],
        { cwd: dir, env: { ...process.env, NO_COLOR: '1' } },
      ));
    } catch (err) {
      stdout = (err && typeof err === 'object' && 'stdout' in err ? err.stdout : '') || '';
      if (!stdout.trim()) throw err;
    }
    return { runId: manifest.run_id, ...JSON.parse(stdout) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const rows = [];
let failures = 0;

for (const entry of CORPUS) {
  process.stdout.write(`── ${entry.id}: `);
  let result;
  try {
    result = await replay(entry);
  } catch (err) {
    failures += 1;
    console.log('replay did not complete');
    console.error(`     ${String(err).split('\n')[0]}`);
    rows.push({ entry, broken: true });
    continue;
  }

  // Field names come from `replay --json`, read off a real run rather than assumed.
  const { unmatched = 0, matchedExact: exact = 0, divergences = 0, liveCalls = 0 } = result;
  const problems = [];
  if (unmatched > 0) problems.push(`${unmatched} unmatched (budget 0)`);
  if (exact < entry.budget.minExact) {
    problems.push(`${exact} exact, expected at least ${entry.budget.minExact}`);
  }
  if (divergences > entry.budget.maxDivergences) {
    problems.push(`${divergences} divergences, budget ${entry.budget.maxDivergences}`);
  }

  // A replay that went live answered a turn from a model, which is the one thing an offline
  // guarantee cannot survive quietly.
  if (liveCalls > 0) problems.push(`${liveCalls} live call(s) — the replay left the machine`);

  if (problems.length > 0) {
    failures += 1;
    console.log('regressed');
    for (const p of problems) console.error(`     ${p}`);
  } else {
    console.log(`exact ${exact}, unmatched ${unmatched}, divergences ${divergences}`);
  }
  rows.push({ entry, unmatched, exact, divergences, liveCalls, problems });
}

if (!process.argv.includes('--check')) {
  const lines = [
    '# Replay fidelity',
    '',
    '<!-- Generated by scripts/fidelity.mjs. Do not edit by hand. -->',
    '',
    'Every recording below is replayed with the network off and the numbers asserted. A turn the',
    'recording cannot serve — `unmatched` — has a budget of zero, because a replay that has to go',
    'and ask a model is not a replay. `exact` counts the turns matched byte for byte; a floor is',
    'set per entry so fidelity carried by the match ladder rather than by the capture shows up as',
    'a regression rather than as a pass.',
    '',
    '| Harness | Exact | Unmatched | Divergences | Live calls | Budget |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    if (r.broken) {
      lines.push(`| ${r.entry.harness} | — | — | — | — | replay did not complete |`);
      continue;
    }
    lines.push(
      `| ${r.entry.harness} | ${r.exact} | ${r.unmatched} | ${r.divergences} | ${r.liveCalls} | ` +
        `exact ≥ ${r.entry.budget.minExact}, divergences ≤ ${r.entry.budget.maxDivergences} |`,
    );
  }
  lines.push('');
  for (const r of rows) lines.push(`- **${r.entry.harness}** — ${r.entry.note}`);
  lines.push('');
  await writeFile(join(root, 'docs', 'fidelity.md'), `${lines.join('\n')}\n`, 'utf8');
  console.log('\ndocs/fidelity.md written');
}

console.log(`\n${CORPUS.length} recording(s) replayed, ${failures} regression(s)`);
process.exit(failures === 0 ? 0 : 1);
