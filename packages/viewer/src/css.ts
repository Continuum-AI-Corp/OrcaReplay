/**
 * The whole stylesheet, inlined into every export. No webfonts, no imports, no URLs:
 * an export has to open from file:// on a machine that has never heard of this project.
 *
 * Monochrome and counter-shaded — a dark plane above, light below. State is carried by
 * FORM (fill, weight, hairline), never by hue: exports get screenshotted into issues,
 * printed, pasted into dark-mode Slack, and read by people who do not separate red from
 * green. Form survives all four.
 */
export const VIEWER_CSS = `
:root {
  --ground: #F3F5F5;
  --paper: #FFFFFF;
  --sunk: #EAEEEE;
  --ink: #0A0C0D;
  --ink-2: #555D60;
  --ink-3: #868F92;
  --rule: #DCE1E2;
  --rule-2: #BFC7C8;
  --band: #08090A;
  --band-fg: #E8ECEC;
  --band-2: #9AA4A7;
  --band-dim: #6B7578;
  --band-rule: #1F2426;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #111517;
    --paper: #171B1D;
    --sunk: #0C1011;
    --ink: #E9EDED;
    --ink-2: #98A2A5;
    --ink-3: #6C7679;
    --rule: #252C2E;
    --rule-2: #374043;
    --band: #08090A;
    --band-fg: #E8ECEC;
    --band-2: #9AA4A7;
    --band-dim: #6B7578;
    --band-rule: #1F2426;
    color-scheme: dark;
  }
}

:root[data-theme="dark"] {
  --ground: #111517;
  --paper: #171B1D;
  --sunk: #0C1011;
  --ink: #E9EDED;
  --ink-2: #98A2A5;
  --ink-3: #6C7679;
  --rule: #252C2E;
  --rule-2: #374043;
  --band: #08090A;
  --band-fg: #E8ECEC;
  --band-2: #9AA4A7;
  --band-dim: #6B7578;
  --band-rule: #1F2426;
  color-scheme: dark;
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }

body {
  margin: 0;
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--ground);
  color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  -webkit-text-size-adjust: 100%;
}

.mono, .row, .seq, .chip, .stat dt, .stat dd, .kv dt, .kv dd, pre, code,
input, button, .pane-title, .sub, footer, .finding {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}

:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }

/* ---- band: the dark plane above ---- */
.band {
  flex: none;
  background: var(--band);
  color: var(--band-fg);
  border-bottom: 1px solid var(--band-rule);
  padding: .6rem .9rem .55rem;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: .35rem 1.4rem;
}
.band :focus-visible { outline-color: var(--band-fg); }
.band h1 {
  margin: 0;
  font-size: .8125rem;
  font-weight: 600;
  letter-spacing: .02em;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.band .sub { color: var(--band-2); font-size: .6875rem; }
.stats { display: flex; flex-wrap: wrap; gap: .1rem 1.1rem; margin: 0 0 0 auto; padding: 0; }
.stat { display: flex; align-items: baseline; gap: .4rem; margin: 0; }
.stat dt {
  margin: 0;
  font-size: .625rem;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--band-dim);
}
.stat dd { margin: 0; font-size: .75rem; color: var(--band-fg); font-variant-numeric: tabular-nums; }
.stat dd.flag { font-weight: 700; }
#orca-theme {
  background: transparent;
  border: 1px solid var(--band-rule);
  border-radius: 2px;
  color: var(--band-2);
  font-size: .625rem;
  letter-spacing: .1em;
  text-transform: uppercase;
  padding: .15rem .4rem;
  cursor: pointer;
}
#orca-theme:hover { color: var(--band-fg); border-color: var(--band-dim); }

/* ---- findings strip ---- */
.findings { flex: none; border-bottom: 1px solid var(--rule); background: var(--sunk); }
.finding {
  display: flex;
  align-items: baseline;
  gap: .5rem;
  padding: .35rem .9rem;
  font-size: .6875rem;
  color: var(--ink-2);
}
.finding + .finding { border-top: 1px solid var(--rule); }

/* ---- split ---- */
.split { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(20rem, 38%) 1fr; }
.list { min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--rule); }
.pane-col { min-width: 0; overflow: auto; background: var(--paper); }

.filterbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: .6rem;
  padding: .45rem .75rem;
  border-bottom: 1px solid var(--rule);
}
#orca-filter {
  flex: 1;
  min-width: 0;
  background: var(--sunk);
  border: 1px solid var(--rule-2);
  border-radius: 2px;
  color: var(--ink);
  font-size: .75rem;
  padding: .25rem .4rem;
}
#orca-filter::placeholder { color: var(--ink-3); }
#orca-count { font-size: .625rem; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); }

.rows { flex: 1; min-height: 0; overflow: auto; }
.row {
  display: grid;
  grid-template-columns: 3rem 4.5rem minmax(0, 1fr) auto;
  align-items: baseline;
  gap: .55rem;
  width: 100%;
  margin: 0;
  padding: .32rem .75rem .32rem .5rem;
  background: transparent;
  border: 0;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--rule);
  color: var(--ink-2);
  font-size: .75rem;
  text-align: left;
  cursor: pointer;
}
.row[data-turn-start="true"] { border-top: 1px solid var(--rule-2); }
.row:hover { background: var(--sunk); }
.row[aria-selected="true"] { background: var(--paper); border-left-color: var(--ink); color: var(--ink); }
.row:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
.seq { color: var(--ink-3); text-align: right; font-variant-numeric: tabular-nums; font-size: .6875rem; }
.text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.label { color: var(--ink); }
.row[data-tone="attention"] .label { font-weight: 700; }
.row[data-tone="quiet"] .label { color: var(--ink-3); }
.detail { color: var(--ink-3); }
.meta { color: var(--ink-3); font-size: .6875rem; font-variant-numeric: tabular-nums; white-space: nowrap; }

.chip {
  display: inline-block;
  padding: .05rem .3rem;
  border-radius: 2px;
  font-size: .625rem;
  letter-spacing: .1em;
  text-transform: uppercase;
  white-space: nowrap;
}
.chip.attention { background: var(--ink); color: var(--ground); }
.chip.normal { border: 1px solid var(--rule-2); color: var(--ink-2); }
.chip.quiet { border: 1px solid var(--rule); color: var(--ink-3); }

/* ---- detail pane ---- */
.pane { padding: 1rem 1.25rem 3rem; max-width: 62rem; }
.pane-title { display: flex; align-items: baseline; gap: .5rem; margin: 0 0 .9rem; font-size: .875rem; font-weight: 600; }
.pane-title .name { min-width: 0; overflow-wrap: anywhere; }
.pane h3 {
  margin: 1.4rem 0 .5rem;
  padding-bottom: .25rem;
  border-bottom: 1px solid var(--rule);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: .625rem;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.kv { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: .2rem .9rem; margin: 0; }
.kv dt { margin: 0; font-size: .625rem; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.kv dd { margin: 0; font-size: .75rem; overflow-wrap: anywhere; }
.muted { color: var(--ink-3); font-size: .75rem; }
.scroll { overflow-x: auto; margin: 0; }
pre {
  margin: 0;
  padding: .5rem 0 .5rem .75rem;
  border-left: 2px solid var(--rule-2);
  background: var(--sunk);
  font-size: .75rem;
  line-height: 1.5;
}
.diff span { display: block; }
.diff .add { display: block; color: var(--ink); font-weight: 700; }
.diff .del { display: block; color: var(--ink-3); }
.diff .hunk { display: block; color: var(--ink-2); }
.empty { padding: 2rem .75rem; color: var(--ink-3); font-size: .75rem; text-align: center; }

footer {
  flex: none;
  border-top: 1px solid var(--rule);
  padding: .45rem .9rem;
  background: var(--ground);
  color: var(--ink-3);
  font-size: .6875rem;
  letter-spacing: .02em;
}

@media (max-width: 52rem) {
  .split { grid-template-columns: 1fr; grid-template-rows: minmax(0, 45%) minmax(0, 55%); }
  .list { border-right: 0; border-bottom: 1px solid var(--rule); }
  .stats { margin-left: 0; }
}


/* ── Motion ──────────────────────────────────────────────────────────────
   A debugger is read mid-incident, so motion here is functional or absent.
   Playback exists because this is a replay tool: the recorded gaps are the
   only thing it adds over pressing j, so they are preserved and compressed.
   The playhead slides to give that a physical position. Everything animates
   transform/opacity only, so nothing reflows on a large trace. */

.rows { position: relative; }

.playhead {
  position: absolute;
  left: 0;
  top: 0;
  width: 2px;
  height: 0;
  background: var(--ink);
  transform: translateY(0);
  transition: transform 160ms cubic-bezier(0.2, 0, 0, 1), height 160ms cubic-bezier(0.2, 0, 0, 1);
  pointer-events: none;
  opacity: 0;
}
.playhead[data-on='true'] { opacity: 1; }

.progress {
  height: 2px;
  background: var(--rule);
  overflow: hidden;
}
.progress > span {
  display: block;
  height: 100%;
  background: var(--ink);
  transform: scaleX(0);
  transform-origin: left center;
  transition: transform 160ms linear;
}

#orca-play .glyph {
  display: block;
  width: 0;
  height: 0;
  /* A play triangle and a pause bar from one element: no icon font, no SVG, no second asset. */
  border-style: solid;
  border-width: 5px 0 5px 8px;
  border-color: transparent transparent transparent currentColor;
  transition: border-width 120ms ease, border-color 120ms ease;
}
#orca-play[aria-pressed='true'] .glyph {
  border-width: 5px 0 5px 8px;
  border-color: transparent transparent transparent currentColor;
  border-left-style: double;
  border-left-width: 8px;
}

/* Direction of travel: forward enters from below, backward from above. Tells you which way you
   moved without a label, which matters when playback is stepping for you. */
@keyframes orca-enter-down {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes orca-enter-up {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
.pane[data-dir='down'] { animation: orca-enter-down 130ms cubic-bezier(0.2, 0, 0, 1); }
.pane[data-dir='up'] { animation: orca-enter-up 130ms cubic-bezier(0.2, 0, 0, 1); }

/* One-shot wash when playback lands on something that needs attention. No shadow — the design
   system uses hairlines and weight, never depth — and no hue, since state here is carried by
   form. An overlay whose opacity animates stays on the compositor and never repaints the row. */
.row { position: relative; }
.row[data-pulse='true']::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--ink);
  pointer-events: none;
  animation: orca-attention 420ms ease-out;
}
@keyframes orca-attention {
  from { opacity: 0.14; }
  to { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  /* Playback still works — it just steps instantly instead of gliding. */
  .playhead, .progress > span { transition: none !important; }
}
`;
