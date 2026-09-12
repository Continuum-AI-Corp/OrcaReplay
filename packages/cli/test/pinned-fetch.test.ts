import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
EVERY REQUEST THAT CARRIES THE GATEWAY KEY IS PINNED TO THE HOST THE USER NAMED.

`resolveGateway` decides whether the key may go to a host, and `fetch` then
followed a `Location` anywhere — and undici strips `authorization` across
origins but NOT `x-api-key`, which `gatewayHeaders` sets to the same key. One
header from whoever answers for the gateway carried the credential to a host it
was never issued for.

The first fix pinned push and pull and left `probeModels` — the third request
carrying the very same header pair, reached by `orca setup` and `orca models` —
following redirects. That is the shape this fence exists for: the rule is about
a CREDENTIAL, and a fix applied at the two call sites that were reported is a
fix of the sites rather than of the rule.

So the fence scans for a bare `fetch(` anywhere outside `fetchPinned` itself. It
does not try to decide which calls carry the key — deciding that is exactly the
judgement that was wrong the first time, and a request that does NOT carry the
key loses nothing by being pinned.

AND THE FIRST VERSION OF THIS FENCE WAS ITSELF TOO NARROW, TWICE OVER
(orcacode-review). It walked `packages/cli/src` only, so the RECORDING PROXY —
handed the same credential as `upstreamHeaders`, attaching it to both of its
live call sites, on the path every `orca record` / `replay --loose` / `compare` /
fork takes — was never looked at. And even under the wider scope it would have
slipped through, because that call is an ALIAS: `const doFetch = options.fetchImpl ?? fetch`
writes no bare `fetch(` for a scan to find.

So the scope is now every package's `src`, and an alias assignment of the global
`fetch` is treated as a raw fetch in its own right. A fence that only looks where
the last bug was is not a fence.

THE ONE EXEMPTION IS BOUND TO THE CALL'S SHAPE, NOT TO ITS FILE NAME.
`refreshOpenCodeApiBases` cannot call `fetchPinned`: it is serialised with
`.toString()` into the OpenCode plugin orca emits (see `opencode-capture.ts`),
so an imported name would be a free variable in the generated module and throw
at run time rather than pin anything. It is exempt because of what the call IS,
not where it lives — a hard-coded public URL, `credentials: 'omit'`, and
`redirect: 'error'`, which refuses a redirect outright rather than following it.
EXEMPT_FETCHES asserts all three on the lines that follow the call, so the day
that file grows a second fetch, or this one starts carrying a credential or
following redirects, the fence reports it. Each entry must also still MATCH:
an exemption that has stopped covering anything is a hole waiting for the next
line to fall into, so it fails rather than sitting there looking satisfied.
*/
describe('gateway requests', () => {
  async function tsFilesUnder(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await tsFilesUnder(path)));
      else if (entry.name.endsWith('.ts')) out.push(path);
    }
    return out;
  }

  it('are all pinned: no bare fetch( survives outside fetchPinned', async () => {
    // EVERY package, not just this one: the credential travels to the proxy.
    const packages = join(import.meta.dirname, '..', '..');
    const files: string[] = [];
    for (const pkg of await readdir(packages, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = join(packages, pkg.name, 'src');
      if (!(await stat(src).catch(() => undefined))?.isDirectory()) continue;
      files.push(...(await tsFilesUnder(src)));
    }
    expect(files.length, 'the scan found no sources, so it proves nothing').toBeGreaterThan(50);

    // file -> why it may hold a raw fetch, and the shape that earns it.
    // `requires` is checked against the call line and the few lines after it,
    // which is where a fetch's init object is written.
    const EXEMPT_FETCHES = [
      {
        file: join('adapters', 'src', 'opencode-catalog.ts'),
        why: 'serialised into the emitted OpenCode plugin, so it cannot import fetchPinned',
        requires: [
          /https:\/\/models\.opencode\.ai\//,
          /credentials:\s*'omit'/,
          /redirect:\s*'error'/,
        ],
      },
    ];
    const exemptionUsed = new Map(EXEMPT_FETCHES.map((e) => [e.file, false]));

    const offenders: string[] = [];
    let sawDefinition = false;

    for (const file of files) {
      const src = await readFile(file, 'utf8');
      const lines = src.split('\n');
      // fetchPinned's own body holds the ONE raw fetch this codebase may have.
      // Skipping it by name would also skip any other call on the same line, so
      // the exemption is the function's SPAN: from its declaration to the next
      // closing brace in column 0.
      let insideFetchPinned = false;
      for (const [i, line] of lines.entries()) {
        if (/export async function fetchPinned/.test(line)) {
          sawDefinition = true;
          insideFetchPinned = true;
          continue;
        }
        if (insideFetchPinned) {
          if (/^\}/.test(line)) insideFetchPinned = false;
          continue;
        }
        // Strip line comments and jsdoc bodies, so the prose EXPLAINING the
        // rule is not reported as a violation of it.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        // `fetch(` not preceded by an identifier character, so `prefetch(` and
        // `fetchPinned(` do not match.
        const called = /(^|[^A-Za-z0-9_.])fetch\s*\(/.test(code);
        // AND AN ALIAS IS A CALL. `const doFetch = options.fetchImpl ?? fetch`
        // is how the proxy escaped the first version of this fence: it binds
        // the global and calls it under another name, so nothing matches
        // `fetch(` at all. Any assignment whose right-hand side ENDS in the
        // bare identifier `fetch` is the same thing.
        const aliased = /(=|\?\?)\s*fetch\s*(;|,|\)|$)/.test(code);
        if (called || aliased) {
          const exempt = EXEMPT_FETCHES.find(
            (e) =>
              file.endsWith(e.file) &&
              e.requires.every((re) => re.test(lines.slice(i, i + 6).join('\n'))),
          );
          if (exempt) {
            exemptionUsed.set(exempt.file, true);
            continue;
          }
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    // The scan must still be able to find the one legitimate raw fetch, or it
    // has stopped looking at anything.
    expect(sawDefinition, 'fetchPinned was not found; this scan is no longer anchored').toBe(true);

    // An exemption that matches nothing is not harmless: it stays behind as a
    // standing permission for whatever that file is rewritten into next.
    for (const [file, used] of exemptionUsed) {
      expect(used, `EXEMPT_FETCHES still lists ${file}, but nothing there matched it`).toBe(true);
    }

    expect(
      offenders,
      'every request that can carry the gateway key must go through fetchPinned, or a redirect ' +
        'hands the key to whatever answers:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
