import { createInterface } from 'node:readline/promises';
import { unusableOrigin, recordableOrigin, withoutCredentials } from '@orcareplay/proxy';
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

  // Refused here, before it is stored or echoed. Sanitising on the way out is not enough on its
  // own: `new URL` parses a scheme-less URL with the username as the protocol, so the sanitiser
  // returns a value that still carries the password and every `?? url` guard downstream sees a
  // success. Nothing refused here could have worked anyway — undici rejects a URL carrying
  // credentials, and a scheme-less one has no host to reach.
  const problem = unusableOrigin(url);
  if (problem !== undefined) {
    throw new Error(
      `--gateway is not an origin orca can use: ${problem}` +
        '\n  a gateway is scheme, host and path: --gateway https://gateway.example/v1' +
        '\n  the key goes separately: --key <key>, or --key-env NAME',
    );
  }
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
  // The URL, minus anything a credential rides in. `--gateway` takes whatever it is handed, and a
  // gateway that authenticates by URL rather than by header is configured as
  // `https://user:pw@gw.example` or `https://gw.example?key=…`. Printing it verbatim broke the
  // promise made where this file is described — "nothing ever prints it back" — and the terminal
  // guard did not catch it: it matches known key *shapes* (`sk-`, `ghp_`, …) and field *names*,
  // and an arbitrary password in a URL under a field called `gateway` is neither.
  out.info('config.saved', {
    path,
    mode: '0600',
    gateway: recordableOrigin(url) ?? '(unprintable)',
    auth: describeKey(gateway),
  });
  // Said rather than silently dropped: someone who typed a long URL and sees a short one back is
  // owed the reason, and the reason is the useful half — it is also what will and will not appear
  // in every trace recorded through this gateway.
  if (carriesMoreThanOrigin(url)) {
    out.plain('  the rest of that URL is saved and sent, but never printed or written to a trace');
  }

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
      // A failed fetch names the URL it was given, credential and all.
      why: withoutCredentials(String(err instanceof Error ? err.message : err)),
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

  // The same standard, applied where a config arrives rather than only where one is typed.
  // `readConfig` deliberately accepts a hand-edited file, so this is the one path on which a
  // gateway carrying its key in the URL can still turn up — and it is the path whose whole job is
  // to report that the gateway cannot be reached. Refusing before the probe means neither the
  // message nor the fetch error it would have quoted can carry the value.
  const configured = unusableOrigin(config.gateway.url);
  if (configured !== undefined) {
    out.failure({
      event: 'gateway.unusable',
      what: `the gateway in ${configPath(env)} is not an origin orca can use`,
      why: configured,
      next: 'orca setup --gateway <url> --key-env NAME',
    });
    return [];
  }

  let models: string[];
  try {
    models = await probe(config.gateway.url, gatewayHeaders(config, env));
  } catch (err) {
    out.failure({
      event: 'gateway.unreachable',
      // Never the raw value: this path exists to diagnose a gateway that cannot be reached,
      // and a hand-edited config carrying its key in the URL is one of the reasons it cannot
      // be. Naming the file says as much without printing what is in it.
      what: `could not reach ${recordableOrigin(config.gateway.url) ?? `the gateway configured in ${configPath(env)}`}`,
      why: withoutCredentials(String(err instanceof Error ? err.message : err)),
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

/**
 * Whether a URL carries anything beyond the origin and path orca is willing to show.
 *
 * Used only to decide whether to explain the shortening. The shortening itself is
 * `recordableOrigin`, and it happens whether or not this returns true.
 */
function carriesMoreThanOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== ''
    );
  } catch {
    return false;
  }
}
