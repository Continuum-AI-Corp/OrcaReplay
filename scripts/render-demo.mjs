#!/usr/bin/env node
/**
 * Render the README's hero animation.
 *
 * The lines below are real output, copied from `docs/media/transcript.txt` — a single recorded
 * session captured with NO_COLOR=1. They are trimmed for width and nothing else; no line is
 * invented or reworded. The README's previous hero was hand-written prose that no code produced,
 * which is exactly the kind of thing a debugger cannot afford to ship.
 *
 * A GIF rather than an animated SVG because GitHub, X and HN all render a GIF the same way, and a
 * README that only animates in some places is worse than one that animates nowhere.
 *
 * Optional tooling, deliberately not in package.json so `npm ci` stays lean for everyone who is
 * not regenerating README art:
 *
 *   npm i --no-save playwright-core pngjs gifenc
 *   node scripts/render-demo.mjs            # -> docs/demo-cli.gif
 *
 * The viewer GIF (docs/demo-viewer.gif) is captured the same way, by driving `orca ui` in the same
 * browser; see docs/media/README.md.
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(REPO, 'docs', 'demo-cli.gif');
const FRAMES = mkdtempSync(join(tmpdir(), 'orca-demo-'));

/** Every line is from docs/media/transcript.txt, trimmed for width and not otherwise altered. */
const SCRIPT = [
  ['cmd', '$ orca record claude -- -p "Reject tokens shorter than 8 chars in auth.ts"'],
  ['dim', 'info recording run=run_c00c6c89 adapter=claude-code proxy=:44043 fs=on shell=on'],
  ['out', 'Updated `isValid` in auth.ts to require tokens of at least 8 characters.'],
  ['dim', 'info recorded run=run_c00c6c89 events=42 blobs=8 exit=0'],
  ['gap', ''],
  ['cmd', '$ orca replay last'],
  ['dim', 'info replay.restored to=5c1e02c6 your_tree=fbb98ae5  # put back when the replay ends'],
  ['dim', 'info replaying exchanges=6 egress=blocked cwd=/tmp/herodemo'],
  ['warn', 'warn divergence seq=5 level=major  request 1 has an identical trailing message'],
  ['ok', 'info replay.done matched=2 total=6 divergences=4 unmatched=0 exit=0'],
  ['gap', ''],
  ['cmd', '$ orca compare last --from 4 --models claude-sonnet-5,claude-haiku-4-5 \\'],
  ['cmd', '      --verify "npx tsc --noEmit auth.ts"'],
  ['dim', 'info forked from=run_c00c6c89 at=4 model=claude-sonnet-5'],
  ['dim', 'info forked from=run_c00c6c89 at=4 model=claude-haiku-4-5'],
  ['gap', ''],
  ['head', 'MODEL                      VERDICT  TOKENS   COST       WALL'],
  ['row', 'claude-sonnet-5            pass     124/429  $0.006807  12.2s'],
  ['row', 'claude-haiku-4-5-20251001  pass     184/650  $0.003434  14.3s'],
  ['gap', ''],
  ['note', 'same task · same files · same prefix — the model is the only variable'],
];

const CSS = `
  :root { --ground:#08090A; --ink:#E8ECEC; --dim:#6B7578; --ok:#C6D6DA; --row:#9AA4A7; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ground); color:var(--ink);
         font: 13px/1.62 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .chrome { display:flex; align-items:center; gap:.6rem; padding:.7rem 1.1rem;
            border-bottom:1px solid #1F2426; color:var(--dim); font-size:10.5px; letter-spacing:.14em; }
  .dot { width:9px; height:9px; border-radius:50%; background:#1F2426; }
  .body { padding:.9rem 1.1rem; white-space:pre; }
  .l { opacity:0; }
  .l.on { opacity:1; }
  .cmd  { color:var(--ink); font-weight:600; }
  .dim, .head { color:var(--dim); }
  .out  { color:var(--row); }
  .warn { color:var(--row); }
  .ok   { color:var(--ok); }
  .row  { color:var(--ink); }
  .note { color:var(--dim); font-style:italic; }
  .gap  { height:.5rem; }
  .cur  { display:inline-block; width:7px; height:14px; background:var(--ink);
          vertical-align:-2px; margin-left:2px; }
`;

const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div class="chrome"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
<span style="margin-left:.4rem">ORCAREPLAY — RECORD · REPLAY · FORK</span></div>
<div class="body">${SCRIPT.map(
  ([k, t], i) =>
    `<div class="l ${k}" id="l${i}">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;') || '&nbsp;'}</div>`,
).join('')}</div>`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
await page.setContent(html);

// One frame per state change, with the hold expressed as that frame's delay. 107 near-identical
// PNGs made a 5.5 MB GIF; 22 frames carrying their own timing say exactly the same thing.
const HOLD_MS = SCRIPT.map(([k]) =>
  k === 'cmd' ? 620 : k === 'gap' ? 220 : k === 'row' ? 700 : k === 'note' ? 900 : 460,
);
let frame = 0;
const delays = [];
const snap = async (ms) => {
  await page.screenshot({ path: `${FRAMES}/f${String(frame++).padStart(4, '0')}.png` });
  delays.push(ms);
};

await snap(500);
for (let i = 0; i < SCRIPT.length; i += 1) {
  await page.evaluate((n) => document.getElementById(`l${n}`)?.classList.add('on'), i);
  await snap(HOLD_MS[i]);
}
delays[delays.length - 1] = 3200; // let the table sit before it loops
await browser.close();

// Encode in-process. The ffmpeg that ships with Playwright is stripped to what Playwright needs —
// no PNG decoder, no GIF muxer — so shelling out to it silently fails on both ends.
const files = readdirSync(FRAMES)
  .filter((f) => f.endsWith('.png'))
  .sort();
const enc = GIFEncoder();
// One palette for the whole clip, built from the final frame: it carries every colour the sequence
// ever shows, so nothing shifts hue partway through.
const last = PNG.sync.read(readFileSync(join(FRAMES, files[files.length - 1])));
const palette = quantize(new Uint8ClampedArray(last.data), 32, { format: 'rgb565' });
for (const [i, f] of files.entries()) {
  const png = PNG.sync.read(readFileSync(join(FRAMES, f)));
  const indexed = applyPalette(new Uint8ClampedArray(png.data), palette, 'rgb565');
  enc.writeFrame(indexed, png.width, png.height, {
    palette: i === 0 ? palette : undefined,
    delay: delays[i] ?? 500,
    repeat: 0,
  });
}
enc.finish();
const bytes = Buffer.from(enc.bytes());
writeFileSync(TARGET, bytes);
console.log(`${TARGET}: ${files.length} frames, ${(bytes.length / 1024).toFixed(0)} KB`);
