import { TraceReader, deriveCheckpoints, resolveRunSelector } from '@orcareplay/core';
import { priceFor } from '@orcareplay/providers';
import { parseArgs, type ParsedArgs } from '../args.js';
import type { Output } from '../out.js';
import { replayCommand } from './replay.js';

/** Run the verdict command inside the fork's worktree. Shell so `npm test -- auth` just works. */
async function runVerify(command: string, cwd: string): Promise<number> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'ignore' });
    // A verify command that cannot even start is a failed verdict, not a crashed comparison.
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Each fork is a fresh argv, so upstream overrides have to be forwarded explicitly. */
function upstreamFlags(args: ParsedArgs): string[] {
  const out: string[] = [];
  const a = args.str('upstream-anthropic');
  const o = args.str('upstream-openai');
  if (a) out.push('--upstream-anthropic', a);
  if (o) out.push('--upstream-openai', o);
  return out;
}

export interface CompareRow {
  /** Exit code of --verify, when one was given. This, not the agent's exit code, is the verdict. */
  verifyExitCode?: number;
  model: string;
  verdict: 'pass' | 'fail';
  exitCode: number;
  divergences: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  wallMs: number;
  forkRunId?: string;
  error?: string;
}

/**
 * `orca compare <run> --models a,b,c`
 *
 * N forks from one checkpoint. The comparison only means anything because every branch starts
 * from an identical filesystem tree and conversation prefix — the model is the only variable, so
 * the difference in outcome is attributable to it rather than to drift.
 */
export async function compareCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<CompareRow[]> {
  const models = args.list('models');
  if (models.length === 0) {
    throw new Error(
      'compare needs models to compare\n  orca compare last --models claude-opus-5,glm-5.3-flash',
    );
  }

  const selector = args.positionals[0] ?? 'last';
  const runDir = (await resolveRunSelector(cwd, selector)).dir;
  const reader = await TraceReader.open(runDir);
  const events = await reader.events();
  const checkpoints = deriveCheckpoints(events);
  if (checkpoints.length === 0) {
    throw new Error('this run has no checkpoints, so there is nothing to fork from');
  }

  const from = args.num('from') ?? checkpoints[checkpoints.length - 1]!.seq;
  const runId = reader.manifest().run_id;

  out.phase('compare', { run: runId, from, models: models.join(',') });

  const rows: CompareRow[] = [];
  // Sequential rather than parallel: each fork spawns a real agent against a real worktree, and
  // running four of those concurrently on one machine measures the machine, not the models.
  for (const model of models) {
    const startedAt = Date.now();
    try {
      const forkArgs = parseArgs([
        'replay',
        // The concrete run id, never the caller's selector. "last" is re-resolved on every fork,
        // so after the first branch it would point at the child we just created — which has no
        // checkpoints — and every later model would fail for a reason that is not about the model.
        runId,
        '--from',
        String(from),
        '--model',
        model,
        ...(args.bool('loose') ? ['--loose'] : []),
        ...upstreamFlags(args),
      ]);
      const result = await replayCommand(forkArgs, out, cwd);

      // The agent exiting 0 only means it did not crash. "Did the task actually get done" needs
      // a command that answers it — otherwise the verdict column is a number nobody should act on.
      const verify = args.str('verify');
      const verifyExitCode =
        verify && result.worktree ? await runVerify(verify, result.worktree) : undefined;
      const failed = verifyExitCode === undefined ? result.exitCode !== 0 : verifyExitCode !== 0;
      const usage = result.forkRunId
        ? await usageOf(cwd, result.forkRunId)
        : { input: 0, output: 0 };
      const money = priceFor({ input_tokens: usage.input, output_tokens: usage.output }, model);
      rows.push({
        model,
        verdict: failed ? 'fail' : 'pass',
        verifyExitCode,
        exitCode: result.exitCode,
        divergences: result.divergences,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cost: money ? money.amount : null,
        wallMs: Date.now() - startedAt,
        forkRunId: result.forkRunId,
      });
    } catch (err) {
      rows.push({
        model,
        verdict: 'fail',
        exitCode: -1,
        divergences: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: null,
        wallMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message.split('\n')[0] : String(err),
      });
    }
  }

  out.plain('');
  out.table(
    ['MODEL', 'VERDICT', 'TOKENS', 'COST', 'WALL', 'RUN'],
    rows.map((r) => [
      r.model,
      r.verdict,
      `${r.inputTokens}/${r.outputTokens}`,
      // An unknown model prices as a dash, never as $0.00 — a confidently wrong cost is worse
      // than an absent one when it lands in a table someone decides from. And a real cost too
      // small for four decimals still gets shown: "cheaper" is the whole reason for this column.
      formatCost(r.cost),
      `${(r.wallMs / 1000).toFixed(1)}s`,
      r.forkRunId ?? r.error ?? '',
    ]),
  );

  return rows;
}

/** Dash for unknown. Otherwise enough precision that a genuinely cheap model does not read $0. */
export function formatCost(amount: number | null): string {
  if (amount === null) return '—';
  if (amount === 0) return '$0';
  if (amount < 0.0001) return `$${amount.toExponential(2)}`;
  if (amount < 0.01) return `$${amount.toFixed(6)}`;
  return `$${amount.toFixed(4)}`;
}

async function usageOf(cwd: string, runId: string): Promise<{ input: number; output: number }> {
  const reader = await TraceReader.open((await resolveRunSelector(cwd, runId)).dir);
  let input = 0;
  let output = 0;
  for (const e of await reader.events()) {
    if (e.type !== 'model.response') continue;
    input += Number(e.attrs?.input_tokens ?? 0);
    output += Number(e.attrs?.output_tokens ?? 0);
  }
  return { input, output };
}
