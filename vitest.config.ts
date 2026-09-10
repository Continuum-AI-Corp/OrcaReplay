import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source, not built output, so `npx vitest` needs no prior `tsc --build`.
    // CONTRIBUTING promises a five-minute dev loop; a mandatory build step is how that promise
    // quietly becomes twenty.
    alias: {
      '@orcareplay/schema': pkg('schema'),
      '@orcareplay/plugin-api': pkg('plugin-api'),
      '@orcareplay/core': pkg('core'),
      '@orcareplay/fs-capture': pkg('fs-capture'),
      '@orcareplay/providers': pkg('providers'),
      '@orcareplay/proxy': pkg('proxy'),
      '@orcareplay/adapters': pkg('adapters'),
      '@orcareplay/node-instrument': pkg('node-instrument'),
      '@orcareplay/mcp-shim': pkg('mcp-shim'),
      '@orcareplay/shell-shim': pkg('shell-shim'),
      '@orcareplay/viewer': pkg('viewer'),
    },
  },
  test: {
    // `scripts/` too, because the release scripts are code with no package to live in, and a test
    // that is never collected is worse than no test: `set-version.test.ts` guards an edit that is
    // permanent on npm if it goes wrong, and would have sat here green and unrun.
    include: ['packages/*/test/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
