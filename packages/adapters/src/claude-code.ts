import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, Launch, RecordContext, SessionSupport } from '@orcareplay/plugin-api';
import { detectAgent, homeDir } from './detect.js';
import { passThrough, proxyBase, readEnv } from './env.js';
import { contentText, parseJsonl } from './session.js';

/**
 * Claude Code names a project directory after the working directory, with every character that is
 * not a letter, a digit or a hyphen replaced by one.
 *
 * Checked against a real install rather than inferred: a directory called `slug_test.dir v2`
 * becomes `slug-test-dir-v2`, so underscores, dots and spaces all fold the same way the path
 * separators do. An earlier version replaced only `\`, `/` and `:`, which was right for every
 * path it happened to be tested against and wrong for the first one with an underscore in it —
 * the computed name missed the real directory by one character, and the session capture then
 * found nothing and said nothing. Hence {@link claudeSession}'s fallback: a guess about someone
 * else's naming should not be the only thing holding the capture up.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Claude Code's transcript.
 *
 * `user` entries carry what the person typed, which is the half of a run orca cannot see from the
 * wire. Entries the harness generates for itself — tool results, the attachments it splices in —
 * arrive with the same `user` role, so they are filtered out: a replay driven by a tool result
 * would ask the model something the recording never asked.
 */
export const claudeSession: SessionSupport = {
  dir(cwd, env) {
    const home = readEnv(env, 'CLAUDE_CONFIG_DIR') ?? join(homeDir(), '.claude');
    const projects = join(home, 'projects');
    const named = join(projects, claudeProjectSlug(cwd));
    // The slug is a guess about someone else's naming, and a wrong guess loses the capture in
    // silence. When the directory it names is not there, watch the whole projects tree instead:
    // the file that changed during this run is still this run's, whatever it ended up called.
    return existsSync(named) ? named : projects;
  },

  parse(bytes) {
    const prompts: string[] = [];
    let id: string | undefined;
    for (const entry of parseJsonl(bytes)) {
      if (typeof entry['sessionId'] === 'string') id ??= entry['sessionId'];
      if (entry['type'] !== 'user') continue;
      const message = entry['message'];
      if (message === null || typeof message !== 'object') continue;
      const text = contentText((message as { content?: unknown }).content).trim();
      // A turn the harness synthesised, not one a person typed.
      if (text === '' || text.startsWith('<')) continue;
      prompts.push(text);
    }
    return { id, prompts };
  },

  resumeArgs(id) {
    return ['--resume', id];
  },
};

/**
 * Claude Code reads `ANTHROPIC_BASE_URL` for the API origin and appends its own `/v1/...` paths,
 * so the proxy url goes in bare.
 *
 * No placeholder key. The placeholder exists for SDK clients that refuse to construct without one,
 * and Claude Code is not one: it carries its own credential store, and most installations sign in
 * to claude.ai rather than setting `ANTHROPIC_API_KEY` at all. Inventing the variable for those
 * costs the recording twice over — Claude Code stops on an interactive "detected a custom API key"
 * prompt before it will start, and answering yes switches it off the subscription credential it
 * was going to authenticate with and onto a key that is not real. Passing the variable through
 * when it is genuinely set keeps the API-key path exactly as it was.
 */
export const claudeCodeAdapter: Adapter = {
  id: 'claude-code',
  // What people type. The binary is `claude`, and so is every example in the docs.
  aliases: ['claude'],
  harnessVersions: '>=1.0.0',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['claude'], ['.claude']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl) };
    passThrough(env, ctx.env, 'ANTHROPIC_API_KEY');
    passThrough(env, ctx.env, 'ANTHROPIC_AUTH_TOKEN');
    return { command: 'claude', args: [...ctx.userArgs], env };
  },

  session: claudeSession,

  /**
   * `--strict-mcp-config` alongside it, so the run uses the instrumented copy *instead of* the
   * user's own servers rather than as well as them. Without it a project `.mcp.json` is still
   * loaded, the same server is registered twice, and half its calls go round the shim.
   */
  mcpConfigArgs(path) {
    return ['--mcp-config', path, '--strict-mcp-config'];
  },

  /** `-p` is how Claude Code takes a prompt without a terminal, which a replay never has. */
  driveArgs(prompts, recorded) {
    const first = prompts[0];
    return first === undefined ? undefined : [...recorded, '-p', first];
  },
};
