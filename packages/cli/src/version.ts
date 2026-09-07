import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Read from the manifest rather than restating it.
 *
 * This was a hardcoded constant, and `npm version --workspaces` does not touch source, so 0.2.0
 * shipped reporting 0.1.2 — from `--version`, from the MCP server's `serverInfo`, and into
 * `manifest.orca_version` on every trace it wrote. A recording that misreports the version that
 * produced it is a provenance bug, not a cosmetic one.
 *
 * `../package.json` resolves the same way in all three places this is loaded from:
 * `dist/version.js` in the published package, `dist/version.js` in the repo, and `src/version.ts`
 * under vitest — each is exactly one directory below `packages/cli/package.json`, and npm always
 * ships the manifest.
 */
const manifest = fileURLToPath(new URL('../package.json', import.meta.url));

export const ORCA_VERSION: string = (
  JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }
).version;
