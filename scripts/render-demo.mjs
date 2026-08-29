#!/usr/bin/env node
/**
 * Render the README demo as one animated SVG.
 *
 * A GIF would need a recorder, a terminal emulator and an encoder; this needs none of them, weighs
 * a few kilobytes, stays crisp at any zoom, and is diffable in review. It also obeys the same rule
 * as everything else this project ships: self-contained, no external reference, renders with
 * nothing installed.
 *
 * Regenerate with `node scripts/render-demo.mjs > docs/demo.svg`.
 */

/** Each entry is [holdSeconds, text, class]. Timing is the point: it should read like a session. */
const SCRIPT = [
  [0.0, '$ orca record claude', 'cmd'],
  [0.6, '  info recording run=run_9f2c14 proxy=:51733 fs=on shell=on mcp=on', 'dim'],
  [1.4, '  … agent edits auth.ts, runs the tests, they fail, it retries …', 'dim'],
  [2.6, '  info recorded run=run_9f2c14 events=68 blobs=22 exit=1', 'dim'],
  [3.2, '', 'dim'],
  [3.4, '$ orca replay last', 'cmd'],
  [4.0, '  info replaying exchanges=24 egress=blocked', 'dim'],
  [4.8, '  info replay.done matched=24 total=24 divergences=0 exit=1', 'ok'],
  [5.4, '', 'dim'],
  [5.6, '$ orca compare last --from 17 \\', 'cmd'],
  [5.8, '      --models claude-opus-5,glm-5.3-flash,qwen3-coder \\', 'cmd'],
  [6.0, '      --verify "npm test"', 'cmd'],
  [6.8, '', 'dim'],
  [7.0, '  MODEL          VERDICT  TOKENS  COST    WALL', 'head'],
  [7.3, '  claude-opus-5  pass     186k    $5.81   312s', 'row'],
  [7.6, '  glm-5.3-flash  pass     200k    $0.61   242s', 'row'],
  [7.9, '  qwen3-coder    fail     178k    $0.29   191s', 'fail'],
  [8.6, '', 'dim'],
  [8.8, '  same task, same files, same prefix — the model is the only variable', 'dim'],
];

const TOTAL = 11;
const LINE_HEIGHT = 20;
const PAD_X = 22;
const PAD_TOP = 46;
const WIDTH = 760;
const HEIGHT = PAD_TOP + SCRIPT.length * LINE_HEIGHT + 24;

const FILL = {
  cmd: '#E8ECEC',
  dim: '#6B7578',
  ok: '#C6D6DA',
  head: '#6B7578',
  row: '#9AA4A7',
  fail: '#E8ECEC',
};

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const lines = SCRIPT.map(([at, text, kind], i) => {
  const y = PAD_TOP + i * LINE_HEIGHT;
  const begin = (at / TOTAL).toFixed(4);
  // A tiny fade rather than a hard cut: the eye follows an appearing line, and each one lands
  // where the recorded session put it rather than on a uniform tick.
  // xml:space="preserve" or SVG collapses runs of spaces, which silently destroys the column
  // alignment of the compare table — the one thing that table exists to show.
  return `<text x="${PAD_X}" y="${y}" class="${kind}" xml:space="preserve" opacity="0">${escapeXml(
    text,
  )}<animate attributeName="opacity" values="0;0;1;1" keyTimes="0;${begin};${(
    Number(begin) + 0.012
  ).toFixed(4)};1" dur="${TOTAL}s" repeatCount="indefinite"/></text>`;
}).join('\n');

process.stdout
  .write(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="Recording, replaying and forking an agent run with OrcaReplay">
<style>
  text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
  .cmd { fill: ${FILL.cmd}; }
  .dim { fill: ${FILL.dim}; }
  .ok { fill: ${FILL.ok}; }
  .head { fill: ${FILL.head}; font-size: 11px; letter-spacing: 0.08em; }
  .row { fill: ${FILL.row}; }
  .fail { fill: ${FILL.fail}; font-weight: 600; }
  .chrome { fill: #6B7578; font-size: 11px; letter-spacing: 0.14em; }
  /* Honour a reader who has asked for less motion: show the finished session, no animation. */
  @media (prefers-reduced-motion: reduce) {
    text animate { display: none; }
    text { opacity: 1 !important; }
  }
</style>
<rect width="${WIDTH}" height="${HEIGHT}" fill="#08090A"/>
<text x="${PAD_X}" y="26" class="chrome">ORCAREPLAY — RECORD, REPLAY, FORK</text>
<line x1="0" y1="34" x2="${WIDTH}" y2="34" stroke="#1F2426"/>
${lines}
</svg>
`);
