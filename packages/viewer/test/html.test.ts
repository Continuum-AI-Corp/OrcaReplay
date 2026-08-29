import { beforeEach, describe, expect, it } from 'vitest';
import { escapeHtml, renderTraceHtml } from '../src/html.js';
import { VIEWER_CSS } from '../src/css.js';
import { CLIENT_SOURCE } from '../src/client/main.js';
import { ev, manifest, resetSeq, snap } from './fixtures.js';

beforeEach(() => resetSeq());

/** Read the balanced `{ ... }` block that follows `selector` in a stylesheet. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', at + selector.length);
  if (open < 0) throw new Error(`no block for: ${selector}`);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block for: ${selector}`);
}

function customProps(block: string): string[] {
  return [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!).sort();
}

const basic = () =>
  renderTraceHtml({
    manifest: manifest(),
    events: [
      ev({ type: 'run.start', attrs: { adapter: 'claude-code' } }),
      ev({ type: 'model.request', attrs: { model: 'opus', messages: 2 } }),
      ev({ type: 'run.end', attrs: { exit_code: 0 } }),
    ],
  });

/**
 * A trace is untrusted input: it is produced on someone else's machine, attached to an issue,
 * and opened by a stranger. Every byte of it must reach the page as text and nothing else.
 */
describe('escaping untrusted trace content', () => {
  const IMG = '<img src=x onerror=alert(1)>';
  const BREAKOUT = '</script><script>alert(1)</script>';

  const hostile = () =>
    renderTraceHtml({
      manifest: manifest({ run_id: IMG, adapter: { id: BREAKOUT } }),
      events: [
        ev({ type: 'tool.call', attrs: { name: IMG, id: BREAKOUT, note: `"${IMG}"` } }),
        ev({ type: 'error', attrs: { message: BREAKOUT }, payload: { evil: IMG } }),
        ev({
          type: 'shell.exec',
          attrs: { command: IMG },
          payload: { $blob: 'sha256:aa', bytes: 12 },
        }),
        ev({ type: 'note', attrs: { text: "' onmouseover='alert(1)" } }),
      ],
      blobs: { 'sha256:aa': `${IMG}\n${BREAKOUT}` },
    });

  it('never emits a raw tag from trace content', () => {
    const html = hostile();
    expect(html).not.toContain(IMG);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('alert(1)</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('leaves exactly one script element in the document', () => {
    const html = hostile();
    expect((html.match(/<script/gi) ?? []).length).toBe(1);
    expect((html.match(/<\/script/gi) ?? []).length).toBe(1);
    expect((html.match(/<style/gi) ?? []).length).toBe(1);
  });

  it('emits no element carrying an inline event handler attribute', () => {
    expect(hostile()).not.toMatch(/<[a-zA-Z][^>]*\son[a-z]+\s*=/);
  });

  it('cannot be broken out of an attribute value', () => {
    const html = hostile();
    expect(html).not.toContain(`"${IMG}"`);
    expect(html).not.toContain("' onmouseover='");
    expect(html).toContain('&#39;');
  });

  it('escapes blob content rendered into a detail pane', () => {
    const html = hostile();
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('never interpolates trace content into the script element', () => {
    const html = hostile();
    const script = html.slice(html.indexOf('<script'), html.indexOf('</script>'));
    expect(script).not.toContain('alert');
    expect(script).not.toContain('sha256');
  });

  it('escapes the five dangerous characters and nothing else', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    expect(escapeHtml('plain text 1 + 1')).toBe('plain text 1 + 1');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

/** The defining constraint: one file, opened from file://, with no network. */
describe('single-file constraint', () => {
  it('references no external resource from any src or href', () => {
    const html = renderTraceHtml({
      manifest: manifest(),
      events: [ev({ type: 'net.request', attrs: { url: 'https://api.example.com/v1' } })],
    });
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).not.toMatch(/^(?:[a-z]+:)?\/\//i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//i);
  });

  it('contains no absolute URL at all when the trace contains none', () => {
    expect(basic()).not.toContain('://');
  });

  it('loads no font over the network', () => {
    expect(VIEWER_CSS).not.toMatch(/@font-face/i);
    expect(VIEWER_CSS).toMatch(/ui-monospace/);
    expect(VIEWER_CSS).toMatch(/system-ui/);
  });

  it('makes no network call and builds no markup from strings at runtime', () => {
    for (const forbidden of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'fetch(',
      'XMLHttpRequest',
      'import(',
    ]) {
      expect(CLIENT_SOURCE).not.toContain(forbidden);
    }
  });
});

describe('theme tokens', () => {
  const LIGHT = ':root {';
  const DARK_MEDIA = ':root:not([data-theme="light"])';
  const DARK_ATTR = ':root[data-theme="dark"]';

  it('defines an identical token set in all three theme blocks', () => {
    const light = customProps(ruleBody(VIEWER_CSS, LIGHT));
    const darkMedia = customProps(ruleBody(VIEWER_CSS, DARK_MEDIA));
    const darkAttr = customProps(ruleBody(VIEWER_CSS, DARK_ATTR));
    expect(light.length).toBeGreaterThan(8);
    expect(darkMedia).toEqual(light);
    expect(darkAttr).toEqual(light);
  });

  it('puts the dark media block behind the data-theme="light" escape hatch', () => {
    expect(VIEWER_CSS).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(VIEWER_CSS).toContain(DARK_MEDIA);
  });

  it('gives the two dark blocks identical values so the toggle cannot disagree', () => {
    const pairs = (block: string) =>
      [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)]
        .map((m) => `${m[1]}:${m[2]!.trim()}`)
        .sort();
    expect(pairs(ruleBody(VIEWER_CSS, DARK_ATTR))).toEqual(
      pairs(ruleBody(VIEWER_CSS, DARK_MEDIA)),
    );
  });

  it('paints the body ground explicitly rather than borrowing the host', () => {
    expect(ruleBody(VIEWER_CSS, 'body {')).toMatch(/background:\s*var\(--ground\)/);
  });

  it('carries the terminal band tokens unchanged in every theme', () => {
    for (const selector of [LIGHT, DARK_MEDIA, DARK_ATTR]) {
      expect(ruleBody(VIEWER_CSS, selector)).toMatch(/--band:\s*#08090A/i);
    }
  });
});

/** Monochrome, counter-shaded, state carried by form. Hue survives no screenshot. */
describe('design system', () => {
  it('uses no accent hue: every colour is within a hair of neutral', () => {
    const hexes = [...VIEWER_CSS.matchAll(/#([0-9a-f]{6})\b/gi)].map((m) => m[1]!);
    expect(hexes.length).toBeGreaterThan(10);
    for (const hex of hexes) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(14);
    }
  });

  it('uses hairlines and no shadows or soft corners', () => {
    expect(VIEWER_CSS).not.toMatch(/box-shadow/);
    for (const m of VIEWER_CSS.matchAll(/border-radius:\s*([\d.]+)px/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(3);
    }
  });

  it('carries state by fill and hairline, not by colour', () => {
    expect(ruleBody(VIEWER_CSS, '.chip.attention {')).toMatch(/background:\s*var\(--ink\)/);
    expect(ruleBody(VIEWER_CSS, '.chip.normal {')).toMatch(/border:\s*1px solid var\(--rule-2\)/);
  });

  it('respects prefers-reduced-motion', () => {
    expect(VIEWER_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('keeps wide content in its own horizontal scroller', () => {
    expect(ruleBody(VIEWER_CSS, '.scroll {')).toMatch(/overflow-x:\s*auto/);
  });
});

describe('document structure', () => {
  it('is a complete standalone document', () => {
    const html = basic();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('name="viewport"');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('titles the document with the run id', () => {
    expect(basic()).toContain('<title>run_abc123 · OrcaReplay</title>');
  });

  it('ends with the exact footer line', () => {
    expect(basic()).toContain('Recorded with OrcaReplay · npx orcareplay');
    expect(basic()).not.toMatch(/<img|<svg/i);
  });

  it('renders one tab and one tabpanel per event, wired together', () => {
    const html = basic();
    expect((html.match(/role="tab"/g) ?? []).length).toBe(3);
    expect((html.match(/role="tabpanel"/g) ?? []).length).toBe(3);
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-controls="orca-pane-0"');
    expect(html).toContain('aria-labelledby="orca-row-0"');
    expect((html.match(/<button/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('shows the run summary in the band', () => {
    const html = renderTraceHtml({
      manifest: manifest({ integrity: { events_sha256: 'x', blob_count: 2 } }),
      events: [
        ev({ type: 'run.start' }),
        ev({
          type: 'model.response',
          turn: 1,
          attrs: { usage: { input_tokens: 8412, output_tokens: 120 } },
        }),
      ],
    });
    expect(html).toContain('run_abc123');
    expect(html).toContain('claude-code@1.4.0');
    expect(html).toContain('8,412');
    expect(html).toContain('>2<');
  });

  it('renders an empty trace without breaking', () => {
    const html = renderTraceHtml({ manifest: manifest(), events: [] });
    expect(html).toContain('no events');
    expect((html.match(/role="tab"/g) ?? []).length).toBe(0);
    expect(html).toContain('Recorded with OrcaReplay');
  });

  it('surfaces loop findings from the derived analyzer', () => {
    const html = renderTraceHtml({
      manifest: manifest(),
      events: [snap(0, 'tree_b'), snap(1, 'tree_b'), snap(2, 'tree_b')],
    });
    expect(html).toContain('LOOP');
    expect(html).toContain('tree_b');
    expect(html).toMatch(/turns 0.{1,3}2/);
  });
});

describe('detail panes', () => {
  it('inlines blob content when it is provided', () => {
    const html = renderTraceHtml({
      manifest: manifest(),
      events: [ev({ type: 'tool.result', payload: { $blob: 'sha256:beef', bytes: 9 } })],
      blobs: { 'sha256:beef': 'hello you' },
    });
    expect(html).toContain('hello you');
    expect(html).not.toContain('payload omitted');
  });

  it('shows a placeholder when a blob was not inlined', () => {
    const html = renderTraceHtml({
      manifest: manifest(),
      events: [ev({ type: 'tool.result', payload: { $blob: 'sha256:beef', bytes: 20481 } })],
    });
    expect(html).toContain('payload omitted, 20481 bytes');
  });

  it('pretty-prints an inline payload and lists attrs, causes and redactions', () => {
    const html = renderTraceHtml({
      manifest: manifest(),
      events: [
        ev({ type: 'run.start' }),
        ev({
          type: 'model.request',
          causes: [0],
          redacted: ['authorization'],
          attrs: { model: 'opus', nested: { a: 1 } },
          payload: { messages: [{ role: 'user' }] },
        }),
      ],
    });
    expect(html).toContain('&quot;role&quot;: &quot;user&quot;');
    expect(html).toContain('authorization');
    expect(html).toContain('opus');
  });

  it('truncates a huge payload rather than shipping it whole', () => {
    const html = renderTraceHtml(
      {
        manifest: manifest(),
        events: [ev({ type: 'tool.result', payload: { $blob: 'sha256:big', bytes: 5000 } })],
        blobs: { 'sha256:big': 'x'.repeat(5000) },
      },
      { maxInlineChars: 100 },
    );
    expect(html).toContain('truncated');
    expect(html).not.toContain('x'.repeat(200));
  });

  it('marks diff lines by form, without colour', () => {
    const html = renderTraceHtml({
      manifest: manifest(),
      events: [
        ev({
          type: 'fs.change',
          attrs: { files: 1 },
          payload: { $blob: 'sha256:d', bytes: 30, media_type: 'text/x-diff' },
        }),
      ],
      blobs: { 'sha256:d': '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new' },
    });
    expect(html).toContain('class="add"');
    expect(html).toContain('class="del"');
  });
});
