import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent } from './detect.js';
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

    // No config means no custom provider, and a custom provider is the only thing this route can
    // move. Launching untouched leaves the operator with MCode's own behaviour and orca's empty
    // capture warning, which is a truer answer than a redirect aimed at a provider that is not
    // there.
    if (
      original === undefined ||
      !hasOrigin(original) ||
      !rewriteIsTrustworthy(original, ctx.proxyUrl)
    ) {
      return { command: 'mcode', args: [...ctx.userArgs], env: {} };
    }

    const dataDir = join(ctx.runDir, 'mcode-data');
    await mkdir(dataDir, { recursive: true });
    const config = join(dataDir, 'config.yaml');
    await writeFile(config, redirected(original, ctx.proxyUrl), 'utf8');

    return {
      command: 'mcode',
      args: [...ctx.userArgs],
      env: { MINIMAX_DATA_DIR: dataDir },
      tempFiles: [config],
    };
  },
};

/** Both spellings, because the bundle reads either and the operator may have set the other. */
function configPath(env: Record<string, string | undefined>): string {
  const dir = readEnv(env, 'MINIMAX_DATA_DIR') ?? readEnv(env, 'MAVIS_DATA_DIR');
  return dir !== undefined ? join(dir, 'config.yaml') : join(homedir(), '.minimax', 'config.yaml');
}

/**
 * A `key: value` line in the config, whatever YAML lets it look like.
 *
 * Review caught the first version of this, which was two anchored regexes requiring the value to
 * run to the end of the line: `apiKey: sk-live-… # rotate me` matched neither, so the live key was
 * written into the generated config while `baseURL` on another line still matched and the file was
 * written anyway. That file lands in the run directory and `capture.mjs` copies the whole run into
 * `capture/<model>/trace/` unscrubbed, so the key would have ridden out with the capture. The same
 * anchor missed the `api_key:` spelling.
 *
 * Matched by line and split in code rather than by one larger regex. Quoting, comments and a CRLF
 * line ending are three separate things to get right, and a regex that got all three would be
 * harder to read than the file it is parsing.
 */
/** A `baseURL` line in block style, which is the only shape this rewrite can move an origin in. */
const FIELD = /^([ \t]*)(baseURL|base[_-]url)([ \t]*:[ \t]*)([^\n]*)$/i;

/**
 * Every `apiKey`-ish and `baseURL`-ish field in the text, wherever YAML allows one to be written.
 *
 * Not anchored to the start of a line, which is the point. Review found that a line-anchored
 * rewrite left a key untouched in two shapes a config can legitimately use — a flow map,
 * `options: {apiKey: sk-live-…, baseURL: …}`, and a list item, `- apiKey: sk-live-…` — while
 * `hasOrigin` still said yes because another provider had an ordinary `baseURL`. The file was
 * written with those keys in it, into the run directory that `capture.mjs` copies into
 * `capture/<model>/trace/` unscrubbed.
 *
 * A value ends at whitespace or at a flow delimiter, so a trailing comment, a neighbouring entry
 * in a flow map and a closing brace are all left where they are.
 */
const ANY_KEY = /\bapi[_-]?key[ \t]*:[ \t]*(?:(['"])([^'"]*)\1|([^,}\]\s'"]+))/gi;
const ANY_BASE = /\bbase[_-]?url[ \t]*:[ \t]*(?:(['"])([^'"]*)\1|([^,}\]\s'"]+))/gi;

/** Every `api…key:` field, whether or not a value follows it on the same line. */
const KEY_FIELD = /\bapi[_-]?key[ \t]*:/gi;

/** `|` and `>` say the value is on the following lines, where no field pattern can reach it. */
const BLOCK_SCALAR = /^[|>][+-]?[0-9]*$/;

/** A YAML comment starts at ` #`; a bare `#` inside a URL is a fragment, not a comment. */
const COMMENT = /\s#/;

interface Value {
  value: string;
  quote: string;
  tail: string;
}

function splitValue(rest: string): Value {
  const quoted = /^(['"])([^'"]*)\1([\s\S]*)$/.exec(rest);
  if (quoted !== null) return { quote: quoted[1]!, value: quoted[2]!, tail: quoted[3]! };
  const at = rest.search(COMMENT);
  const head = at === -1 ? rest : rest.slice(0, at);
  const comment = at === -1 ? '' : rest.slice(at);
  // `\r` too, so a CRLF config does not leave the carriage return inside the value.
  const value = head.replace(/[ \t\r]+$/, '');
  return { quote: '', value, tail: head.slice(value.length) + comment };
}

function valuesOf(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => m[2] ?? m[3] ?? '');
}

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

function rewriteOrigin(line: string, section: string, proxyUrl: string): string {
  // A built-in provider's origin is MCode's to decide, and it takes it back on startup.
  if (section !== CUSTOM_SECTION) return line;
  const parts = FIELD.exec(line);
  if (parts === null) return line;
  const [, indent, name, separator, rest] = parts;
  const { value, quote, tail } = splitValue(rest!);
  if (value === '') return line;
  // `v1` when the decoder will not take this origin, matching what the env route falls back to.
  const moved = forwardOrProxyBase(proxyUrl, value);
  return `${indent}${name}${separator}${quote}${moved}${quote}${tail}`;
}

/** Every key replaced by the placeholder, in whatever shape it was written. */
function withoutKeys(config: string): string {
  return config.replace(ANY_KEY, (whole: string, quote?: string) => {
    const at = whole.indexOf(':');
    const q = quote ?? '';
    return `${whole.slice(0, at + 1)} ${q}${PLACEHOLDER_KEY}${q}`;
  });
}

/**
 * True when there is an origin in here this adapter can actually move.
 *
 * Review caught that asking only "is there a `baseURL` line" said yes to a stock install, where
 * the only ones belong to the built-in providers. The adapter then wrote a redirected config for a
 * run that records nothing — MCode restores those origins — and left a 14 MB copy of its data
 * directory inside the trace for it. A managed-login-only config now takes the untouched branch it
 * was always meant to take.
 */
export function hasOrigin(config: string): boolean {
  const sections = sectionsOf(config);
  return config.split('\n').some((line, i) => {
    if (sections[i] !== CUSTOM_SECTION) return false;
    const parts = FIELD.exec(line);
    return parts !== null && splitValue(parts[4]!).value !== '';
  });
}

/**
 * Whether the rewrite can be trusted with this config at all.
 *
 * A rewrite that cannot prove it did its job does not get written, and the three checks are what
 * that proof needs.
 *
 * Two are about keys, and both are made before the rewrite, because a key the scrub cannot see
 * is also a key a check on the result cannot see. Every field must carry its value on the same
 * line — `apiKey:` alone leaves it below as an indented scalar, which matched nothing and went
 * through whole — and no value may be a block scalar, whose `|` would be replaced while the key
 * stayed on the lines beneath a field that now reads as clean.
 *
 * The third reads the rewritten text: every origin inside `custom_provider:` must now point at
 * the proxy, or a provider orca claimed to redirect would still be talking to its real host,
 * uncaptured and unmentioned.
 *
 * The cost of refusing is an uncaptured run — the same untouched launch a config with no custom
 * provider gets — which is the side to fail on when the alternative is writing a credential down.
 */
export function rewriteIsTrustworthy(config: string, proxyUrl: string): boolean {
  const values = valuesOf(config, ANY_KEY);
  // Every field has to carry its value on the same line, or the scrub cannot reach it.
  // `apiKey:` alone puts the key on the next line as an indented scalar, which matched
  // nothing at all — neither the rewrite nor a check looking at what the rewrite left.
  if (values.length !== (config.match(KEY_FIELD) ?? []).length) return false;
  if (values.some((value) => BLOCK_SCALAR.test(value))) return false;
  const rewritten = redirected(config, proxyUrl);
  const sections = sectionsOf(rewritten);
  return rewritten
    .split('\n')
    .every(
      (line, i) =>
        sections[i] !== CUSTOM_SECTION ||
        valuesOf(line, ANY_BASE).every((value) => value === '' || value.startsWith(proxyUrl)),
    );
}

/**
 * The operator's config with every custom origin routed through the proxy and every key taken out.
 *
 * Rewritten as text rather than parsed and re-emitted. A YAML round-trip would reformat a file
 * orca did not write — comments, quoting, key order — and the only lines that need to change are
 * recognisable without understanding the rest.
 *
 * Each origin goes through `/forward/`, so the request arrives naming the destination it was taken
 * away from. Replacing it with orca's own default instead would point a recorded run at a host the
 * operator never named, which is worse than not capturing it.
 *
 * Every custom provider, not the first. With several configured, rewriting one leaves the rest
 * aimed at their real origins, and a run on one of those is simply missing from the trace.
 *
 * Keys come out of every section, built-in included, and by a pattern that does not care where on
 * the line the field sits. The file is written inside the run directory, and §7 says a credential
 * is never written there; `capture.mjs` then copies that directory into `capture/<model>/trace/`
 * unscrubbed, so a key left here would leave with the capture. Orca supplies the real one for the
 * origin it forwards to — that is what `orca setup` configures and what `upstreamHeaders` injects.
 * Without it the gateway answers 401, and the prompt is captured anyway: it travels in the
 * request, which orca records before the origin ever replies.
 *
 * What MCode writes back into this file on startup is its own: measured against a config whose
 * every key had been replaced by a distinct canary, it restored the built-in provider's `apiKey`
 * as the literal `sk-xxx` from its bundle, and no canary reached the run directory. The
 * credentials it would have had to read instead live in `<dataDir>/auth/`, which moves with
 * `MINIMAX_DATA_DIR` — the run's copy holds two lock files and nothing else.
 */
export function redirected(config: string, proxyUrl: string): string {
  const sections = sectionsOf(config);
  const moved = config
    .split('\n')
    .map((line, i) => rewriteOrigin(line, sections[i]!, proxyUrl))
    .join('\n');
  return withoutKeys(moved);
}
