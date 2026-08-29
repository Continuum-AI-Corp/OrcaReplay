import { createInterface } from 'node:readline/promises';
import { modelInfoFor } from '@orcareplay/providers';
import type { ParsedArgs } from '../args.js';
import type { Output } from '../out.js';
import {
  configPath,
  gatewayHeaders,
  ORCAROUTER_CONSOLE,
  ORCAROUTER_URL,
  readConfig,
  writeConfig,
  type OrcaConfig,
} from '../config.js';

/**
 * `orca setup` and `orca models` — the shortest path from "I want to compare four models" to a
 * working `orca compare`.
 *
 * Comparing models across providers used to mean knowing that `--upstream-anthropic` and
 * `--upstream-openai` exist, that a gateway serves both, and that the key goes in an environment
 * variable orca reads. All of that is real and none of it is discoverable. This asks two questions
 * instead, and — the part that matters — asks the gateway what it actually serves, so a wrong key
 * or a wrong URL is an answer now rather than a 401 in the middle of a comparison later.
 */

export interface SetupDeps {
  env?: NodeJS.ProcessEnv;
  /** Asks the gateway what it serves. Injected so tests need no network. */
  probe?: (gateway: string, headers: Record<string, string>) => Promise<string[]>;
  /** Prompt for a value. Absent means non-interactive. */
  ask?: (question: string) => Promise<string>;
}

/** OpenAI-compatible model listing, which every gateway worth pointing orca at implements. */
async function probeModels(gateway: string, headers: Record<string, string>): Promise<string[]> {
  const res = await fetch(`${gateway.replace(/\/+$/, '')}/v1/models`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data?: { id?: unknown }[] };
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string')
    .sort();
}

/** Prompts on a real terminal, and refuses to be one when nothing is attached. */
function terminalAsk(): ((question: string) => Promise<string>) | undefined {
  if (!process.stdin.isTTY) return undefined;
  return async (question: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };
}

export async function setupCommand(
  args: ParsedArgs,
  out: Output,
  deps: SetupDeps = {},
): Promise<OrcaConfig> {
  const env = deps.env ?? process.env;
  const probe = deps.probe ?? probeModels;
  const ask = deps.ask ?? terminalAsk();

  let url = args.str('gateway');
  let key = args.str('key');
  const keyEnv = args.str('key-env');

  // OrcaRouter fills the blank, and Enter accepts it. Offered rather than imposed: the whole point
  // of a gateway is that one origin serves several models, and most people asking for that do not
  // have one already — but anyone who does types over it, and `--gateway` skips the question.
  if (!url && ask) url = await ask(`Gateway URL (serves the model APIs) [${ORCAROUTER_URL}]: `);
  if (!url) url = ORCAROUTER_URL;
  if (!key && !keyEnv && ask) {
    if (sameOrigin(url, ORCAROUTER_URL)) {
      out.plain(`  get a key at ${ORCAROUTER_CONSOLE} — OrcaRouter keys start sk-orca-`);
    }
    key = await ask('API key (stored 0600; leave blank for none): ');
  }

  const gateway: OrcaConfig['gateway'] = { url };
  // Stored key wins if both are given, and only one is ever written: keeping both would leave a
  // credential on disk for someone who explicitly asked not to have one.
  if (key) gateway.api_key = key;
  else if (keyEnv) gateway.api_key_env = keyEnv;

  const existing = await readConfig(env);
  const config: OrcaConfig = { ...existing, gateway };

  // Ask before saving is tempting, but saving first means an unreachable gateway still leaves you
  // configured — being offline should not stop you setting up the thing you will use online.
  const path = await writeConfig(config, env);
  // `auth:`, not `key:` — the terminal guard redacts any field named `key`, which is right in
  // general and would hide the one thing this line exists to tell you: whether a key was stored at
  // all, and where it came from. The value is a description, never the credential.
  out.info('config.saved', { path, mode: '0600', gateway: url, auth: describeKey(gateway) });

  let available: string[] = [];
  try {
    available = await probe(url, gatewayHeaders(config, env));
    if (available.length === 0) {
      out.warn('gateway.no_models', { note: 'reachable, but it listed no models' });
    } else {
      out.plain('');
      out.plain(`  ${available.length} models available:`);
      for (const m of available.slice(0, 20)) out.plain(`    ${m}`);
      if (available.length > 20) out.plain(`    … and ${available.length - 20} more — orca models`);
    }

    // Ask which of them to compare by default, so `orca compare` needs no flags afterwards. This
    // is the half that makes setup worth running: a gateway with nothing chosen still leaves you
    // typing a model list on every invocation, which is what the command exists to remove.
    const chosen = args.str('models') ?? (ask ? await askModels(ask, available) : undefined);
    if (chosen) {
      config.models = chosen
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m !== '');
      if (config.models.length > 0) {
        await writeConfig(config, env);
        out.info('config.models', { models: config.models.join(',') });
      }
    }
  } catch (err) {
    out.warn('gateway.unreachable', {
      why: String(err instanceof Error ? err.message : err),
      note: 'the config was saved; fix the URL or key and run orca setup again',
    });
  }

  out.plain('');
  // Built from what the gateway actually serves, never from two model names picked here. Model ids
  // are gateway-specific — OrcaRouter namespaces them by provider, a direct provider does not — so a
  // hardcoded pair is a copyable line that fails against the gateway orca just configured.
  out.plain(nextStep(config, available));
  return config;
}

/** The line worth copying next, using real model ids wherever we have them. */
function nextStep(config: OrcaConfig, available: string[]): string {
  if (config.models && config.models.length > 0) return '  orca compare last --verify "npm test"';
  if (available.length > 0) {
    return `  orca compare last --models ${available.slice(0, 2).join(',')} --verify "npm test"`;
  }
  return '  orca models                    # what this gateway serves, then compare two of them';
}

/** Offer the gateway's own list, so the answer is a choice rather than a spelling test. */
async function askModels(
  ask: (question: string) => Promise<string>,
  available: string[],
): Promise<string | undefined> {
  const suggestion = available.slice(0, 3).join(',');
  const answer = await ask(
    `Models to compare by default${suggestion ? ` [${suggestion}]` : ''} (comma-separated, blank to skip): `,
  );
  return answer === '' ? (suggestion === '' ? undefined : suggestion) : answer;
}

export async function modelsCommand(
  args: ParsedArgs,
  out: Output,
  deps: SetupDeps = {},
): Promise<string[]> {
  const env = deps.env ?? process.env;
  const probe = deps.probe ?? probeModels;
  const config = await readConfig(env);

  if (!config.gateway?.url) {
    out.plain('no gateway configured');
    out.plain('');
    out.plain(`  orca setup                    # ${ORCAROUTER_URL}, or any gateway you name`);
    out.plain(`  orca setup --gateway <url> --key <key>`);
    out.plain('');
    out.plain(`  a key for the default gateway: ${ORCAROUTER_CONSOLE}`);
    return [];
  }

  let models: string[];
  try {
    models = await probe(config.gateway.url, gatewayHeaders(config, env));
  } catch (err) {
    out.failure({
      event: 'gateway.unreachable',
      what: `could not reach ${config.gateway.url}`,
      why: String(err instanceof Error ? err.message : err),
      next: `check the URL and key in ${configPath(env)}, or run orca setup again`,
    });
    return [];
  }

  // Price where we know it, a dash where we do not. Inventing a number for an unknown model is
  // how a comparison table ends up quoting a cost that was never real.
  out.table(
    ['MODEL', '$/MTOK IN', '$/MTOK OUT'],
    models.map((id) => {
      const info = modelInfoFor(id);
      return [
        id,
        info ? String(info.input_price_per_mtok) : '—',
        info ? String(info.output_price_per_mtok) : '—',
      ];
    }),
  );
  return models;
}

/** Same origin, tolerating a trailing slash — used only to decide whether to print the key hint. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  }
}

/** Says whether a key is set and where it came from, never what it is. */
function describeKey(gateway: NonNullable<OrcaConfig['gateway']>): string {
  if (gateway.api_key) return 'stored';
  if (gateway.api_key_env) return `from $${gateway.api_key_env}`;
  return 'none';
}
