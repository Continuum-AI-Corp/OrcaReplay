import { resolve } from 'node:path';
import { TraceReader, deriveCheckpoints, listRuns, resolveRunSelector } from '@orcareplay/core';
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
      r.parentRun === undefined ? '' : `${r.parentRun}@${r.forkPoint ?? '?'}`,
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
    `${summary.runId}  ${summary.adapter}  ${summary.eventCount} events  exit ${summary.exitCode ?? 0}`,
  );
  // A forked run's timeline opens mid-conversation in a worktree that no longer exists. Without
  // this line the only way to learn where it came from is to cat the manifest — for the feature
  // the tool is named after.
  if (manifest.parent_run !== undefined) {
    const model = manifest.fork_model === undefined ? '' : ` on ${manifest.fork_model}`;
    out.plain(`  forked from ${manifest.parent_run} at checkpoint ${manifest.fork_point}${model}`);
  }
  out.plain('');

  const rows = buildTimeline(events).map((r) => [String(r.seq), r.kind, r.label, r.meta ?? '']);
  out.table(['SEQ', 'KIND', 'WHAT', 'DETAIL'], rows);

  const loops = detectLoops(events);
  for (const loop of loops) {
    out.plain('');
    out.warn('loop.detected', { turns: loop.turns.join(','), tree: loop.tree.slice(0, 8) });
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

/** `orca export` — the single self-contained file that makes a trace shareable. */
export async function exportCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<void> {
  const runDir = (await resolveRunSelector(cwd, args.positionals[0] ?? 'last')).dir;
  const target = resolve(cwd, args.str('o') ?? args.str('out') ?? 'trace.html');

  const reader = await TraceReader.open(runDir);
  const manifest = reader.manifest();

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
