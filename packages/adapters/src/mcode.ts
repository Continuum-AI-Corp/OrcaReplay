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
    if (original === undefined || !hasOrigin(original)) {
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
const FIELD = /^([ \t]*)(baseURL|base[_-]url|apiKey|api[_-]key)([ \t]*:[ \t]*)([^\n]*)$/i;

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

function rewriteField(line: string, proxyUrl: string): string {
  const parts = FIELD.exec(line);
  if (parts === null) return line;
  const [, indent, name, separator, rest] = parts;
  const { value, quote, tail } = splitValue(rest!);
  if (value === '') return line;
  const replaced = /key$/i.test(name!)
    ? PLACEHOLDER_KEY
    : // `v1` when the decoder will not take this origin, matching what the env route falls back to.
      forwardOrProxyBase(proxyUrl, value);
  return `${indent}${name}${separator}${quote}${replaced}${quote}${tail}`;
}

/** True when there is at least one origin in here for the redirect to move. */
export function hasOrigin(config: string): boolean {
  return config.split('\n').some((line) => {
    const parts = FIELD.exec(line);
    return parts !== null && !/key$/i.test(parts[2]!) && splitValue(parts[4]!).value !== '';
  });
}

/**
 * The operator's config with every origin routed through the proxy and every key taken out.
 *
 * Rewritten as text rather than parsed and re-emitted. A YAML round-trip would reformat a file
 * orca did not write — comments, quoting, key order — and the only lines that need to change are
 * recognisable without understanding the rest.
 *
 * Each origin goes through `/forward/`, so the request arrives naming the destination it was taken
 * away from. Replacing it with orca's own default instead would point a recorded run at a host the
 * operator never named, which is worse than not capturing it.
 *
 * Every provider, not the first. With several configured, rewriting one leaves the rest aimed at
 * their real origins, and a run on one of those is simply missing from the trace.
 *
 * The key becomes the placeholder because this file is written inside the run directory, and §7
 * says a credential is never written down there. `capture.mjs` copies that whole directory into
 * `capture/<model>/trace/` without scrubbing it, so a key left here leaves with the capture. Orca
 * supplies the real one for the origin it forwards to — that is what `orca setup` configures and
 * what `upstreamHeaders` injects. Without it the gateway answers 401, and the prompt is captured
 * anyway: it travels in the request, which orca records before the origin ever replies.
 */
export function redirected(config: string, proxyUrl: string): string {
  return config
    .split('\n')
    .map((line) => rewriteField(line, proxyUrl))
    .join('\n');
}
