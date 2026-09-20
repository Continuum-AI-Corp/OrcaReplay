import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent } from './detect.js';
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
      env: { MINIMAX_DATA_DIR: dataDir },
    };

    // Nothing to redirect, or nothing this rewrite can prove it redirected. Either way the config
    // is not written, and the isolated directory above is what the agent gets.
    if (original === undefined || !hasOrigin(original) || !rewriteIsTrustworthy(original)) {
      return launch;
    }

    const config = join(dataDir, 'config.yaml');
    await writeFile(config, redirected(original, ctx.proxyUrl), 'utf8');
    return { ...launch, tempFiles: [config] };
  },
};

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
export function rewriteIsTrustworthy(config: string): boolean {
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
 * Keys come out of every section, built-in included. The file is written inside the run directory,
 * and §7 says a credential is never written there; `capture.mjs` then copies that directory into
 * `capture/<model>/trace/` unscrubbed, so a key left here would leave with the capture. Orca
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
