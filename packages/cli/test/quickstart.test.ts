import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  excerptBlock,
  modelSaid,
  recordingSummary,
  quickstartCommand,
  replayDemonstrated,
  type TraceEvent,
} from '../src/commands/quickstart.js';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ASSET = join(here, '..', 'quickstart');
const RUN = (
  JSON.parse(readFileSync(join(ASSET, 'trace', 'manifest.json'), 'utf8')) as { run_id: string }
).run_id;

/** Captures what the command printed, so the assertions read the operator's view. */
function capture(): { out: Output; lines: () => string } {
  let text = '';
  const out = new Output({ write: (s) => void (text += s), color: false, ci: true });
  return { out, lines: () => text };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-qs-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * The asset is the whole feature: a project in the state the run started from, and a recording of
 * an agent changing it. If the two disagree by a byte the replay stops being exact, and a
 * quickstart that diverges teaches the opposite of the thing it exists to show.
 *
 * This caught it once already. The project was assembled by copying the directory the recording
 * had just run in, so it shipped the agent's *output* as the starting state, and replay dropped
 * from `exact=3` to `exact=1` with "only tool output differs".
 */
describe('the shipped quickstart asset', () => {
  const recordedToolResults = async (): Promise<string[]> => {
    const jsonl = await readFile(join(ASSET, 'trace', 'events.jsonl'), 'utf8');
    return jsonl
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { type: string; payload?: string })
      .filter((e) => e.type === 'tool.result' && typeof e.payload === 'string')
      .map((e) => e.payload!);
  };

  it('ships the project in the state the recording started from', async () => {
    const results = await recordedToolResults();
    for (const file of ['src/schedule.js', 'test/schedule.test.js']) {
      const onDisk = await readFile(join(ASSET, 'project', file), 'utf8');
      expect(results, `${file} is not among the recorded tool results`).toContain(onDisk);
    }
  });

  it('ships a project whose tests fail, because a demo needs something to fix', async () => {
    await expect(
      run(process.execPath, ['--test', 'test/schedule.test.js'], { cwd: join(ASSET, 'project') }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('names its own run id rather than hardcoding one', async () => {
    const manifest = JSON.parse(await readFile(join(ASSET, 'trace', 'manifest.json'), 'utf8')) as {
      run_id: string;
      env_allowlisted: Record<string, string>;
      cwd: string;
    };
    expect(manifest.run_id).toMatch(/^run_[0-9a-f]{6,32}$/);
  });

  /**
   * A trace names the machine it was recorded on: `cwd`, and `HOME`, `PATH` and `SHELL` in
   * `env_allowlisted`. Shipping one in a public package publishes that. The asset is recorded in a
   * neutral directory and its manifest is neutralised — which is safe to do because the integrity
   * digest covers `events.jsonl` and the replay matcher reads request bodies, so neither notices.
   */
  it('carries no trace of the machine it was recorded on', async () => {
    const manifest = await readFile(join(ASSET, 'trace', 'manifest.json'), 'utf8');
    const events = await readFile(join(ASSET, 'trace', 'events.jsonl'), 'utf8');
    for (const smell of ['Users\\', '/Users/', '/home/', 'AppData', 'Documents and Settings']) {
      expect(events, `events.jsonl mentions ${smell}`).not.toContain(smell);
    }
    const parsed = JSON.parse(manifest) as { env_allowlisted: Record<string, string> };
    expect(parsed.env_allowlisted.HOME).toBe('/home/you');
    expect(parsed.env_allowlisted.PATH).not.toContain('Users');
  });
});

describe('orca quickstart', () => {
  it('materialises the project and the run, then replays it offline', async () => {
    const { out, lines } = capture();
    const result = await quickstartCommand(parseArgs(['quickstart']), out, dir);

    expect(result.dir).toBe(join(dir, 'orca-quickstart'));
    // The trace is where every other command looks for it.
    await expect(
      readFile(join(result.dir, '.orca', 'runs', result.runId, 'manifest.json'), 'utf8'),
    ).resolves.toContain(result.runId);
    // And the project is there to be replayed against.
    await expect(readFile(join(result.dir, 'src', 'schedule.js'), 'utf8')).resolves.toContain(
      'nextOccurrence',
    );

    const printed = lines();
    expect(printed).toContain('quickstart.ready');
    // The whole point: served from the recording, nothing spent. Asserted on the result rather
    // than on the wording, and on the wording only where the wording is the promise.
    expect(result.unmatched).toBe(0);
    expect(printed).toMatch(/3\/3 turns from the trace/);
    expect(printed).toContain('0 live calls');
    expect(printed).toContain('Nothing above talked to a model');
  });

  /**
   * The default has to fit on one screen. It did not: the first version printed the whole
   * timeline and the replayed agent's own output, and the failing test count and the passing one
   * ended up fifty lines apart — a before-and-after that has to be scrolled between is neither.
   */
  it('fits on a screen by default, and prints everything under --full', async () => {
    const short = capture();
    await quickstartCommand(parseArgs(['quickstart', '--dir', 'a']), short.out, dir);
    const full = capture();
    await quickstartCommand(parseArgs(['quickstart', '--dir', 'b', '--full']), full.out, dir);

    const count = (s: string): number => s.split('\n').length;
    expect(count(short.lines())).toBeLessThan(40);
    expect(count(full.lines())).toBeGreaterThan(count(short.lines()));
    // The full one carries the timeline the short one summarises.
    expect(full.lines()).toContain('SEQ');
    expect(short.lines()).not.toContain('SEQ');
  });

  /**
   * `orca` is on PATH only after a global install, and `npm i orcareplay` without `-g` is a
   * normal thing to do — it is what happened the first time this was tried by hand.
   */
  it('says how to run the follow-up commands after a local install', async () => {
    const { out, lines } = capture();
    await quickstartCommand(parseArgs(['quickstart']), out, dir);
    expect(lines()).toContain('npx orca ui');
  });

  /**
   * The arc is the demo, and it is printed rather than promised. Running the suite before and
   * after is not decoration: an earlier version told the reader to go and check afterwards, by
   * which point the replay had already written the fix, so the instruction to see two failures
   * would have shown them four passes.
   */
  it('shows the tests failing, then the same tests passing after the replay', async () => {
    const { out, lines } = capture();
    await quickstartCommand(parseArgs(['quickstart']), out, dir);

    const printed = lines();
    const before = printed.indexOf('2 passing, 2 failing');
    const after = printed.indexOf('4 passing, 0 failing');
    expect(before, 'the failing summary was not printed').toBeGreaterThan(-1);
    expect(after, 'the passing summary was not printed').toBeGreaterThan(-1);
    expect(after, 'the passing summary came before the failing one').toBeGreaterThan(before);
    // Named, so the reader knows which two and why they are interesting.
    expect(printed).toContain('spring transition');
    expect(printed).toContain('autumn transition');
  });

  /**
   * Two lines of excerpt, and neither of them spent twice. The recorded reply opens with "Fixed
   * `src/schedule.js`.", which is the `wrote src/schedule.js` line from three lines above wearing
   * a different hat — the excerpt is there to say why, and half of it going on the what is half
   * of it wasted.
   */
  it('does not spend the excerpt repeating what it already said was written', async () => {
    const { out, lines } = capture();
    await quickstartCommand(parseArgs(['quickstart']), out, dir);

    const printed = lines();
    const excerpt = printed.slice(printed.indexOf('out of the recording:')).split('\n').slice(1, 3);
    expect(excerpt.join('\n')).not.toMatch(/Fixed src\/schedule\.js\.\s*$/m);
    // It says what the change actually was instead.
    expect(printed).toContain('wall-clock time');
    // And under --full the reply is reproduced as recorded, opening line included.
    const full = capture();
    await quickstartCommand(parseArgs(['quickstart', '--dir', 'f', '--full']), full.out, dir);
    expect(full.lines()).toContain('Fixed `src/schedule.js`');
  });

  /**
   * The denominator comes from the recording, not from the replay's own arithmetic.
   *
   * It used to print `matchedExact / (matchedExact + unmatched)`, which is `0/0` when the agent
   * never started — and `0/0 turns from the trace · 0 divergences · 0 live calls` reads like a
   * pass. It was a pass, too: the verdict keyed on `unmatched === 0`, which is trivially true when
   * nothing was attempted, so the command printed "the fix came out of the recording" over a
   * project whose tests were still failing, and exited 0.
   *
   * Found by running the command in `C:\My Projects (2026)\`.
   */
  it('counts the turns the recording has, not the turns the replay attempted', async () => {
    const { out, lines } = capture();
    const result = await quickstartCommand(parseArgs(['quickstart']), out, dir);

    const events = await readFile(join(ASSET, 'trace', 'events.jsonl'), 'utf8');
    const recorded = events
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { type: string })
      .filter((e) => e.type === 'model.response').length;

    expect(result.turns).toBe(recorded);
    expect(result.served).toBe(recorded);
    expect(result.ok).toBe(true);
    expect(lines()).toContain(`${recorded}/${recorded} turns from the trace`);
  });

  /**
   * The trace has to know where it was put, or the tour breaks one command in.
   *
   * The shipped manifest names a neutral directory so publishing it publishes nobody's path. But
   * `replay` compares that against where it is running and declines to restore on a mismatch, so
   * `orca replay last` — the command at the top of the README, and the obvious next thing to type
   * — reported `exact=1` with two divergences and a warning, against a tree the quickstart's own
   * replay had already changed. Rewriting the path as the trace lands fixes both halves.
   */
  it('rewrites the trace to name the directory it was put in', async () => {
    const result = await quickstartCommand(parseArgs(['quickstart']), capture().out, dir);
    const manifest = JSON.parse(
      await readFile(join(result.dir, '.orca', 'runs', result.runId, 'manifest.json'), 'utf8'),
    ) as { cwd: string };
    expect(manifest.cwd).toBe(result.dir);
  });

  /** And the copy that ships names nobody's machine, which is why the rewrite has to happen here. */
  it('leaves the shipped asset naming a neutral directory', async () => {
    const shipped = JSON.parse(await readFile(join(ASSET, 'trace', 'manifest.json'), 'utf8')) as {
      cwd: string;
    };
    expect(shipped.cwd).not.toContain('Users');
    expect(shipped.cwd).toBe(String.raw`C:\qs`);
  });

  it('takes a directory, so it does not have to own the name', async () => {
    const { out } = capture();
    const result = await quickstartCommand(
      parseArgs(['quickstart', '--dir', 'elsewhere']),
      out,
      dir,
    );
    expect(result.dir).toBe(join(dir, 'elsewhere'));
  });

  /**
   * It writes a source tree and a trace. Merging those into somewhere with work in it is the kind
   * of help nobody asks for twice.
   */
  it('refuses a directory that is not empty rather than mixing into it', async () => {
    await writeFile(join(dir, 'mine.txt'), 'work in progress');
    const { out } = capture();
    await expect(
      quickstartCommand(parseArgs(['quickstart', '--dir', '.']), out, dir),
    ).rejects.toThrow(/already exists and is not an empty directory/);
  });

  /**
   * And refuses a path that is not a directory at all with the same sentence. Treating every
   * `readdir` failure as "nothing there" meant this one skipped the explanation and surfaced as
   * `ENOTDIR: not a directory, mkdir` from the line after it.
   */
  it('refuses a path that exists and is not a directory', async () => {
    await writeFile(join(dir, 'notes.txt'), 'not a directory');
    const { out } = capture();
    await expect(
      quickstartCommand(parseArgs(['quickstart', '--dir', 'notes.txt']), out, dir),
    ).rejects.toThrow(/already exists and is not an empty directory/);
  });
});

/**
 * The scoreboard is only worth having if it fails. Its corpus points at the quickstart asset, so
 * a change to that asset, to the matcher, or to a dialect shows up as a number rather than as a
 * surprise months later — and `docs/fidelity.md` is generated from the same run, so the published
 * figure and the asserted one cannot drift.
 */
describe('the fidelity scoreboard', () => {
  const scripts = join(here, '..', '..', '..', 'scripts');

  it('passes on the corpus as it stands', async () => {
    await expect(
      run(process.execPath, [join(scripts, 'fidelity.mjs'), '--check']),
    ).resolves.toBeDefined();
  });

  it('publishes the same numbers it asserts', async () => {
    const doc = await readFile(join(scripts, '..', 'docs', 'fidelity.md'), 'utf8');
    expect(doc).toContain('Generated by scripts/fidelity.mjs');
    // The zero that matters. A published table saying anything else about unmatched turns would
    // be advertising the failure the feature exists to prevent.
    expect(doc).toMatch(/\| a Node agent over chat completions \| \d+ \| 0 \|/);
  });
});

/**
 * What reaches the terminal, not what reaches `out`.
 *
 * The one-screen claim was measured against the `Output` object and was wrong by twelve lines: the
 * replayed agent is a child process, and under `--json` its stdout was piped to *stderr* rather
 * than discarded, so it landed on the terminal without passing through anything the tests watched.
 * Running the built CLI and counting both streams is the only measurement that answers the
 * question a person actually has, which is how much scrolls past.
 */
describe('what the terminal sees', () => {
  const cliPath = join(here, '..', 'dist', 'cli.js');
  const bare = { ...process.env, NO_COLOR: '1', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' };

  it('prints nothing on stderr, and fits on a screen, counting both streams', async () => {
    const { stdout, stderr } = await run(process.execPath, [cliPath, 'quickstart'], {
      cwd: dir,
      env: bare,
    });
    expect(stderr, 'the replayed agent leaked onto the terminal').toBe('');
    expect(stdout.split('\n').length).toBeLessThan(40);
    // And it is the summary, not the timeline.
    expect(stdout).not.toContain('SEQ  KIND');
  });

  /**
   * A directory with a space in its name, through the real CLI.
   *
   * This is the whole chain and it was broken: the fetch hook reaches the agent through
   * `NODE_OPTIONS`, a path with a space has to be quoted to survive being split on whitespace, and
   * the quoting is where node's parser starts eating backslashes. So
   * `C:\\My Projects\\orca-quickstart\\.orca\\...\\hook.cjs` arrived as
   * `C:MyProjectsorca-quickstart.orca...hook.cjs`, the preload was not found, the agent died before
   * it ran, and the replay served nothing — on Windows, where `My Documents`, `Google Drive` and
   * anything under `Program Files` all have one.
   *
   * Asserted end to end rather than on the option string alone, because the option string looked
   * right the whole time.
   */
  it('works in a directory whose name has a space in it', async () => {
    const spaced = join(dir, 'My Projects (2026)');
    await mkdir(spaced, { recursive: true });
    const { stdout, stderr } = await run(process.execPath, [cliPath, 'quickstart'], {
      cwd: spaced,
      env: bare,
    });
    expect(stderr).toBe('');
    expect(stdout).toContain('3/3 turns from the trace');
    expect(stdout).toContain('4 passing, 0 failing');
    expect(stdout).toContain('Nothing above talked to a model');
  });

  /**
   * And when the replay really does serve nothing, the command says so and exits non-zero rather
   * than printing a screen of green over a project it did not fix.
   */
  it('fails loudly when the recording serves nothing', async () => {
    const broken = join(dir, 'broken');
    await mkdir(broken, { recursive: true });
    // The agent the recording was made from, made unrunnable. Nothing else about the run changes.
    await run(process.execPath, [cliPath, 'quickstart'], { cwd: broken, env: bare });
    const project = join(broken, 'orca-quickstart');
    await rm(join(project, 'agent.mjs'));
    await rm(join(project, '.orca'), { recursive: true });
    await cp(join(ASSET, 'trace'), join(project, '.orca', 'runs', RUN), { recursive: true });

    await expect(
      run(process.execPath, [cliPath, 'replay', RUN, '--in-place', '--quiet'], { cwd: project }),
    ).rejects.toBeDefined();
  });

  /**
   * The before-and-after has to survive the reader's own environment.
   *
   * The counts come out of the test runner's TAP output, and node picks its reporter from the
   * ambient default and from `NODE_OPTIONS`. A developer with `--test-reporter=spec` set — an
   * ordinary thing to have — saw `? passing, ? failing` on both halves of the arc, from a command
   * that still exited 0 and still said the fix came out of the recording. Naming `tap` on the
   * command line is not enough on its own: reporters accumulate, and two with one destination make
   * node refuse to start.
   */
  it('reads the same counts however the reader has configured node', async () => {
    for (const opts of ['--test-reporter=spec', '--max-old-space-size=4096']) {
      const { stdout } = await run(
        process.execPath,
        [cliPath, 'quickstart', '--dir', opts.slice(2, 12)],
        {
          cwd: dir,
          env: { ...bare, NODE_OPTIONS: opts },
        },
      );
      expect(stdout, `with NODE_OPTIONS=${opts}`).toContain('2 passing, 2 failing');
      expect(stdout, `with NODE_OPTIONS=${opts}`).toContain('4 passing, 0 failing');
      expect(stdout, `with NODE_OPTIONS=${opts}`).not.toContain('? passing');
    }
  });

  it('shows the run as it happened under --full', async () => {
    const { stdout } = await run(process.execPath, [cliPath, 'quickstart', '--full'], {
      cwd: dir,
      env: bare,
    });
    expect(stdout).toContain('SEQ  KIND');
    expect(stdout).toContain('Fixed `src/schedule.js`');
  });
});

/**
 * The two rules that decide what the command claims, at the edges the shipped asset cannot reach.
 */
describe('the rules behind the verdict', () => {
  describe('replayDemonstrated', () => {
    it('holds when every recorded turn was served', () => {
      expect(replayDemonstrated(3, 3, 0)).toBe(true);
    });

    /**
     * The case that shipped. `unmatched === 0` alone is trivially true when nothing was attempted,
     * so a run where the agent never started printed a screen of green and exited 0.
     */
    it('does not hold when nothing was served', () => {
      expect(replayDemonstrated(3, 0, 0)).toBe(false);
    });

    /** And an empty recording demonstrates nothing, however cleanly it does so. */
    it('does not hold for a recording with no turns in it', () => {
      expect(replayDemonstrated(0, 0, 0)).toBe(false);
    });

    it('does not hold when a turn had to be answered elsewhere', () => {
      expect(replayDemonstrated(3, 2, 1)).toBe(false);
    });
  });

  describe('excerptBlock', () => {
    const reply = (text: string): TraceEvent[] => [
      {
        type: 'model.response',
        payload: JSON.stringify({ choices: [{ message: { content: text } }] }),
      },
    ];

    it('labels the excerpt when there is one', () => {
      const block = excerptBlock(reply('It adds days in wall-clock time.'), 2);
      expect(block[0]).toContain('the model, out of the recording:');
      expect(block[1]).toContain('It adds days in wall-clock time.');
    });

    it('prints no label when the filters leave nothing to label', () => {
      expect(excerptBlock(reply('What I changed:'), 2)).toEqual([]);
    });
  });

  describe('modelSaid', () => {
    const reply = (text: string): TraceEvent[] => [
      {
        type: 'model.response',
        payload: JSON.stringify({ choices: [{ message: { content: text } }] }),
      },
    ];

    it('strips markdown and clips to something a terminal holds', () => {
      const said = modelSaid(reply('- **Fixed** the `thing` properly'), 2);
      expect(said).toEqual(['Fixed the thing properly']);
    });

    /**
     * The filters can empty it: a reply that is nothing but a header, or nothing but a restatement
     * of the file the summary already reported. The caller prints a label above this, and a label
     * standing over nothing reads as output that went missing.
     */
    it('returns nothing rather than a header when a header is all there is', () => {
      expect(modelSaid(reply('What I changed:'), 2)).toEqual([]);
    });

    it('has no reply to excerpt when the recording holds no response', () => {
      expect(modelSaid([{ type: 'tool.call' }], 2)).toEqual([]);
    });
  });
});

/**
 * The summary line is the only place the reader is told what the recording did to the tree, so it
 * has to say it once per change rather than once per path.
 */
describe('recordingSummary', () => {
  const change = (path: string, ins: number, del: number): TraceEvent => ({
    type: 'fs.change',
    attrs: { path, insertions: ins, deletions: del },
  });

  it('reports each change with its own counts, including a file touched twice', () => {
    const summary = recordingSummary([change('a.js', 5, 2), change('a.js', 1, 9)]).join(' ');
    expect(summary).toContain('a.js (+5 −2)');
    expect(summary).toContain('a.js (+1 −9)');
  });
});
