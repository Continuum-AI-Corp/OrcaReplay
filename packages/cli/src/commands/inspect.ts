import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  TraceReader,
  chainTo,
  deriveCheckpoints,
  listRuns,
  pickChainTarget,
  resolveRunSelector,
  runGraph,
} from '@orcareplay/core';
import type { RunGraph } from '@orcareplay/core';
import {
  buildTimeline,
  detectLoops,
  exportTraceHtml,
  serveViewer,
  summarize,
} from '@orcareplay/viewer';
import { priceFor } from '@orcareplay/providers';
import type { Output } from '../out.js';
import type { ParsedArgs } from '../args.js';
import { formatCost } from './compare.js';
import { renderChainCard, renderGraphCard, scopeForCard } from '../share-card.js';
import { cardTarget, gifFrames, svgToPng, svgsToGif, type CardFormat } from '../rasterize.js';

/** `orca list` — what runs are here, newest first. */
export async function listCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<void> {
  const runs = await listRuns(cwd);
  if (runs.length === 0) {
    out.plain('no runs recorded yet');
    out.plain('');
    out.plain('  orca record claude      # record one');
    return;
  }
  // FROM is what makes a directory full of `orca compare` output readable: four runs with no
  // stated relationship are four mysteries, and the relationship is already in every manifest.
  out.table(
    ['RUN', 'CREATED', 'FROM', 'DIR'],
    runs.map((r) => [
      r.runId,
      r.createdAt,
      // `@<seq>` only where there is a fork point. A replay trace has a parent and no checkpoint,
      // and `run_x@?` reads as missing data rather than as the different thing it is.
      r.parentRun === undefined
        ? ''
        : r.forkPoint === undefined
          ? r.parentRun
          : `${r.parentRun}@${r.forkPoint}`,
      r.dir,
    ]),
  );
}

/** `orca show` — the timeline, in the terminal. */
export async function showCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<void> {
  const reader = await TraceReader.open(
    (await resolveRunSelector(cwd, args.positionals[0] ?? 'last')).dir,
  );
  const manifest = reader.manifest();
  const events = await reader.events();
  const summary = summarize(manifest, events);

  out.plain(
    // `?? 0` said a run that never reached an exit had exited cleanly — and a run that died before
    // its agent started is sealed with the code deliberately absent, precisely because it is
    // unknown rather than zero. `--json` reported it honestly as null the whole time; only the
    // line a person reads claimed success.
    `${summary.runId}  ${summary.adapter}  ${summary.eventCount} events  exit ${summary.exitCode ?? '— (never finished)'}`,
  );
  // A forked run's timeline opens mid-conversation in a worktree that no longer exists. Without
  // this line the only way to learn where it came from is to cat the manifest — for the feature
  // the tool is named after.
  if (manifest.parent_run !== undefined) {
    // `parent_run` no longer implies a fork. An exact replay writes its own run with a parent and
    // deliberately no `fork_point`, so keying the wording on that field is what tells the two
    // apart — and stops the line reading "at checkpoint undefined", which looks like a corrupt
    // trace rather than the different thing it actually is.
    if (manifest.fork_point === undefined) {
      out.plain(`  replay of ${manifest.parent_run}`);
    } else {
      const model = manifest.fork_model === undefined ? '' : ` on ${manifest.fork_model}`;
      out.plain(
        `  forked from ${manifest.parent_run} at checkpoint ${manifest.fork_point}${model}`,
      );
    }
  }
  out.plain('');

  // Both halves of the row. Rendering only `meta` showed token counts for a model response and an
  // empty cell for everything else — which quietly dropped a shell command's exit code, a tool
  // result's success or failure, and the stop reason, leaving a call and its result looking like
  // the same row printed twice.
  // Indented by delegation depth, so a sub-agent's model and tool calls read as its work rather
  // than as more of the parent's. `└─` on the first nested row marks where the delegation begins.
  const timeline = buildTimeline(events);
  const rows = timeline.map((r, i) => [
    String(r.seq),
    r.kind,
    `${nestPrefix(r.depth, timeline[i - 1]?.depth ?? 0)}${r.label}`,
    [r.detail, r.meta].filter((part) => part !== undefined && part !== '').join(' · '),
  ]);
  out.table(['SEQ', 'KIND', 'WHAT', 'DETAIL'], rows);

  const loops = detectLoops(events);
  for (const loop of loops) {
    out.plain('');
    // The signature is the point of the warning: "the same grep, four times" is something an
    // operator can act on, where a list of turn numbers is something they have to go and look up.
    out.warn('loop.detected', {
      kind: loop.kind,
      turns: loop.turns.join(','),
      repeats: loop.repeats,
      action: loop.signature,
      tree: loop.tree?.slice(0, 8),
    });
  }

  const cost = totalCost(events);
  if (cost !== null) {
    out.plain('');
    out.info('usage', {
      input: summary.totalUsage.input,
      output: summary.totalUsage.output,
      // Same scaling as the compare table: four fixed decimals render a genuinely cheap run as
      // `$0.0000`, which reads as free rather than as small.
      cost: formatCost(cost),
    });
  }
}

/** `orca checkpoints` — where can I fork from? */
export async function checkpointsCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<void> {
  const reader = await TraceReader.open(
    (await resolveRunSelector(cwd, args.positionals[0] ?? 'last')).dir,
  );
  const events = await reader.events();
  const checkpoints = deriveCheckpoints(events);

  if (checkpoints.length === 0) {
    out.plain('no checkpoints in this run');
    out.plain('  checkpoints need a filesystem snapshot; was this recorded with --no-fs?');
    return;
  }

  out.table(
    ['SEQ', 'TURN', 'TREE'],
    checkpoints.map((c) => [String(c.seq), String(c.turn), (c.fsTree ?? '').slice(0, 12)]),
  );
  out.plain('');
  out.plain(`  orca replay last --from ${checkpoints.at(-1)!.seq} --model <other-model>`);
}

/**
 * `orca graph` — what caused what.
 *
 * The timeline says what happened in what order; this says what produced what. Every row names
 * both ends and, crucially, whether the trace vouches for the edge or a rule here worked it out —
 * a reader who cannot tell the two apart has been handed a guess dressed as a fact.
 */
export async function graphCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<void> {
  const reader = await TraceReader.open(
    (await resolveRunSelector(cwd, args.positionals[0] ?? 'last')).dir,
  );
  const events = await reader.events();
  const graph = narrow(runGraph(events), args.num('to'));
  const label = new Map(graph.nodes.map((n) => [n.seq, n.type]));

  if (graph.edges.length === 0) {
    out.plain('no causal edges in this run');
    // Naming the likely cause beats leaving someone to wonder whether the feature works at all.
    out.plain(
      '  a run with no tool calls has nothing to connect; try `orca show` for the timeline',
    );
    return;
  }

  out.table(
    ['FROM', 'TO', 'KIND', 'WHY'],
    graph.edges.map((e) => [
      `${e.from} ${label.get(e.from) ?? ''}`.trim(),
      `${e.to} ${label.get(e.to) ?? ''}`.trim(),
      e.kind,
      e.rule,
    ]),
  );

  const inferred = graph.edges.filter((e) => e.kind === 'inferred').length;
  if (inferred > 0) {
    out.plain('');
    out.plain(`  ${inferred} inferred — derived from this trace, not recorded in it`);
  }
}

/** The whole graph, or just the chain that produced `to`. */
export function narrow(graph: RunGraph, to: number | undefined): RunGraph {
  return to === undefined ? graph : chainTo(graph, to);
}

/**
 * Write a card in whichever format was asked for.
 *
 * SVG is the source and never needs anything; PNG and GIF go through the optional raster path,
 * which explains itself when its packages are absent rather than failing obscurely.
 */
async function writeCard(
  path: string,
  format: CardFormat,
  svgs: string[],
  delays: number[],
): Promise<number> {
  if (format === 'svg') {
    const svg = svgs[svgs.length - 1] ?? '';
    await writeFile(path, svg, 'utf8');
    return Buffer.byteLength(svg);
  }
  const buffer =
    format === 'png' ? await svgToPng(svgs[svgs.length - 1] ?? '') : await svgsToGif(svgs, delays);
  await writeFile(path, buffer);
  return buffer.length;
}

/** `orca export` — the single self-contained file that makes a trace shareable. */
export async function exportCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<void> {
  const runDir = (await resolveRunSelector(cwd, args.positionals[0] ?? 'last')).dir;
  const reader = await TraceReader.open(runDir);
  const manifest = reader.manifest();

  // `--card` is a different artefact from `--out`, not a variation on it: one chain as a picture
  // rather than the whole trace as a page. It leaks far less too — a card carries the events on
  // one chain and none of the payloads — so it does not print the disclosure the page needs.
  // The graph card shows the shape of a run; the chain card follows one path through it. Two
  // different pictures, so two flags rather than a mode switch on one.
  if (args.has('graph-card')) {
    const target = cardTarget(args.str('graph-card') ?? 'graph.svg', '--graph-card');
    const cardPath = resolve(cwd, target.path);
    const events = await reader.events();
    const graph = runGraph(events);
    const to = args.num('to') ?? pickChainTarget(events);
    const highlight = new Set(to === undefined ? [] : chainTo(graph, to).nodes.map((n) => n.seq));
    const svg = renderGraphCard(scopeForCard(graph, highlight), {
      runId: manifest.run_id,
      highlight,
    });
    // A graph is one picture: there is no sequence to animate, so a .gif of it would be a
    // one-frame file pretending to be a clip.
    if (target.format === 'gif') {
      throw new Error('--graph-card draws one picture, so it has no animation. Use .svg or .png.');
    }
    const bytes = await writeCard(cardPath, target.format, [svg], []);
    out.phase('carded', { path: cardPath, bytes, kind: 'graph', format: target.format });
    return;
  }

  if (args.has('card')) {
    const target = cardTarget(args.str('card') ?? 'chain.svg', '--card');
    const cardPath = resolve(cwd, target.path);
    const events = await reader.events();
    const to = args.num('to') ?? pickChainTarget(events);
    if (to === undefined) {
      // Refusing beats drawing something arbitrary: a card gets screenshotted whether or not it
      // happens to be the interesting one, so a bad pick travels further than no card at all.
      throw new Error(
        `nothing in ${manifest.run_id} stands out as the subject of a card — ` +
          'no failing command, no tool error and no file change. ' +
          'Name the event yourself with `--to <seq>`, or `orca show` to find one.',
      );
    }
    const chain = chainTo(runGraph(events), to);
    const frames = gifFrames(chain.nodes.length);
    const svgs =
      target.format === 'gif'
        ? frames.map((f) => renderChainCard(chain, { runId: manifest.run_id, reveal: f.reveal }))
        : [renderChainCard(chain, { runId: manifest.run_id })];
    const bytes = await writeCard(
      cardPath,
      target.format,
      svgs,
      frames.map((f) => f.delayMs),
    );
    out.phase('carded', { path: cardPath, bytes, to, format: target.format });
    return;
  }

  const target = resolve(cwd, args.str('o') ?? args.str('out') ?? 'trace.html');

  // Say what is about to leave the machine before it does. A trace can contain file contents and
  // shell output, and the person exporting it is usually about to attach it to a public issue.
  out.plain('about to write a single self-contained file containing:');
  out.plain(`  run          ${manifest.run_id}`);
  out.plain(`  events       ${manifest.counts?.events ?? '?'}`);
  out.plain(`  blobs        ${manifest.counts?.blobs ?? '?'} (model requests, tool output, diffs)`);
  out.plain(
    `  redactions   ${Object.values(manifest.redaction?.rules_fired ?? {}).reduce((a, b) => a + b, 0)} applied`,
  );
  out.plain(`  cwd          ${manifest.cwd}`);
  out.plain('');
  out.plain('  redaction is best-effort. skim the file before sharing it.');
  out.plain('');

  const result = await exportTraceHtml(runDir, target);
  out.phase('exported', { path: result.path, bytes: result.bytes });
}

/** `orca ui` — the same viewer, served locally. */
export async function uiCommand(args: ParsedArgs, out: Output, cwd = process.cwd()): Promise<void> {
  const runDir = (await resolveRunSelector(cwd, args.positionals[0] ?? 'last')).dir;
  const server = await serveViewer({ runDir, port: args.num('port') ?? 0 });
  out.phase('viewer', { url: server.url });
  out.plain('  ctrl-c to stop');
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => void server.close().then(resolve));
  });
}

function totalCost(events: { type: string; attrs?: Record<string, unknown> }[]): number | null {
  let total = 0;
  let priced = false;
  for (const e of events) {
    if (e.type !== 'model.response') continue;
    const model = String(e.attrs?.model ?? '');
    const money = priceFor(
      {
        input_tokens: Number(e.attrs?.input_tokens ?? 0),
        output_tokens: Number(e.attrs?.output_tokens ?? 0),
      },
      model,
    );
    // An unknown model prices as null rather than zero: a confidently wrong cost is worse than an
    // absent one, because it ends up in a comparison someone makes a decision from.
    if (money) {
      total += money.amount;
      priced = true;
    }
  }
  return priced ? total : null;
}

/** `  `-per-level indent, with `└─` on the row where a delegation's work starts. */
function nestPrefix(depth: number, previousDepth: number): string {
  if (depth === 0) return '';
  return '  '.repeat(depth - 1) + (depth > previousDepth ? '└─ ' : '   ');
}
