import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * What OpenCode's own configuration says about a provider's base URL.
 *
 * The adapter redirects OpenCode's first-party providers through the proxy by writing a
 * `provider.<id>.options.baseURL` override, and OpenCode merges config sources in an order that
 * puts that override last — over a base URL the user configured for the same provider. Overriding
 * someone's deliberate routing would make the recorded run talk to a host they never named, which
 * is the one capture bug worse than an empty trace. So the adapter reads the same files OpenCode
 * reads and carries the configured base URL *through* the redirect instead of replacing it.
 *
 * The files are JSONC — comments and trailing commas are allowed and the user's own config uses
 * both — so a small stripper runs before `JSON.parse`. A file that still will not parse marks the
 * whole scan untrusted: without knowing what the user intended, the adapter must not touch their
 * routing at all, and the run degrades to the pre-override behaviour (uncaptured, with the
 * end-of-run warning saying so) rather than to a captured run aimed at the wrong origin.
 */

export interface OpenCodeConfigScan {
  /** Provider id → the `options.baseURL` the user configured, when they configured one. */
  overrides: Map<string, string>;
  /** False when a config file existed but could not be parsed, so no override can be trusted. */
  trusted: boolean;
}

/**
 * Strip what JSONC allows and JSON does not: comments and trailing commas.
 *
 * Strings are copied verbatim with their escapes, because a config comment is prose that may
 * contain `//` — a URL, say — and stripping inside a string would corrupt the value while the
 * file still parsed. Trailing commas are removed only when the next significant character closes
 * a value, which a comma inside a string never is.
 */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return stripTrailingCommas(out);
}

/** Index just past the closing quote of the string starting at `start`, or end of input. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i += 1;
  }
  return text.length;
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ',') {
      let look = i + 1;
      while (look < text.length && /\s/.test(text[look]!)) look += 1;
      const next = text[look];
      if (next === '}' || next === ']') {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Every `provider.<id>.options.baseURL` in one parsed config. */
function providerBaseURLs(config: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return out;
  const provider = (config as Record<string, unknown>)['provider'];
  if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) return out;
  for (const [id, entry] of Object.entries(provider as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const options = (entry as Record<string, unknown>)['options'];
    if (options === null || typeof options !== 'object' || Array.isArray(options)) continue;
    const baseURL = (options as Record<string, unknown>)['baseURL'];
    if (typeof baseURL === 'string' && baseURL.trim() !== '') out.set(id, baseURL.trim());
  }
  return out;
}

/**
 * The config files OpenCode reads that could set a provider base URL.
 *
 * Global, then `OPENCODE_CONFIG`, then project-level `.opencode` directories walking up the way
 * OpenCode's own loader walks — bounded at the git root or the home directory, because above
 * those, neither OpenCode nor anyone else looks. Order does not matter here: the scan collects
 * every override it can see, and a later source winning the merge is the same override either way.
 */
async function openCodeConfigFiles(
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<string[]> {
  const files: string[] = [];
  const globalDir =
    readEnvValue(env, 'OPENCODE_CONFIG_DIR') ??
    (readEnvValue(env, 'XDG_CONFIG_HOME') !== undefined
      ? join(readEnvValue(env, 'XDG_CONFIG_HOME')!, 'opencode')
      : join(homeOf(env), '.config', 'opencode'));
  for (const file of ['config.json', 'opencode.json', 'opencode.jsonc']) {
    files.push(join(globalDir, file));
  }

  const custom = readEnvValue(env, 'OPENCODE_CONFIG');
  if (custom !== undefined) files.push(custom);

  const stop = new Set([homeOf(env)]);
  let at = cwd;
  for (let depth = 0; depth < 64; depth += 1) {
    for (const file of ['opencode.json', 'opencode.jsonc']) {
      files.push(join(at, '.opencode', file));
    }
    if (stop.has(at)) break;
    if (await isDirectory(join(at, '.git'))) break;
    const parent = at.slice(0, at.lastIndexOf('/'));
    if (parent === '' || parent === at) break;
    at = parent;
  }
  return files;
}

function homeOf(env: Record<string, string | undefined>): string {
  return readEnvValue(env, 'HOME') ?? homedir();
}

function readEnvValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value !== '' ? value : undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read the base URLs the user's OpenCode configuration sets per provider.
 *
 * A missing file is not a failure — most of these do not exist. A file that exists and will not
 * parse is: the adapter then knows less than it must to rewrite routing safely, and reports that
 * by clearing `trusted`.
 */
export async function openCodeConfiguredBaseURLs(
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<OpenCodeConfigScan> {
  const overrides = new Map<string, string>();
  let trusted = true;
  for (const file of await openCodeConfigFiles(env, cwd)) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (text.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonc(text));
    } catch {
      trusted = false;
      continue;
    }
    for (const [id, url] of providerBaseURLs(parsed)) overrides.set(id, url);
  }
  return { overrides, trusted };
}
