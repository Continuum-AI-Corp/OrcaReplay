#!/usr/bin/env node
/**
 * Render the README's push/pull card.
 *
 * EVERY LINE BELOW IS REAL OUTPUT, read from docs/media/sync-transcript.txt rather than typed
 * here. That transcript is a genuine round trip: `orca record` against the repo's own fake agent,
 * then `orca push`, then `orca pull` into a DIFFERENT workspace, then `orca show` reading the
 * pulled copy — captured with NO_COLOR=1. Nothing is reworded and no line is invented.
 *
 * The same rule render-demo.mjs states for the hero animation, and for the same reason: a README
 * that illustrates a debugger with output no code produced is advertising the one failure the tool
 * exists to prevent. The gateway in the transcript is a local stub speaking the OrcaRouter upload
 * and export contract (POST /api/replay/runs, GET /api/replay/runs/:key/export), so the URL in the
 * `gateway=` field is a loopback address and is left exactly as the command printed it.
 *
 * Optional tooling, deliberately not in package.json so `npm ci` stays lean for everyone who is
 * not regenerating README art:
 *
 *   npm i --no-save playwright-core
 *   node scripts/render-sync-card.mjs        # -> docs/sync-card.png
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(REPO, 'docs', 'media', 'sync-transcript.txt');
const TARGET = join(REPO, 'docs', 'sync-card.png');

/**
 * Classify a real transcript line for styling only. The text is never altered — if a line does not
 * match a known shape it is rendered as plain output rather than dropped, so a transcript this
 * script does not fully understand still renders in full.
 */
function classify(line) {
  if (line.startsWith('$ ')) return 'cmd';
  if (line.startsWith('error')) return 'err';
  if (/^info (push|pull)\.done/.test(line)) return 'ok';
  if (line.startsWith('info ')) return 'dim';
  if (/^SEQ\s+KIND/.test(line)) return 'head';
  if (/^\d+\s+\w+/.test(line)) return 'row';
  if (line.trim() === '') return 'gap';
  return 'out';
}

const lines = readFileSync(SOURCE, 'utf8').replace(/\n+$/, '').split('\n');

const CSS = `
  :root { --ground:#08090A; --ink:#E8ECEC; --dim:#6B7578; --ok:#C6D6DA; --row:#9AA4A7; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ground); color:var(--ink);
         font: 13px/1.62 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .chrome { display:flex; align-items:center; gap:.6rem; padding:.7rem 1.1rem;
            border-bottom:1px solid #1F2426; color:var(--dim); font-size:10.5px; letter-spacing:.14em; }
  .dot { width:9px; height:9px; border-radius:50%; background:#1F2426; }
  .body { padding:.9rem 1.1rem; white-space:pre; }
  .cmd  { color:var(--ink); font-weight:600; }
  .dim, .head { color:var(--dim); }
  .out  { color:var(--row); }
  .err  { color:var(--row); }
  .ok   { color:var(--ok); }
  .row  { color:var(--ink); }
  .gap  { height:.5rem; }
`;

const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div class="chrome"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
<span>ORCA · PUSH AND PULL</span></div>
<div class="body">${lines
  .map((l) => {
    const kind = classify(l);
    const text = l.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    return kind === 'gap' ? `<div class="gap"></div>` : `<div class="${kind}">${text}</div>`;
  })
  .join('')}</div>`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 });
await page.setContent(html);

// SIZED TO THE OUTPUT, rather than the output trimmed to fit a fixed card. `orca show`'s DETAIL
// column is as wide as the tool call it is reporting, and a card that clipped it would be showing
// an abbreviation of real output while presenting itself as a transcript. Measured from the
// rendered text, so the width follows whatever the commands actually printed.
const width = await page.evaluate(
  () => Math.ceil(document.querySelector('.body').scrollWidth) + 36,
);
await page.setViewportSize({ width: Math.max(960, width), height: 600 });
const height = await page.evaluate(() => Math.ceil(document.body.scrollHeight));
await page.setViewportSize({ width: Math.max(960, width), height });
await page.screenshot({ path: TARGET });
await browser.close();
console.log(`wrote ${TARGET} (${lines.length} real transcript lines)`);
