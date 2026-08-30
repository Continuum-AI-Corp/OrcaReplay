import { resolve } from 'node:path';
import {
  TraceReader,
  deriveCheckpoints,
  listRuns,
  resolveRunSelector,
  type Checkpoint,
  type RunRef,
} from '@orcareplay/core';
import type { TraceEvent } from '@orcareplay/schema';
import { buildTimeline, detectLoops, exportTraceHtml, summarize } from '@orcareplay/viewer';
import { parseArgs } from './args.js';
import { Output, type LogEntry } from './out.js';
import { recordCommand, type RecordResult } from './commands/record.js';
import { replayCommand, type ReplayResult } from './commands/replay.js';
import { compareCommand, type CompareRow } from './commands/compare.js';

/**
 * Driving orca from code.
 *
 * Everything orca knew was reachable only by running a command and reading a terminal: `orca show`
 * computed a timeline and formatted it away, `orca list` returned `void`. Anyone who wanted to ask
 * "what diverged when I replayed that run?" — a script, a CI job, an agent debugging its own
 * failure — had to parse `info replay.done reused=2/2 exact=2 divergences=0` out of stdout.
 *
 * This returns the same work as data. The commands render what it returns, so the terminal is a
 * view of one source of truth rather than the only place the truth exists. Two rules follow from
 * that and are asserted in the tests:
 *
 *   - Nothing here writes to the embedding process's stdout. A library that prints over its
 *     caller's output cannot be built on, and it breaks every JSON consumer downstream.
 *   - Nothing here calls `process.exit`. Failures throw errors that name the run.
 */

export interface OrcaOptions {
  /** Project whose `.orca/runs` is being read. Defaults to the current directory. */
  cwd?: string;
  /** Receives orca's own log lines as structured records, for a caller that wants progress. */
  onLog?: (entry: LogEntry) => void;
}

/** One row of `orca show`, as data rather than a formatted line. */
export interface TimelineRow {
  seq: number;
  turn?: number;
  kind: string;
  label: string;
  detail?: string;
  meta?: string;
}

export interface Timeline {
  runId: string;
  adapter: string;
  eventCount: number;
  /** `null` where the run has no exit code — a trace cut short, not an exit of zero. */
  exitCode: number | null;
  /** Present when this run came from another — a fork, or an exact replay's own trace. */
  parentRun?: string;
  forkPoint?: number;
  forkModel?: string;
  usage: { input: number; output: number };
  events: TimelineRow[];
  /** Turns whose filesystem tree repeated — an agent going in circles. */
  loops: { turns: number[]; tree: string }[];
}

export interface RecordOptions {
  /** Adapter id or alias, e.g. `claude`, `codex`, `node`, `generic-openai`. */
  adapter: string;
  /** The command to launch, for adapters that take one. */
  command?: string[];
  /** Origin overrides by dialect id, as `--upstream-anthropic` / `--upstream-openai` would set. */
  upstream?: Record<string, string>;
  /** Extra flags, passed through verbatim — the escape hatch for anything not modelled here. */
  flags?: string[];
}

export interface RecordOutcome extends RecordResult {
  /** Everything orca warned about during the run, so a caller with no terminal still sees it. */
  warnings: LogEntry[];
}

export interface ReplayOptions {
  /** Checkpoint to fork from. Omit for an exact replay. */
  from?: number;
  /** Model to run from the fork point onward. */
  model?: string;
  /** Run in a scratch worktree instead of over the working tree. */
  worktree?: boolean;
  flags?: string[];
}

export interface CompareOptions {
  from?: number;
  models: string[];
  /** Command whose exit code is the verdict. */
  verify?: string;
  flags?: string[];
}

export class Orca {
  readonly cwd: string;
  readonly #onLog: ((entry: LogEntry) => void) | undefined;

  constructor(options: OrcaOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.#onLog = options.onLog;
  }

  // -------------------------------------------------------------------------
  // reading
  // -------------------------------------------------------------------------

  /** Every run in this project, newest first. Empty rather than an error when there are none. */
  async list(): Promise<RunRef[]> {
    return listRuns(this.cwd);
  }

  /** The raw event stream. A rendered row is a view; this is the thing itself. */
  async events(selector = 'last'): Promise<TraceEvent[]> {
    return (await this.#reader(selector)).events();
  }

  /** What `orca show` prints, as objects. */
  async show(selector = 'last'): Promise<Timeline> {
    const reader = await this.#reader(selector);
    const manifest = reader.manifest();
    const events = await reader.events();
    const summary = summarize(manifest, events);
    return {
      runId: summary.runId,
      adapter: summary.adapter,
      eventCount: summary.eventCount,
      exitCode: summary.exitCode,
      parentRun: manifest.parent_run,
      forkPoint: manifest.fork_point,
      forkModel: manifest.fork_model,
      usage: { input: summary.totalUsage.input, output: summary.totalUsage.output },
      events: buildTimeline(events).map((row) => ({
        seq: row.seq,
        turn: row.turn,
        kind: row.kind,
        label: row.label,
        detail: row.detail,
        meta: row.meta,
      })),
      loops: detectLoops(events).map((loop) => ({ turns: loop.turns, tree: loop.tree })),
    };
  }

  /** Where a fork can start: points whose conversation prefix is complete and tree was snapshotted. */
  async checkpoints(selector = 'last'): Promise<Checkpoint[]> {
    return deriveCheckpoints(await this.events(selector));
  }

  /** The absolute path of a run's directory, for a caller that wants to read it directly. */
  async runDir(selector = 'last'): Promise<string> {
    return (await resolveRunSelector(this.cwd, selector)).dir;
  }

  // -------------------------------------------------------------------------
  // doing
  // -------------------------------------------------------------------------

  async record(options: RecordOptions): Promise<RecordOutcome> {
    const argv = ['record', options.adapter];
    for (const [dialect, origin] of Object.entries(options.upstream ?? {})) {
      // Flags are named for the provider, not the dialect: `openai-responses` shares
      // `--upstream-openai` with chat completions, because it is one origin serving both.
      argv.push(`--upstream-${dialect.replace(/-responses$/, '')}`, origin);
    }
    argv.push(...(options.flags ?? []));
    if (options.command && options.command.length > 0) argv.push('--', ...options.command);

    const { out, entries } = this.#collect();
    const result = await recordCommand(parseArgs(argv), out, this.cwd);
    return {
      ...result,
      warnings: entries.filter((e) => e.level === 'warn' || e.level === 'error'),
    };
  }

  async replay(selector = 'last', options: ReplayOptions = {}): Promise<ReplayResult> {
    const argv = ['replay', selector];
    if (options.from !== undefined) argv.push('--from', String(options.from));
    if (options.model !== undefined) argv.push('--model', options.model);
    if (options.worktree === true) argv.push('--worktree');
    argv.push(...(options.flags ?? []));
    return replayCommand(parseArgs(argv), this.#collect().out, this.cwd);
  }

  async compare(selector = 'last', options: CompareOptions): Promise<CompareRow[]> {
    const argv = ['compare', selector, '--models', options.models.join(',')];
    if (options.from !== undefined) argv.push('--from', String(options.from));
    if (options.verify !== undefined) argv.push('--verify', options.verify);
    argv.push(...(options.flags ?? []));
    return compareCommand(parseArgs(argv), this.#collect().out, this.cwd);
  }

  /** Write the run as one self-contained HTML file. */
  async export(
    selector = 'last',
    options: { out: string },
  ): Promise<{ path: string; bytes: number }> {
    return exportTraceHtml(await this.runDir(selector), resolve(this.cwd, options.out));
  }

  // -------------------------------------------------------------------------

  async #reader(selector: string): Promise<TraceReader> {
    return TraceReader.open((await resolveRunSelector(this.cwd, selector)).dir);
  }

  /**
   * An `Output` that goes nowhere near a terminal.
   *
   * The commands were written to print, and rewriting all of them to return data instead would be
   * a much larger change than the one that is actually needed — so the API gives them a sink that
   * keeps the facts and drops the formatting.
   */
  #collect(): { out: Output; entries: LogEntry[] } {
    const entries: LogEntry[] = [];
    const onLog = this.#onLog;
    const out = new Output({
      write: () => {},
      sink: (entry) => {
        entries.push(entry);
        onLog?.(entry);
      },
    });
    return { out, entries };
  }
}
