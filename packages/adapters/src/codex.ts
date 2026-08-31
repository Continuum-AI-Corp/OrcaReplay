import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, Launch, RecordContext, SessionSupport } from '@orcareplay/plugin-api';
import { detectAgent, homeDir } from './detect.js';
import { passThrough, proxyBase, readEnv } from './env.js';
import { contentText, parseJsonl } from './session.js';

/** Where the Codex CLI keeps `config.toml`, honouring its own override. */
function codexHome(env: Record<string, string | undefined>): string {
  return readEnv(env, 'CODEX_HOME') ?? join(homeDir(), '.codex');
}

/**
 * Which provider `config.toml` selects, defaulting to the built-in `openai`.
 *
 * A hand-rolled read of one key rather than a TOML parser: this is a top-level assignment in a
 * file Codex writes itself, and a dependency for it would be the only one in this package.
 * Anything unparseable falls back to the default, because a malformed config must degrade the
 * capture rather than stop the run.
 */
export function selectedProvider(configToml: string): string {
  for (const line of configToml.split(/\r?\n/)) {
    const text = line.trim();
    // Stop at the first table header: `model_provider` is a top-level key, and a same-named key
    // inside `[model_providers.x]` is a different setting entirely.
    if (text.startsWith('[')) break;
    const match = /^model_provider\s*=\s*["']([^"']+)["']/.exec(text);
    if (match?.[1]) return match[1];
  }
  return 'openai';
}

/**
 * Codex's rollout.
 *
 * The user's turns arrive as `response_item` messages whose content is `input_text`. The harness
 * puts its own preamble through the same channel — skills, environment context, multi-agent
 * instructions — and those are wrapped in a tag, which is what separates them from a typed turn.
 */
export const codexSession: SessionSupport = {
  dir(_cwd, env) {
    return join(codexHome(env), 'sessions');
  },

  parse(bytes) {
    const prompts: string[] = [];
    let id: string | undefined;
    for (const entry of parseJsonl(bytes)) {
      const payload = entry['payload'];
      if (payload === null || typeof payload !== 'object') continue;
      const p = payload as Record<string, unknown>;
      if (entry['type'] === 'session_meta' && typeof p['id'] === 'string') id ??= p['id'];
      if (entry['type'] !== 'response_item' || p['type'] !== 'message') continue;
      if (p['role'] !== undefined && p['role'] !== 'user') continue;
      const content = p['content'];
      if (!Array.isArray(content)) continue;
      const text = content
        .filter(
          (b) =>
            b !== null && typeof b === 'object' && (b as { type?: string }).type === 'input_text',
        )
        .map((b) => String((b as { text?: unknown }).text ?? ''))
        .join('')
        .trim();
      if (text === '' || text.startsWith('<')) continue;
      prompts.push(text);
    }
    return { id, prompts };
  },

  resumeArgs(id) {
    return ['exec', 'resume', id];
  },
};

/**
 * Codex CLI.
 *
 * `OPENAI_BASE_URL` is set for the built-in provider, but it is not enough on its own and never
 * was: Codex resolves its origin from `model_providers.<name>.base_url` in `config.toml`, so an
 * installation pointed at a gateway — which is the reason most people have a `config.toml` at all
 * — ignores the variable completely and talks straight to its own endpoint. The recording then
 * ends with `capture.empty` and nothing to replay, having cost a full run of real tokens.
 *
 * `-c` is Codex's own flag for overriding exactly one config value for one invocation, so the
 * override is scoped to the run and the user's file is never touched. The provider name has to be
 * read from that file, because the key to override is named after whichever provider is selected.
 *
 * No placeholder key: Codex carries its own credential store in `auth.json`, and inventing
 * `OPENAI_API_KEY` overrides it with something that is not real.
 */
export const codexAdapter: Adapter = {
  id: 'codex',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['codex'], ['.codex']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const base = proxyBase(ctx.proxyUrl, 'v1');
    const env: Record<string, string> = { OPENAI_BASE_URL: base };
    passThrough(env, ctx.env, 'OPENAI_API_KEY');

    let provider = 'openai';
    try {
      provider = selectedProvider(await readFile(join(codexHome(ctx.env), 'config.toml'), 'utf8'));
    } catch {
      // No config, or unreadable: the built-in provider is the right guess, and `OPENAI_BASE_URL`
      // covers it as well. Capture must never depend on a file existing.
    }

    // Ahead of the user's own arguments so that anything they pass explicitly still wins.
    const args = ['-c', `model_providers.${provider}.base_url=${base}`, ...ctx.userArgs];
    return { command: 'codex', args, env };
  },

  session: codexSession,

  /**
   * `exec` is Codex's non-interactive form and takes the prompt as its positional argument.
   *
   * A run recorded as `codex exec` with the prompt on stdin already carries the subcommand and its
   * flags, so the prompt is appended to what was recorded; a run recorded bare needs the whole
   * form. `--skip-git-repo-check` because a replay runs in a scratch directory that is not one.
   */
  driveArgs(prompts, recorded) {
    const first = prompts[0];
    if (first === undefined) return undefined;
    if (recorded.includes('exec')) return [...recorded, first];
    return ['exec', '--skip-git-repo-check', first];
  },
};
