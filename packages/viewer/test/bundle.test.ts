import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { bundleViewerScript } from '../src/bundle.js';
import { CLIENT_SOURCE } from '../src/client/main.js';
import { renderTraceHtml } from '../src/html.js';
import { manifest } from './fixtures.js';

describe('bundleViewerScript', () => {
  it('produces a smaller script than the readable source', async () => {
    const bundled = await bundleViewerScript();
    expect(bundled.length).toBeGreaterThan(200);
    expect(bundled.length).toBeLessThan(CLIENT_SOURCE.length);
  });

  it('produces a single IIFE with no imports of any kind', async () => {
    const bundled = await bundleViewerScript();
    expect(bundled).not.toMatch(/\bimport\s/);
    expect(bundled).not.toMatch(/\brequire\(/);
    expect(bundled).not.toMatch(/\bexport\s/);
    expect(bundled.trimStart().startsWith('(')).toBe(true);
  });

  it('is parseable JavaScript', async () => {
    const bundled = await bundleViewerScript();
    expect(() => new Script(bundled)).not.toThrow();
  });

  it('keeps the behaviour: minification mangles names but not the DOM contract', async () => {
    const bundled = await bundleViewerScript();
    for (const marker of ['orca-filter', 'orca-theme', 'aria-selected', 'ArrowDown', '.row']) {
      expect(bundled).toContain(marker);
    }
  });

  it('can be inlined by renderTraceHtml in place of the readable source', async () => {
    const bundled = await bundleViewerScript();
    const html = renderTraceHtml({ manifest: manifest(), events: [] }, { script: bundled });
    expect((html.match(/<script/gi) ?? []).length).toBe(1);
    expect(html).toContain(bundled);
  });
});
