/**
 * Render one `capture.mjs` run as the README's opening animation.
 *
 * The lines are the real output of `node capture/capture.mjs claude --model claude-opus-5
 * --port 46081`, with the two absolute paths replaced by a placeholder repository so the clip is
 * shareable. Nothing else is reworded.
 *
 * Same machinery as render.mjs: a headless Chromium renders one PNG per state change, each frame
 * carrying its own hold, then gifenc packs them under a single palette. The holds are stretched
 * where the real run waits — the pause before `captured seq=4` is the agent starting up in its own
 * console and sending its first turn, which is most of the wall clock.
 *
 * Frames go to a fresh directory in the OS temp space, the way scripts/render-demo.mjs and
 * scripts/render-cards.mjs do it. An earlier version pointed them at `join(process.cwd(), ...)`
 * and removed that directory before starting, which silently deleted any folder of that name in
 * whatever directory the script was run from. Outputs are written to an explicit path beside this
 * script rather than relative to the caller's directory.
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = join(HERE, 'capture-run.gif');
const FRAMES = mkdtempSync(join(tmpdir(), 'orca-capture-run-'));

/** [class, text, hold in ms] */
const LINES = [
  ['cmd', '$ node capture/capture.mjs claude --model claude-opus-5 --port 46081', 900],
  ['ink', 'capturing claude · claude-opus-5 · interactive', 420],
  ['dim', '  cwd D:\\your\\repo', 380],
  [
    'dim',
    '  orca attach --for claude --port 46081 --upstream-anthropic https://api.anthropic.com',
    700,
  ],
  ['ok', '  launched pid=33076 in its own console', 2600],
  ['ok', '  captured seq=4 tools=35 bytes=171461', 900],
  ['gap', '', 200],
  ['ink', '  claude-opus-5/', 380],
  ['row', '    prompt    22,760 chars in 4 blocks', 420],
  ['row', '    tools     35', 380],
  ['row', '    request   171,461 bytes', 380],
  ['row', '    prefix    58,938 tokens', 420],
  ['ok', '    scrubbed  clean', 800],
  ['gap', '', 200],
  ['dim', 'written to capture\\claude-opus-5', 420],
  ['dim', '  mirrored prompt/CLAUDECODE/claude-opus-5-system-prompt.md', 3400],
];

const CSS = `
  :root { --ground:#08090A; --ink:#E8ECEC; --dim:#6B7578; --ok:#C6D6DA; --row:#9AA4A7; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ground); color:var(--ink); width:900px; height:410px;
         font: 13px/1.68 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .chrome { display:flex; align-items:center; gap:.6rem; padding:.7rem 1.1rem;
            border-bottom:1px solid #1F2426; color:var(--dim);
            font-size:10.5px; letter-spacing:.14em; }
  .dot { width:9px; height:9px; border-radius:50%; background:#1F2426; }
  .body { padding:.9rem 1.15rem; white-space:pre; }
  .l { opacity:0; }
  .l.on { opacity:1; }
  .cmd { color:var(--ink); font-weight:600; }
  .dim { color:var(--dim); }
  .ok { color:var(--ok); }
  .row, .ink { color:var(--ink); }
  .gap { height:.5rem; }
`;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const html =
  `<!doctype html><meta charset="utf-8"><style>${CSS}</style>` +
  `<div class="chrome"><span class="dot"></span><span class="dot"></span><span class="dot"></span>` +
  `<span style="margin-left:.4rem">ONE COMMAND, ONE SYSTEM PROMPT ON DISK</span></div>` +
  `<div class="body">${LINES.map(
    ([k, t], i) => `<div class="l ${k}" id="l${i}">${esc(t) || '&nbsp;'}</div>`,
  ).join('')}</div>`;

const browser = await chromium.launch({ executablePath: EDGE });
const page = await browser.newPage({ viewport: { width: 900, height: 410 }, deviceScaleFactor: 1 });
await page.setContent(html);

let frame = 0;
const delays = [];
const snap = async (ms) => {
  await page.screenshot({ path: join(FRAMES, `f${String(frame++).padStart(4, '0')}.png`) });
  delays.push(ms);
};

await snap(500);
for (const [i, [, , hold]] of LINES.entries()) {
  await page.evaluate((n) => document.getElementById(`l${n}`)?.classList.add('on'), i);
  await snap(hold);
}
await browser.close();

const files = readdirSync(FRAMES)
  .filter((f) => f.endsWith('.png'))
  .sort();
const enc = GIFEncoder();
const ref = PNG.sync.read(readFileSync(join(FRAMES, files[files.length - 1])));
const palette = quantize(new Uint8ClampedArray(ref.data), 48, { format: 'rgb565' });
for (const [i, f] of files.entries()) {
  const png = PNG.sync.read(readFileSync(join(FRAMES, f)));
  const indexed = applyPalette(new Uint8ClampedArray(png.data), palette, 'rgb565');
  enc.writeFrame(indexed, png.width, png.height, {
    palette: i === 0 ? palette : undefined,
    delay: delays[i] ?? 420,
    repeat: 0,
  });
}
enc.finish();
const bytes = Buffer.from(enc.bytes());
writeFileSync(TARGET, bytes);
rmSync(FRAMES, { recursive: true, force: true });
console.log(
  `${TARGET}: ${files.length} frames, ${(bytes.length / 1024).toFixed(0)} KB, ` +
    `${(delays.reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s`,
);
