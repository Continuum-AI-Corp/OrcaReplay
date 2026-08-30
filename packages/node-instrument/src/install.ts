import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_INSTRUMENTED_HOSTS, hostMatches, rewriteUrl } from './rewrite.js';

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
/**
 * The hook's source.
 *
 * Built from the *real* matcher rather than a copy of it. `rewrite.ts` documents itself as this
 * package's security boundary and `rewrite.test.ts` is the only thing that tests it — but the hook
 * that actually runs inside the agent cannot import it, so it carried a second, hand-written
 * matcher. Two implementations of an allowlist, one of them tested and neither of them the other:
 * a future fix to `rewrite.ts` would have gone green while changing nothing that runs.
 *
 * So the functions are serialised into the file. They are written to be self-contained for exactly
 * this reason — no imports, no closure, nothing TypeScript-only left after compilation — and a test
 * asserts the emitted source still contains them, so the two cannot drift apart again.
 *
 * Configured entirely from the environment, so the bytes are identical on every run: replay
 * prepares the same launch as the recording, and a hook that varied would read as a divergence.
 */
const HOOK_SOURCE = `'use strict';
/**
 * OrcaReplay fetch hook — written by \`orca record\`, deleted with the run directory.
 *
 * Some agents never read a base-URL variable. The Vercel AI SDK is the common one: \`@ai-sdk/openai\`
 * takes its origin as a constructor argument only, so redirecting the environment captures nothing
 * and the run still looks like a success. This redirects at the one place every such agent does
 * agree on — \`globalThis.fetch\` — and only for an allowlist of provider hosts.
 *
 * The two functions below are the instrument package's own, serialised in verbatim — this file
 * imports nothing, because it loads inside an agent that has never heard of us.
 */
(function () {
  var proxy = process.env.ORCA_PROXY_URL || '';
  if (!proxy || typeof globalThis.fetch !== 'function') return;
  if (globalThis.__orcaFetchHooked) return;

  ${hostMatches.toString()}

  ${rewriteUrl.toString()}

  var config = {
    proxyUrl: proxy,
    hosts: (process.env.ORCA_INSTRUMENT_HOSTS || ${JSON.stringify(DEFAULT_INSTRUMENTED_HOSTS.join(','))})
      .split(',')
      .map(function (h) { return h.trim(); })
      .filter(Boolean),
  };

  var original = globalThis.fetch;
  globalThis.fetch = function orcaFetch(input, init) {
    try {
      if (typeof input === 'string' || input instanceof URL) {
        var next = rewriteUrl(String(input), config);
        if (next) return original.call(this, next, init);
      } else if (input && typeof input === 'object' && typeof input.url === 'string') {
        var moved = rewriteUrl(input.url, config);
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
