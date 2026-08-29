import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { PLACEHOLDER_KEY, readEnv } from './env.js';

/**
 * The adapter contract: the behaviour every adapter must have for capture to work at all.
 *
 * Adapters break silently. A harness renames the variable it reads for its API origin, the adapter
 * keeps setting the old one, and every run still *looks* fine — the agent answers, the exit code is
 * zero, and the trace is empty. Each check below exists because breaking it produces exactly that
 * shape of failure: nothing to see until a user files a confusing bug.
 */

/** Every check, in the order they run. A failing check never stops the others. */
export const CONTRACT_CHECKS = [
  'id-format',
  'detect-resolves',
  'prepare-shape',
  'redirects-model-traffic',
  'no-invented-keys',
  'no-ctx-mutation',
  'deterministic',
  'no-foreign-paths',
  'harness-versions',
] as const;

export type ContractCheck = (typeof CONTRACT_CHECKS)[number];

export interface ContractFailure {
  check: ContractCheck;
  detail: string;
}

export interface ContractResult {
  adapter: string;
  passed: string[];
  failed: ContractFailure[];
  ok: boolean;
}

export interface ContractOptions {
  /**
   * Overrides for the context the checks prepare against — `userArgs` for an adapter that takes
   * its command from argv, or a `proxyUrl` matching a running proxy. `cwd` and `runDir` default to
   * fresh temp directories that are removed afterwards; `env` is owned by the credential checks,
   * which vary it deliberately.
   */
  ctx?: Partial<RecordContext>;
}

/** At least one of these must be redirected, or the proxy sees nothing at all. */
export const MODEL_BASE_URL_VARS = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
] as const;

/** Anything shaped like an API origin, including variables no harness reads yet. */
const BASE_URL_LIKE = /(?:_BASE_URL|_API_BASE)$/;

/** Anything shaped like a credential. Over-matching here only ever costs a clearer error. */
const CREDENTIAL_LIKE = /(?:KEY|TOKEN|SECRET|PASSWORD)$/;

const ID_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A port no adapter would plausibly hardcode: the checks must follow `ctx.proxyUrl`. */
const CONTRACT_PROXY = 'http://127.0.0.1:49831';

const PROBE_KEY = 'orca-contract-probe';

/** Returned by a check that does not apply to this adapter, so it is neither passed nor failed. */
const SKIP = Symbol('skip');

type CheckOutcome = string | undefined | typeof SKIP;

/**
 * Runs one adapter through the contract. Never throws: a runner that dies on a broken adapter is
 * the same class of bug it is trying to catch, and callers batch this over a whole registry.
 */
export async function checkAdapterContract(
  adapter: Adapter,
  opts: ContractOptions = {},
): Promise<ContractResult> {
  const root = await mkdtemp(join(tmpdir(), 'orca-contract-'));
  const passed: string[] = [];
  const failed: ContractFailure[] = [];
  try {
    const base = await baseContext(root, opts.ctx ?? {});
    const primary = await attempt(adapter, base);
    const runners: Array<[ContractCheck, () => Promise<CheckOutcome>]> = [
      ['id-format', async () => idFormat(adapter)],
      ['detect-resolves', () => detectResolves(adapter, base, join(root, 'missing-workspace'))],
      ['prepare-shape', async () => prepareShape(primary)],
      ['redirects-model-traffic', async () => redirectsModelTraffic(primary, base)],
      ['no-invented-keys', () => noInventedKeys(adapter, base)],
      ['no-ctx-mutation', () => noCtxMutation(adapter, base)],
      ['deterministic', () => deterministic(adapter, base)],
      ['no-foreign-paths', async () => noForeignPaths(primary, base)],
      ['harness-versions', async () => harnessVersions(adapter)],
    ];

    for (const [check, run] of runners) {
      let outcome: CheckOutcome;
      try {
        outcome = await run();
      } catch (err) {
        outcome = `the check itself threw: ${describeError(err)}`;
      }
      if (outcome === SKIP) continue;
      if (outcome === undefined) passed.push(check);
      else failed.push({ check, detail: outcome });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return { adapter: adapter.id, passed, failed, ok: failed.length === 0 };
}

/** One line for a pass, one line per failure otherwise — the shape a CI log wants. */
export function formatContractResult(result: ContractResult): string {
  if (result.ok) return `${result.adapter}: ok (${result.passed.length} checks)`;
  const total = result.passed.length + result.failed.length;
  const lines = result.failed.map((f) => `  - ${f.check}: ${f.detail}`);
  return [`${result.adapter}: ${result.failed.length}/${total} checks failed`, ...lines].join('\n');
}

type Attempt = { launch: Launch } | { error: string };

async function attempt(adapter: Adapter, base: RecordContext): Promise<Attempt> {
  try {
    return { launch: await adapter.prepare(clone(base)) };
  } catch (err) {
    return { error: describeError(err) };
  }
}

async function baseContext(root: string, over: Partial<RecordContext>): Promise<RecordContext> {
  const cwd = over.cwd ?? join(root, 'work');
  const runDir = over.runDir ?? join(root, 'run');
  // Only create the directories we invented: a caller-supplied path is theirs to manage.
  if (over.cwd === undefined) await mkdir(cwd, { recursive: true });
  if (over.runDir === undefined) await mkdir(runDir, { recursive: true });
  return {
    runId: 'run_contract',
    proxyUrl: CONTRACT_PROXY,
    // An adapter that takes its command from argv (generic-openai) gets one without special-casing.
    userArgs: ['orca-contract-agent', '--task', 'contract check'],
    env: {},
    ...over,
    cwd,
    runDir,
  };
}

function clone(ctx: RecordContext): RecordContext {
  return structuredClone(ctx);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notVerified(check: ContractCheck): string {
  return `not verified: prepare() rejected (see ${check})`;
}

function idFormat(adapter: Adapter): CheckOutcome {
  const { id } = adapter;
  if (typeof id !== 'string' || id.trim() === '') {
    return (
      'id is empty; it is how a user names the adapter on the command line and how a trace ' +
      'records which adapter produced it'
    );
  }
  if (!ID_FORMAT.test(id)) {
    return `id '${id}' is not lowercase kebab-case; ids appear in 'orca record <id>', in run manifests and in URLs, so mixed case and underscores turn into support questions`;
  }
  return undefined;
}

async function detectResolves(
  adapter: Adapter,
  base: RecordContext,
  missing: string,
): Promise<CheckOutcome> {
  const probes: Array<[string, string]> = [
    ['a directory that exists', base.cwd],
    ['a path that does not exist', missing],
  ];
  for (const [label, dir] of probes) {
    let value: unknown;
    try {
      value = await adapter.detect(dir);
    } catch (err) {
      return `detect() rejected for ${label}: ${describeError(err)}. AdapterRegistry treats a throwing detector as "no", so this adapter would silently never be auto-selected — and any caller that does not guard loses detection for every other adapter too. Answer false instead`;
    }
    if (typeof value !== 'boolean') {
      return `detect() resolved ${JSON.stringify(value)} for ${label}; callers write 'if (await adapter.detect(cwd))', so any truthy value silently claims the workspace`;
    }
  }
  return undefined;
}

function prepareShape(primary: Attempt): CheckOutcome {
  if ('error' in primary) return `prepare() rejected: ${primary.error}`;
  const { launch } = primary;
  const problems: string[] = [];
  if (typeof launch?.command !== 'string' || launch.command === '') {
    problems.push('command must be a non-empty string — it is what gets spawned');
  }
  if (!Array.isArray(launch?.args) || !launch.args.every((a) => typeof a === 'string')) {
    problems.push('args must be an array of strings, never a pre-joined command line');
  }
  if (!isStringRecord(launch?.env)) {
    problems.push('env must be an object of string values, which is all a child process can carry');
  }
  return problems.length > 0 ? problems.join('; ') : undefined;
}

/**
 * The check that catches adapter rot. If the harness moves to a new variable and nobody updates
 * the adapter, capture returns nothing while every other signal — exit code, output, the agent's
 * own answers — still says the run worked.
 */
function redirectsModelTraffic(primary: Attempt, base: RecordContext): CheckOutcome {
  if ('error' in primary) return notVerified('prepare-shape');
  const env = primary.launch.env;
  if (!isStringRecord(env)) return notVerified('prepare-shape');

  const known = MODEL_BASE_URL_VARS.filter((name) => readEnv(env, name) !== undefined);
  if (known.length === 0) {
    return `prepare() set none of ${MODEL_BASE_URL_VARS.join(', ')}, so nothing points the harness at the proxy and the run records no model traffic at all`;
  }
  const host = hostOf(base.proxyUrl) ?? base.proxyUrl;
  const wrong = Object.entries(env)
    .filter(([name]) => BASE_URL_LIKE.test(name))
    .filter(([, value]) => !pointsAtHost(value, host));
  if (wrong.length > 0) {
    const names = wrong.map(([name, value]) => `${name}=${value}`).join(', ');
    return `${names} does not point at the proxy (${base.proxyUrl}); traffic on that origin goes straight to the provider and never reaches the trace`;
  }
  return undefined;
}

/**
 * An invented credential is not a convenience: harnesses pick a provider from which credentials
 * are present, so fabricating one can change which model the run calls. `passKey` substitutes an
 * obviously-fake placeholder for the provider the harness actually speaks; anything beyond that
 * has to come from the user's own environment.
 */
async function noInventedKeys(adapter: Adapter, base: RecordContext): Promise<CheckOutcome> {
  const bare = await attempt(adapter, { ...base, env: {} });
  if ('error' in bare) return notVerified('prepare-shape');
  if (!isStringRecord(bare.launch.env)) return notVerified('prepare-shape');

  const invented = Object.entries(bare.launch.env).filter(([name]) => CREDENTIAL_LIKE.test(name));
  const fabricated = invented
    .filter(([, value]) => value !== PLACEHOLDER_KEY)
    .map(([name]) => name);
  if (fabricated.length > 0) {
    // Never echo the value: it may be a real credential read from somewhere unexpected.
    return `prepare() set ${fabricated.join(', ')} to a value ctx.env did not contain. If the harness refuses to start without a credential use passKey(), which substitutes the recognisable placeholder '${PLACEHOLDER_KEY}'`;
  }

  const families = [...new Set(invented.map(([name]) => providerFamily(name)))];
  if (families.length < 2) return undefined;

  // With one provider's credential already in hand, inventing the other's is what flips the
  // harness's provider auto-selection — and a recorded run then answers from a different model
  // than the same command would without recording.
  for (const family of families) {
    const donor = invented.find(([name]) => providerFamily(name) === family)?.[0];
    if (donor === undefined) continue;
    const probeEnv: Record<string, string> = { [donor]: PROBE_KEY };
    const probe = await attempt(adapter, { ...base, env: probeEnv });
    if ('error' in probe) return notVerified('prepare-shape');
    const stillInvented = Object.keys(probe.launch.env).filter(
      (name) =>
        CREDENTIAL_LIKE.test(name) &&
        providerFamily(name) !== family &&
        readEnv(probeEnv, name) === undefined,
    );
    if (stillInvented.length > 0) {
      return `with only ${donor} in ctx.env, prepare() still invents ${stillInvented.join(', ')}; a harness that picks its provider from the credentials it can see will pick a different one under recording. Use passThrough() for a second provider`;
    }
  }
  return undefined;
}

/**
 * `orca record` hands the adapter `process.env` itself as `ctx.env` and the parsed argv as
 * `ctx.userArgs`, so a mutation edits the recorder's own environment and the argv it writes into
 * the manifest — which is then replayed.
 */
async function noCtxMutation(adapter: Adapter, base: RecordContext): Promise<CheckOutcome> {
  const ctx = clone(base);
  const before = structuredClone(ctx);
  try {
    await adapter.prepare(ctx);
  } catch {
    return notVerified('prepare-shape');
  }
  if (isDeepStrictEqual(ctx, before)) return undefined;
  const fields = (Object.keys(before) as Array<keyof RecordContext>).filter(
    (key) => !isDeepStrictEqual(ctx[key], before[key]),
  );
  return `prepare() mutated ctx.${fields.join(', ctx.')}; the caller owns that object and reuses it — copy instead, e.g. args: [...ctx.userArgs]`;
}

/** Replay prepares the same context again. Anything that drifts turns into a false divergence. */
async function deterministic(adapter: Adapter, base: RecordContext): Promise<CheckOutcome> {
  const first = await attempt(adapter, base);
  const second = await attempt(adapter, base);
  if ('error' in first || 'error' in second) return notVerified('prepare-shape');
  const drifted = (['command', 'args', 'env'] as const).filter(
    (key) => !isDeepStrictEqual(first.launch[key], second.launch[key]),
  );
  if (drifted.length === 0) return undefined;
  return `two prepare() calls on the same ctx disagreed on ${drifted.join(', ')}; replay prepares the same context again, so anything random or time-based here reads as a divergence`;
}

/**
 * Cheap leak check. Launch env is written into the run manifest and shared with bug reports, so an
 * absolute path from outside the run is both a privacy leak and a value nobody else can reproduce.
 */
function noForeignPaths(primary: Attempt, base: RecordContext): CheckOutcome {
  if ('error' in primary) return notVerified('prepare-shape');
  const env = primary.launch.env;
  if (!isStringRecord(env)) return notVerified('prepare-shape');
  for (const [name, value] of Object.entries(env)) {
    for (const candidate of absolutePaths(value)) {
      if (isInside(candidate, base.runDir) || isInside(candidate, base.cwd)) continue;
      return `env ${name} contains ${candidate}, which is outside ctx.runDir and ctx.cwd; write scratch config under ctx.runDir so the launch is reproducible on a machine that is not yours`;
    }
  }
  return undefined;
}

function harnessVersions(adapter: Adapter): CheckOutcome {
  const range = adapter.harnessVersions;
  if (range === undefined) return SKIP;
  if (typeof range !== 'string' || range.trim() === '') {
    return 'harnessVersions is set but empty; leave it off entirely rather than declaring a range that matches nothing';
  }
  return isSemverRange(range)
    ? undefined
    : `harnessVersions '${range}' is not a semver range; it is the field that says which harness versions this adapter was actually verified against, so 'latest' or a date says nothing`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function pointsAtHost(value: string, host: string): boolean {
  const valueHost = hostOf(value);
  return valueHost !== undefined ? valueHost === host : value.includes(host);
}

/** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are one provider; `OPENAI_API_KEY` is another. */
function providerFamily(name: string): string {
  return name.split('_')[0] ?? name;
}

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const ABSOLUTE_PATH = /(?:^|[\s:;,"'=])((?:[A-Za-z]:[\\/]|\/)[^\s:;,"'=]*)/g;

/** Absolute-looking paths in a value, ignoring the path component of any URL inside it. */
function absolutePaths(value: string): string[] {
  const withoutUrls = value.replace(URL_LIKE, ' ');
  const found: string[] = [];
  for (const match of withoutUrls.matchAll(ABSOLUTE_PATH)) {
    const path = match[1];
    // One segment (`/v1`, `/tmp`) is not a leak; a leak has a directory in it.
    if (path !== undefined && path.split(/[\\/]/).filter(Boolean).length > 1) found.push(path);
  }
  return found;
}

function isInside(path: string, base: string): boolean {
  if (base === '') return false;
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return path === base || path.startsWith(prefix);
}

const SEMVER_COMPARATOR =
  /^(?:[<>]=?|=|[~^])?v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Shape check only — no semver dependency, and a range that parses is not a range anyone verified.
 * It exists to catch `latest`, `1.0` typoed as `v1,0`, and dates.
 */
function isSemverRange(range: string): boolean {
  const parts = range.split('||');
  return parts.every((part) => {
    const tokens = part
      .replace(/([<>=~^]+)\s+/g, '$1')
      .trim()
      .split(/\s+/)
      .filter((t) => t !== '');
    if (tokens.length === 0) return false;
    return tokens.every((token) => token === '*' || token === '-' || SEMVER_COMPARATOR.test(token));
  });
}
