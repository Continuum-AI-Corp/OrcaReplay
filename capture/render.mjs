/**
 * Render the successful Fable 5.1 prompt capture: attach, launch, record, extract, scrub.
 *
 * Every line is real output from run_bc749535e248, trimmed for width and not otherwise reworded.
 * Nothing here failed — the earlier gateway 400 and the winpty assertion are left out on purpose,
 * this is the path that works.
 *
 * Same approach as scripts/render-demo.mjs in the repo: a headless Chromium renders one PNG per
 * state change, each frame carrying its own hold, then gifenc packs them with a single palette.
 * ffmpeg turns the same frames into the mp4.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FRAMES = join(process.cwd(), 'frames');
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const SCENES = [
  {
    label: '1/6 · hold a proxy open',
    lines: [
      ['cmd', '$ orca attach --for claude --port 46001 \\'],
      ['cmd', '    --upstream-anthropic https://api.anthropic.com'],
      ['dim', 'info attached run=run_bc749535e248 proxy=http://127.0.0.1:46001 for=claude-code'],
      ['gap', ''],
      ['out', '  # in the sandbox, before starting your agent:'],
      ['ok', "  export ANTHROPIC_BASE_URL='http://127.0.0.1:46001'"],
      ['out', "  # your agent's own credential is unchanged - orca forwards it upstream"],
      ['gap', ''],
      ['dim', '  Recording. Press ctrl-C when the agent is done.'],
    ],
  },
  {
    label: '2/6 · launch claude in a real console',
    lines: [
      ['cmd', "PS> $env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:46001'"],
      ['cmd', 'PS> Start-Process claude.exe -WindowStyle Minimized `'],
      ['cmd', "      -ArgumentList '--model','claude-fable-5-1','\"say only the word ok\"'"],
      ['ok', 'launched pid=18544'],
      ['gap', ''],
      ['out', 'ok'],
      ['gap', ''],
      ['note', 'a new window is a real console, so process.stdin.isTTY is true'],
      ['note', 'and Claude Code assembles its interactive prompt, not the -p one'],
    ],
  },
  {
    label: '3/6 · what the proxy wrote',
    lines: [
      ['cmd', '$ orca show run_bc749535e248'],
      ['head', 'SEQ  TYPE            DETAIL'],
      ['row', '  4  model.request   claude-fable-5-1   tools=35   blob=175,255 bytes'],
      ['row', '  5  model.response  200  end_turn  cache_read=59,811 tokens'],
      ['gap', ''],
      ['note', 'the system prompt travels in the request, so it is on disk the'],
      ['note', 'moment the agent sends it - no response needed to read it'],
    ],
  },
  {
    label: '4/6 · open the request body',
    lines: [
      ['cmd', '$ node -e "JSON.parse(blob).system"'],
      ['dim', '  [0]     70 chars  cache=none      billing header'],
      ['dim', '  [1]     57 chars  cache=1h        identity'],
      ['dim', '  [2]    907 chars  cache=none      reporting outcomes'],
      ['ok', '  [3]  13919 chars  cache=1h        the body'],
      ['dim', '  role:system  11529 chars          agents · skills · permission mode'],
      ['dim', '  tools            35'],
      ['gap', ''],
      ['row', 'system prompt total: 26,482 chars'],
    ],
  },
  {
    label: '5/6 · the prompt itself',
    lines: [
      ['cmd', '$ head fable-5-1-interactive-system-prompt.txt'],
      ['out', 'x-anthropic-billing-header: cc_version=2.1.258.a5e; cc_entrypoint=cli;'],
      ['ink', 'You are Claude Code, Anthropic\u2019s official CLI for Claude.'],
      ['ink', 'You are an interactive agent that helps users with software engineering tasks.'],
      ['dim', '# Harness'],
      ['out', ' - Text you output outside of tool use is displayed to the user as Github-'],
      ['out', '   flavored markdown in a terminal.'],
      ['ink', 'This iteration of Claude is Claude Fable 5.1, the newest model in Anthropic\u2019s'],
      ['ink', 'Claude 5 family and part of the Mythos-class model tier that sits above Claude'],
      ['ink', 'Opus in capability.'],
    ],
  },
  {
    label: '6/6 · scrubbed, ready to share',
    lines: [
      ['cmd', '$ node sanitise.mjs'],
      ['dim', 'system blocks         : 70 + 57 + 907 + 13473'],
      ['dim', 'system-role turn      : 11529'],
      ['dim', 'file chars            : 26045'],
      ['ok', 'remaining identifiers : none'],
      ['gap', ''],
      ['row', '-> Claude-Fable-5.1-ClaudeCode.md'],
      ['gap', ''],
      ['note', 'no email, account uuid, device id, session id or commit hash left in it'],
    ],
  },
];

const CSS = `
  :root { --ground:#08090A; --ink:#E8ECEC; --dim:#6B7578; --ok:#C6D6DA;
          --row:#9AA4A7; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--ground); color:var(--ink); width:960px; height:330px;
         font: 13px/1.68 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .chrome { display:flex; align-items:center; gap:.6rem; padding:.7rem 1.1rem;
            border-bottom:1px solid #1F2426; color:var(--dim);
            font-size:10.5px; letter-spacing:.14em; }
  .dot { width:9px; height:9px; border-radius:50%; background:#1F2426; }
  .label { margin-left:auto; letter-spacing:.1em; color:#4E585B; }
  .scene { display:none; padding:.9rem 1.15rem; white-space:pre; }
  .scene.live { display:block; }
  .l { opacity:0; }
  .l.on { opacity:1; }
  .cmd { color:var(--ink); font-weight:600; }
  .dim, .head { color:var(--dim); }
  .out { color:var(--row); }
  .ok { color:var(--ok); }
  .row, .ink { color:var(--ink); }
  .note { color:var(--dim); font-style:italic; }
  .gap { height:.5rem; }
`;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const html =
  `<!doctype html><meta charset="utf-8"><style>${CSS}</style>` +
  `<div class="chrome"><span class="dot"></span><span class="dot"></span><span class="dot"></span>` +
  `<span style="margin-left:.4rem">ORCAREPLAY — CAPTURING THE CLAUDE FABLE 5.1 SYSTEM PROMPT</span>` +
  `<span class="label" id="label"></span></div>` +
  SCENES.map(
    (s, si) =>
      `<div class="scene" id="s${si}">` +
      s.lines
        .map(([k, t], li) => `<div class="l ${k}" id="s${si}l${li}">${esc(t) || '&nbsp;'}</div>`)
        .join('') +
      `</div>`,
  ).join('');

const browser = await chromium.launch({ executablePath: EDGE });
const page = await browser.newPage({ viewport: { width: 960, height: 330 }, deviceScaleFactor: 1 });
await page.setContent(html);

let frame = 0;
const delays = [];
const snap = async (ms) => {
  await page.screenshot({ path: join(FRAMES, `f${String(frame++).padStart(4, '0')}.png`) });
  delays.push(ms);
};

const hold = (kind, last) =>
  last ? 2600 : kind === 'cmd' ? 540 : kind === 'gap' ? 190 : kind === 'note' ? 1000 : kind === 'ink' ? 620 : 450;

for (const [si, scene] of SCENES.entries()) {
  await page.evaluate(
    ([n, text]) => {
      document.querySelectorAll('.scene').forEach((el) => el.classList.remove('live'));
      document.getElementById(`s${n}`).classList.add('live');
      document.getElementById('label').textContent = text;
    },
    [si, scene.label],
  );
  await snap(520);
  for (const [li, [kind]] of scene.lines.entries()) {
    await page.evaluate((id) => document.getElementById(id)?.classList.add('on'), `s${si}l${li}`);
    await snap(hold(kind, li === scene.lines.length - 1));
  }
}
delays[delays.length - 1] = 3600;
await browser.close();

const files = readdirSync(FRAMES)
  .filter((f) => f.endsWith('.png'))
  .sort();
const enc = GIFEncoder();
const ref = PNG.sync.read(readFileSync(join(FRAMES, files[files.length - 1])));
const palette = quantize(new Uint8ClampedArray(ref.data), 64, { format: 'rgb565' });
for (const [i, f] of files.entries()) {
  const png = PNG.sync.read(readFileSync(join(FRAMES, f)));
  const indexed = applyPalette(new Uint8ClampedArray(png.data), palette, 'rgb565');
  enc.writeFrame(indexed, png.width, png.height, {
    palette: i === 0 ? palette : undefined,
    delay: delays[i] ?? 450,
    repeat: 0,
  });
}
enc.finish();
const bytes = Buffer.from(enc.bytes());
writeFileSync('fable-capture.gif', bytes);
writeFileSync('delays.json', JSON.stringify(delays));
console.log(`fable-capture.gif: ${files.length} frames, ${(bytes.length / 1024).toFixed(0)} KB`);
console.log(`total runtime: ${(delays.reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s`);
