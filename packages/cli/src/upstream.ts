import type { ParsedArgs } from './args.js';

/**
 * Where live model calls go.
 *
 * Needed by record *and* by replay: `--loose` and any fork continue live, and a fork that ignored
 * the override would quietly talk to the real provider instead of the gateway the user pointed it
 * at. Same flags, same behaviour, whichever command is running.
 */
export function upstreamOverrides(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const anthropic = args.str('upstream-anthropic') ?? env.ORCA_UPSTREAM_ANTHROPIC;
  const openai = args.str('upstream-openai') ?? env.ORCA_UPSTREAM_OPENAI;
  if (anthropic) out.anthropic = anthropic;
  if (openai) out.openai = openai;
  return Object.keys(out).length > 0 ? out : undefined;
}
