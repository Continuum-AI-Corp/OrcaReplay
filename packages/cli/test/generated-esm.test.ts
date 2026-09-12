import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_DIRS = [
  here,
  join(here, '..', '..', 'core', 'test'),
  join(here, '..', '..', 'adapters', 'test'),
  join(here, '..', '..', 'proxy', 'test'),
  join(here, '..', '..', 'fs-capture', 'test'),
];

/**
 * A path written into generated ESM has to be a `file://` URL.
 *
 * Node's loader accepts only `file:`, `data:` and `node:` specifiers, and on Windows a bare
 * absolute path is neither — `ERR_UNSUPPORTED_ESM_URL_SCHEME`. So the module never loads, the child
 * dies before its first statement, and the test that spawned it reports whatever follows from
 * nothing having run.
 *
 * That last part is why this is worth a guard of its own rather than a note. Eight tests failed
 * this way on Windows for as long as anyone had been running them there, and every one of them
 * reported a *count*:
 *
 *     expected 1 to be +0
 *     expected [] to have a length of 1
 *
 * Nothing in those messages points at a loader error, so the failures read as a capture bug on
 * Windows and sat unexplained. `pathToFileURL` was already the convention elsewhere in the
 * repository; two places had simply not used it.
 */
describe('a path written into generated ESM is a file:// URL', () => {
  /** Every `.test.ts` we can reach, since the hazard is not specific to one package. */
  async function testFiles(): Promise<string[]> {
    const found: string[] = [];
    for (const dir of TEST_DIRS) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.test.ts')) found.push(join(dir, e.name));
      }
    }
    return found;
  }

  it('is true of every import specifier a test writes into a module', async () => {
    const offenders: string[] = [];
    for (const file of await testFiles()) {
      // This file's own samples are the shape being guarded against, on purpose.
      if (file.endsWith('generated-esm.test.ts')) continue;
      const source = await readFile(file, 'utf8');
      // An `import ... from` inside a template literal, whose specifier is an interpolation.
      for (const m of source.matchAll(/import[^\n`]*?from\s*['"]?\$\{([^}]+)\}/g)) {
        const expr = m[1]!;
        // `pathToFileURL(...).href` inline is one fix; the other is a constant that already holds
        // a URL, which reads here as a bare identifier. Resolve those against their declaration
        // rather than reporting a name — otherwise the guard flags the very fix it asks for.
        if (/pathToFileURL|\.href|file:\/\//.test(expr)) continue;
        const named = /^(?:JSON\.stringify\()?\s*([A-Za-z_$][\w$]*)\s*\)?$/.exec(expr.trim());
        if (named !== null) {
          const decl = new RegExp(`const ${named[1]}\\s*=([^;]*);`).exec(source);
          if (decl !== null && /pathToFileURL|\.href|file:\/\//.test(decl[1]!)) continue;
        }
        offenders.push(`${file.split(/[\\/]/).pop()}: \${${expr.slice(0, 60)}}`);
      }
    }
    expect(
      offenders,
      'these write a bare path as an ESM specifier, which Windows rejects outright',
    ).toEqual([]);
  });

  it('catches the shape it is written for', async () => {
    // The guard is only worth having if it would have caught the original. Both real occurrences
    // looked like one of these.
    const bad = [
      "`import { Orca } from '${join(here, 'dist', 'api.js')}';`",
      'const s = `import { x } from ${JSON.stringify(SOME_PATH)};`',
    ];
    for (const sample of bad) {
      const hits = [...sample.matchAll(/import[^\n`]*?from\s*['"]?\$\{([^}]+)\}/g)];
      expect(hits.length, sample).toBe(1);
      expect(/pathToFileURL|\.href/.test(hits[0]![1]!)).toBe(false);
    }
  });
});
