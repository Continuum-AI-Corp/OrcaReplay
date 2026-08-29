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
      '@orcareplay/mcp-shim': pkg('mcp-shim'),
      '@orcareplay/shell-shim': pkg('shell-shim'),
      '@orcareplay/viewer': pkg('viewer'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
