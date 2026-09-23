import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent } from './detect.js';
import { Redactor, withoutInvisible } from '@orcareplay/core';
import { decodeForwardPath, forwardBasePath } from '@orcareplay/proxy';
import { forwardOrProxyBase, PLACEHOLDER_KEY, readEnv } from './env.js';

/**
 * MiniMax Code — MCode, `Mavis` in its own source — captured by relocating its data directory.
 *
 * It keeps a provider's origin in `~/.minimax/config.yaml`, not in an environment variable, and
 * its HTTP client is Node's `fetch`. That rules out both of the routes orca usually takes: there
 * is no base-URL variable to redirect, and undici consults neither `HTTP_PROXY` nor `HTTPS_PROXY`,
 * so `--tls-intercept` sees no traffic at all — a run recorded that way finishes with
 * `capture.empty` and nothing in the trace.
 *
 * What it does honour is `MINIMAX_DATA_DIR`. Pointing that at a directory of orca's own gives a
 * config the agent will read and the operator's own file never has to be touched — which matters,
 * because the obvious alternative is to rewrite `~/.minimax/config.yaml` in place and put it back
 * afterwards, and a run that is killed never puts it back.
 *
 * Relocating rather than rewriting is also the only thing that holds, because MCode writes to its
 * own config on startup. Measured on a real run: of the config this adapter generated, it put
 * exactly two lines back — the built-in `minimax_api` provider's `baseURL` and `apiKey`, restored
 * to its own values over what the file said. An adapter editing `~/.minimax/config.yaml` in place
 * would be handing the agent its own file to fight over.
 *
 * `provider add --use` is not involved: it throws `TEST_REQUIRED` unconditionally before it saves
 * anything. A `defaultModel` naming the provider activates it on its own, which is what the
 * operator's config already carries.
 *
 * So only custom providers can be captured. The redirect on every one of them survived that same
 * run; the built-in entries are the two lines MCode took back, and a run on the managed login
 * records nothing but the end-of-run warning. Every capture in `prompt/MCODE/` was taken through
 * a custom provider.
 */
export const mcodeAdapter: Adapter = {
  id: 'mcode',
  aliases: ['minimax-code', 'minimaxcode'],
  harnessVersions: '>=0.4.12',

  // Redirected through a file, not a variable. See the `capture` field on `Adapter`.
  capture: 'config',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['mcode'], ['.minimax']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const source = configPath(ctx.env);
    const original = await readFile(source, 'utf8').catch(() => undefined);

    // The data directory moves whether or not there is anything to put in it.
    //
    // Review caught what the earlier fallback cost. `orca replay` calls this same `prepare`, with
    // the operator's *current* environment rather than the recorded one — so a config that has
    // lost its custom provider since the recording made the fallback launch MCode untouched, on
    // the real `~/.minimax`, against the real gateway with the real credential. Nothing reached
    // the proxy, `unmatched` stayed at zero, and the replay reported success. An offline replay
    // had spent money and recorded nothing, quietly.
    //
    // An empty directory of orca's own is what stops that: MCode finds no provider and no
    // credential there and refuses to start, measured — `Sign in to MiniMax to use Agent
    // features` — without making a call. The adapter cannot tell a record from a replay, so the
    // safe launch has to be the one it always produces.
    //
    // The operator of a stock install pays for it: `orca record mcode` now ends in that sign-in
    // message rather than running uncaptured, and MCode fills the directory with its bundled
    // skills either way, about 14 MB. Both are worth it against a replay that silently goes live.
    const dataDir = join(ctx.runDir, 'mcode-data');
    await mkdir(dataDir, { recursive: true });
    const launch: Launch = {
      command: 'mcode',
      args: [...ctx.userArgs],
      env: isolatedEnv(ctx.env, dataDir),
    };

    // Nothing to redirect, or nothing this rewrite can prove it redirected. Either way the config
    // is not written, and the isolated directory above is what the agent gets.
    if (
      original === undefined ||
      !hasOrigin(original) ||
      !rewriteIsTrustworthy(original, ctx.proxyUrl)
    ) {
      return launch;
    }

    const config = join(dataDir, 'config.yaml');
    await writeFile(config, redirected(original, ctx.proxyUrl), 'utf8');
    return { ...launch, tempFiles: [config] };
  },
};

/**
 * The vendor's whole environment namespace, blanked, then the data directory put back.
 *
 * Review found `MAVIS_DATA_DIR` surviving into the child: `configPath` reads either spelling, but
 * the launch overrode only one, so an operator who had set the other kept their real data
 * directory — real config, real origin, real credential — and the isolation above bought nothing.
 *
 * Naming the spellings one at a time is how that happened, so this does not. MCode reads about
 * ninety `MAVIS_*` and `MINIMAX_*` variables, among them three more data directories
 * (`MAVIS_RUNTIME_DATA_DIR`, `MAVIS_PARENT_DATA_DIR`), four credentials (`MAVIS_ACCESS_TOKEN`,
 * `MAVIS_PARENT_AUTH_SECRET`, `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY`) and several origins. Every
 * one of them is emptied, and the two documented data-dir spellings are then pointed here. A
 * variable a later version adds is covered by the sweep rather than by remembering to add it.
 *
 * The overlay can only set, not unset, so they arrive empty rather than absent. That is the
 * difference between a run that cannot reach a real origin and one that quietly can.
 */
function isolatedEnv(
  env: Record<string, string | undefined>,
  dataDir: string,
): Record<string, string> {
  const overlay: Record<string, string> = {};
  for (const name of Object.keys(env)) if (VENDOR_ENV.test(name)) overlay[name] = '';
  for (const name of DATA_DIR_VARS) overlay[name] = dataDir;
  return overlay;
}

/**
 * One opaque run of token characters, long enough that nothing in a real config is one.
 *
 * `/` is deliberately not in the alphabet. A base64 secret can contain one, but so does every
 * provider-qualified model id — `deepseek/deepseek-v4-flash-free` is thirty-one characters of it —
 * and refusing every config that names a model would leave nothing working at all.
 */
const OPAQUE_TOKEN = /[A-Za-z0-9+_=-]{24,}/;

/**
 * What a line says after its field name.
 *
 * Nothing is stripped from it. The shape below is searched for inside the text rather than
 * matched against the whole of it, so a quote, a brace or a comma around the value makes no
 * difference — which is the property that makes a detector cheaper to get right than a rewriter.
 *
 * The name is dropped because names are long: `contextWindowOptionHints` and
 * `files_api_upload_endpoint` both clear twenty-four characters in a real config, and scanning
 * whole lines refused it. A line with no colon is a continuation — the indented scalar under
 * `apiKey:` — and is scanned whole, which is the only way to see a value written there.
 */
function valueText(line: string): string {
  const body = lineBody(line);
  const colon = body.indexOf(':');
  return colon === -1 ? body : body.slice(colon + 1);
}

/**
 * A value this file cannot account for, anywhere in the file.
 *
 * The second of two nets under `rewriteIsTrustworthy`, and a detector rather than a rewriter — so
 * it is deliberately not written the way the rewrite is. The rewrite understands one shape and
 * refuses the rest, which is right for something that has to produce correct output. A detector
 * built that way has the failure the other way round: every shape it does not parse is a value it
 * does not look at. Review found three of those in turn — a quoted value, a flow map, a value on
 * the following line — so this reads the text after the colon and does not care about structure.
 *
 * Every section, not just the custom one: the file lands in the run directory whatever section a
 * value is in. That also covers the configs whose section cannot be tracked at all, a quoted
 * top-level key or a leading byte-order mark.
 *
 * Measured against a real config and against a rewritten one, forward URLs included: nothing in
 * either matches.
 */
function hasUnaccountedToken(config: string): boolean {
  return config.split('\n').some((line) => {
    // The two this file rewrites are accounted for by the checks above.
    if (/base[_-]?url|api[_-]?key/i.test(lineBody(line).split(':')[0] ?? '')) return false;
    // As a reader would retype it — an invisible character inside a token split it below 24.
    return OPAQUE_TOKEN.test(withoutInvisible(valueText(line)));
  });
}

const VENDOR_ENV = /^(MAVIS|MINIMAX)_/;
const DATA_DIR_VARS = ['MAVIS_DATA_DIR', 'MINIMAX_DATA_DIR'];

/** Both spellings, because the bundle reads either and the operator may have set the other. */
function configPath(env: Record<string, string | undefined>): string {
  const dir = readEnv(env, 'MINIMAX_DATA_DIR') ?? readEnv(env, 'MAVIS_DATA_DIR');
  return dir !== undefined ? join(dir, 'config.yaml') : join(homedir(), '.minimax', 'config.yaml');
}

/**
 * Everything on a line that is not a comment.
 *
 * A YAML comment starts at a `#` with whitespace or the line start before it, so a `#` inside a
 * URL is a fragment and stays. A `#` inside a quoted value is cut as though it were a comment,
 * which leaves the line unparseable below and refused — the safe way to be wrong about it.
 */
function lineBody(line: string): string {
  const at = line.search(/(^|[ \t])#/);
  return at === -1 ? line : line.slice(0, at);
}

/**
 * The one shape this rewrite understands, for either field: optional quotes around the name, a
 * colon, and a value that is a single token, optionally quoted.
 *
 * An allowlist, after three rounds of review found shapes a blocklist had not thought of — a flow
 * map, a list item, a block scalar, a value on the next line, a quoted name, a name whose value is
 * only a comment. Each was a different way of writing the same field, and each went through a
 * pattern written to catch the ways already known. Reversing it ends that: a line that mentions
 * one of these fields and is not written this way is not rewritten, it is refused.
 */
const CANONICAL =
  /^([ \t]*)(['"]?)(base[_-]?url|api[_-]?key)\2([ \t]*:[ \t]*)(?:(['"])([^'"]*)\5|([^\s'"]+))([ \t\r]*)$/i;

/**
 * Either field, however it is written. A line naming one has to be understood or refused.
 *
 * The colon is what makes it a name rather than a value. Without it, `authMode: api-key` — which
 * every custom provider in a real config carries — read as a field this rewrite could not parse,
 * and the whole config was refused: a recording that should have captured six exchanges captured
 * none. The optional quote is for a name written `"apiKey"`.
 */
const KEY_MENTION = /api[_-]?key['"]?[ \t]*:/i;
const ORIGIN_MENTION = /base[_-]?url['"]?[ \t]*:/i;

/** `|` and `>` say the value is on the following lines, where no line pattern can reach it. */
const BLOCK_SCALAR = /^[|>][+-]?[0-9]*$/;

interface Field {
  name: string;
  value: string;
  /** The line with the value replaced, keeping its quoting, spacing and comment. */
  rebuild: (replacement: string) => string;
}

function fieldOf(line: string): Field | undefined {
  const parts = CANONICAL.exec(lineBody(line));
  if (parts === null) return undefined;
  const body = parts[0]!;
  const name = parts[3]!;
  const quote = parts[5] ?? '';
  const value = parts[6] ?? parts[7] ?? '';
  // A value is only a value if it is one. `|` and `>` put it on the lines below; so does a
  // `#` with no space before it, which the comment strip leaves in place — `apiKey:#rotated`
  // parsed as a field whose value was `#rotated` while the real key sat on the next line.
  if (BLOCK_SCALAR.test(value) || value.startsWith('#')) return undefined;
  const head = `${parts[1]!}${parts[2]!}${name}${parts[2]!}${parts[4]!}`;
  // The trailing whitespace and the comment come back from the line as it was written.
  const tail = `${parts[8]!}${line.slice(body.length)}`;
  return { name, value, rebuild: (replacement) => `${head}${quote}${replacement}${quote}${tail}` };
}

const isKey = (name: string): boolean => /key$/i.test(name);

/**
 * Which top-level section of the config a line is in.
 *
 * The two that matter are `custom_provider:` and `provider:`. Only the first holds anything worth
 * redirecting: MCode restores the built-in providers' own `baseURL` over whatever the file says,
 * measured on a real run, so pointing one at the proxy changes nothing and a run on it records
 * nothing either way.
 *
 * Keys are a separate question and are taken out of *every* section. The generated file lands in
 * the run directory and `capture.mjs` copies that directory into `capture/<model>/trace/` without
 * scrubbing it, so whatever this function decides about origins, no key may be left behind.
 */
function sectionsOf(config: string): string[] {
  let section = '';
  return config.split('\n').map((line) => {
    const top = /^([A-Za-z_][\w-]*)[ \t]*:/.exec(line);
    if (top !== null) section = top[1]!;
    return section;
  });
}

const CUSTOM_SECTION = 'custom_provider';

/**
 * Whether `/forward/` can carry this origin, asked of the decoder rather than restated here.
 *
 * `forwardOrProxyBase` answers an origin the decoder will not take with orca's own default
 * upstream, which for the env route is a reasonable last resort and here is not: the request
 * would leave for a host the operator never named, and this file's own comment calls that worse
 * than not capturing. Userinfo, a query, a fragment and a non-HTTP scheme are all refused by the
 * decoder, and a config carrying one of those is a config this adapter leaves alone.
 */
function carries(origin: string): boolean {
  return decodeForwardPath(forwardBasePath(origin)) !== undefined;
}

/** True when there is an origin in here this adapter can actually move. */
export function hasOrigin(config: string): boolean {
  const sections = sectionsOf(config);
  return config.split('\n').some((line, i) => {
    if (sections[i] !== CUSTOM_SECTION) return false;
    const field = fieldOf(line);
    return field !== undefined && !isKey(field.name) && field.value !== '';
  });
}

/**
 * Whether the rewrite can be trusted with this config at all.
 *
 * A rewrite that cannot prove it did its job does not get written. The proof is the allowlist: a
 * line that mentions either field must be written the one way this file understands. A key it
 * cannot see is a key it cannot take out, and an origin it cannot see is a provider that would
 * keep talking to its real host with nothing in the trace to say so.
 *
 * The cost of refusing is an uncaptured run — the same untouched launch a config with no custom
 * provider gets — which is the side to fail on when the alternative is writing a credential down.
 */
export function rewriteIsTrustworthy(config: string, proxyUrl: string): boolean {
  // Last, and about what this file does not know rather than what it does. The allowlist proves
  // the two fields it understands; a custom provider storing its credential under any other
  // name — `token:`, `secret:`, `apiToken:` — would pass every check above and be copied out
  // verbatim.
  //
  // Two nets, because one of them has a measured hole. Orca's own redactor is asked whether
  // anything in the result still looks like a secret: it changes nothing in a rewritten real
  // config, forward URLs included, and it catches an `sk-` token, a real JWT, a 40-character
  // random string and an AWS key id. It does not catch 32 hex characters — that string's maximum
  // Shannon entropy is exactly the threshold, so a hex key never trips it — which is the commonest
  // shape a session key or an API key takes.
  //
  // So the second net is shape rather than entropy: anywhere in the file, a field this one does
  // not rewrite whose value is a single opaque token of twenty-four characters or more is
  // something it cannot account for, and is refused. No value in a real config matches that —
  // names, kinds, model ids and `api-key` all carry punctuation or are shorter.
  //
  // What survives both is a short low-entropy value under an unknown name, `token: hunter2`.
  // These narrow the hole; they do not close it.
  const rewritten = redirected(config, proxyUrl);
  if (new Redactor().redactString(rewritten).value !== rewritten) return false;
  if (hasUnaccountedToken(config)) return false;

  const sections = sectionsOf(config);
  return config.split('\n').every((line, i) => {
    const body = lineBody(line);
    const mentionsKey = KEY_MENTION.test(body);
    if (!mentionsKey && !ORIGIN_MENTION.test(body)) return true;
    const field = fieldOf(line);
    if (field !== undefined && (mentionsKey || carries(field.value))) return true;
    // Not understood. A key hidden in it would be written down, and a custom origin would be
    // left pointing at its real host. A built-in origin is MCode's to decide and is not
    // rewritten either way, so its shape is none of this adapter's business.
    return !mentionsKey && sections[i] !== CUSTOM_SECTION;
  });
}

/**
 * The operator's config with every custom origin routed through the proxy and every key taken out.
 *
 * Rewritten as text rather than parsed and re-emitted. A YAML round-trip would reformat a file
 * orca did not write — comments, quoting, key order — and the two lines that need to change are
 * recognisable without understanding the rest.
 *
 * Each origin goes through `/forward/`, so the request arrives naming the destination it was taken
 * away from. Replacing it with orca's own default instead would point a recorded run at a host the
 * operator never named, which is worse than not capturing it.
 *
 * Every custom provider, not the first. With several configured, rewriting one leaves the rest
 * aimed at their real origins, and a run on one of those is simply missing from the trace.
 *
 * Keys come out of every section, built-in included, and `rewriteIsTrustworthy` refuses a config
 * whose credentials it cannot account for. What that is worth saying precisely: the two nets
 * catch what they recognise and a short low-entropy value under an unknown name gets past both,
 * so this is a best effort rather than the guarantee an earlier version of this comment claimed.
 *
 * Two things carry the rest of the weight, and neither is detection. `orca push` ships an
 * allowlist of four top-level entries, which this directory is not one of, so a pushed run never
 * carries it. And `capture/<model>/trace/` — where `capture.mjs` moves the run — is documented as
 * the unscrubbed raw run and is the one thing the prompt vault's CONTRIBUTING forbids committing.
 * A key that survives the nets stays on the machine it was already on. Orca
 * supplies the real one for the origin it forwards to — that is what `orca setup` configures and
 * what `upstreamHeaders` injects. Without it the gateway answers 401, and the prompt is captured
 * anyway: it travels in the request, which orca records before the origin ever replies.
 *
 * What MCode writes back into this file on startup is its own: measured against a config whose
 * every key had been replaced by a distinct canary, it restored the built-in provider's `apiKey`
 * as the literal `sk-xxx` from its bundle, and no canary reached the run directory. The
 * credentials it would have had to read instead live in `<dataDir>/auth/`, which moves with
 * `MINIMAX_DATA_DIR` — the run's copy holds two lock files and nothing else.
 */
export function redirected(config: string, proxyUrl: string): string {
  const sections = sectionsOf(config);
  return config
    .split('\n')
    .map((line, i) => {
      const field = fieldOf(line);
      if (field === undefined || field.value === '') return line;
      if (isKey(field.name)) return field.rebuild(PLACEHOLDER_KEY);
      if (sections[i] !== CUSTOM_SECTION) return line;
      // `v1` when the decoder will not take this origin, matching what the env route falls back to.
      return field.rebuild(forwardOrProxyBase(proxyUrl, field.value));
    })
    .join('\n');
}
