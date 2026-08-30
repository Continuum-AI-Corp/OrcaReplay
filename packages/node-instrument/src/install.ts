import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Getting the fetch hook into an agent that is not ours.
 *
 * The hook is written out as one self-contained CommonJS file rather than imported from this
 * package, and that is not a style choice: it runs inside the *agent's* process, which resolves
 * `require` against its own dependency tree. A `require('@orcareplay/node-instrument')` in there
 * throws before the agent's first line and takes the whole run with it. The shell shim and the
 * MCP config rewrite already work this way for the same reason.
 *
 * `--require` rather than `--import` because `--import` landed in Node 20.6 and the CLI supports
 * Node 20.0. A CommonJS preload runs before an ESM entry point just as well, and `globalThis.fetch`
 * is already there to patch by the time it does.
 */

export const HOOK_FILENAME = 'orca-fetch-hook.cjs';

/**
 * The hook's source.
 *
 * Configured entirely from the environment, so the bytes are identical on every run — replay
 * prepares the same launch as the recording, and a hook that varied would read as a divergence.
 * Everything is wrapped so that no failure inside it can reach the agent: a capture layer that
 * breaks the run it is capturing is worse than one that captures nothing.
 */
const HOOK_SOURCE = `'use strict';
/**
 * OrcaReplay fetch hook — written by \`orca record\`, deleted with the run directory.
 *
 * Some agents never read a base-URL variable. The Vercel AI SDK is the common one: \`@ai-sdk/openai\`
 * takes its origin as a constructor argument only, so redirecting the environment captures nothing
 * and the run still looks like a success. This redirects at the one place every such agent does
 * agree on — \`globalThis.fetch\` — and only for an allowlist of provider hosts.
 */
(function () {
  var proxy = process.env.ORCA_PROXY_URL || '';
  if (!proxy || typeof globalThis.fetch !== 'function') return;
  if (globalThis.__orcaFetchHooked) return;

  var hosts = (process.env.ORCA_INSTRUMENT_HOSTS || 'api.openai.com,api.anthropic.com')
    .split(',')
    .map(function (h) { return h.trim().toLowerCase(); })
    .filter(Boolean);

  function hostMatches(hostname, pattern) {
    if (pattern.slice(0, 2) === '*.') {
      var parent = pattern.slice(2);
      // A label boundary is part of the comparison. A bare \`endsWith\` is what lets
      // \`api.openai.com.attacker.test\` through.
      return hostname.length > parent.length + 1 && hostname.slice(-(parent.length + 1)) === '.' + parent;
    }
    return hostname === pattern;
  }

  function rewrite(raw) {
    var target, base;
    try { target = new URL(raw); base = new URL(proxy); } catch (e) { return undefined; }
    if (target.host === base.host) return undefined;
    var name = target.hostname.toLowerCase();
    for (var i = 0; i < hosts.length; i += 1) {
      if (hostMatches(name, hosts[i])) {
        return base.origin + base.pathname.replace(/\\/+$/, '') + target.pathname + target.search;
      }
    }
    return undefined;
  }

  var original = globalThis.fetch;
  globalThis.fetch = function orcaFetch(input, init) {
    try {
      if (typeof input === 'string' || input instanceof URL) {
        var next = rewrite(String(input));
        if (next) return original.call(this, next, init);
      } else if (input && typeof input === 'object' && typeof input.url === 'string') {
        var moved = rewrite(input.url);
        // Rebuilding from the original Request copies method, headers and body; the SDKs that
        // hand fetch a Request rather than a string are exactly the ones this exists for.
        if (moved) return original.call(this, new Request(moved, input), init);
      }
    } catch (e) {
      // Fall through and let the agent's own call proceed untouched.
    }
    return original.call(this, input, init);
  };
  globalThis.__orcaFetchHooked = true;
})();
`;

/** Write the hook into `dir` and return its path. Idempotent, and identical on every call. */
export async function writeFetchHook(dir: string): Promise<string> {
  const path = join(dir, HOOK_FILENAME);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, HOOK_SOURCE, { mode: 0o600 });
  return path;
}

/**
 * `NODE_OPTIONS` with the hook added, preserving whatever the user already had there.
 *
 * Quoted, because NODE_OPTIONS is split on whitespace and a macOS home directory routinely has a
 * space in it — an unquoted path there makes node reject the whole variable and the agent never
 * starts.
 */
export function nodeOptionsWithHook(hookPath: string, existing: string | undefined): string {
  const quoted = hookPath.includes(' ') ? `"${hookPath}"` : hookPath;
  const current = existing ?? '';
  if (current.includes(quoted)) return current;
  const flag = `--require ${quoted}`;
  return current === '' ? flag : `${current} ${flag}`;
}
