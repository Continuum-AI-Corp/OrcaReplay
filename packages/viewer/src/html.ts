/**
 * Renders a whole trace into ONE self-contained HTML document.
 *
 * The document opens from file:// with no network: the stylesheet and the client runtime are
 * inlined, there are no webfonts, no images and no external references of any kind. That is the
 * point of the package — someone attaches an export to an issue and the reader sees the full UI
 * without installing anything.
 *
 * A trace is untrusted input (spec §5 calls it sensitive material; it is also *foreign*
 * material). Every byte that comes from the trace goes through `escapeHtml`, and the client
 * script never turns a string into markup, so the escape function is the entire XSS surface.
 */

import type { BlobRef, Manifest, TraceEvent } from '@orcareplay/schema';
import { CLIENT_SOURCE } from './client/main.js';
import { VIEWER_CSS } from './css.js';
import {
  buildTimeline,
  detectLoops,
  formatBytes,
  formatDuration,
  formatTokens,
  summarize,
  type TimelineRow,
  type Tone,
} from './render.js';

export interface RenderInput {
  manifest: Manifest;
  events: TraceEvent[];
  /** Blob contents by `$blob` reference (or bare digest). Anything absent renders as omitted. */
  blobs?: Record<string, string>;
}

export interface RenderOptions {
  /** Client runtime to inline. Defaults to the readable source; pass a minified bundle. */
  script?: string;
  /** Per-payload character cap, so one huge blob cannot dominate the file. */
  maxInlineChars?: number;
}

const DEFAULT_MAX_INLINE_CHARS = 200_000;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** The one place trace content becomes markup-safe. Used on every single interpolation. */
export function escapeHtml(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

function chip(kind: string, tone: Tone): string {
  return `<span class="chip ${tone}">${escapeHtml(kind)}</span>`;
}

/** Spec §2.2: an object carrying `$blob` is a blob reference or the event is invalid. */
function asBlobRef(value: unknown): BlobRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['$blob'] !== 'string') return null;
  return {
    $blob: record['$blob'],
    bytes: typeof record['bytes'] === 'number' ? record['bytes'] : 0,
    ...(typeof record['media_type'] === 'string' ? { media_type: record['media_type'] } : {}),
  };
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function isScalar(value: unknown): boolean {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

function truncated(text: string, max: number): { body: string; note: string } {
  if (text.length <= max) return { body: text, note: '' };
  return {
    body: text.slice(0, max),
    note: `… truncated, ${formatTokens(text.length - max)} more characters`,
  };
}

function looksLikeDiff(text: string, mediaType?: string): boolean {
  if (mediaType && /diff|patch/i.test(mediaType)) return true;
  return /^(diff --git |--- |\+\+\+ |@@ )/.test(text);
}

/** Diff state carried by weight and dimming — no hue, so it survives a grayscale screenshot. */
function diffBlock(text: string): string {
  const lines = text.split('\n').map((line) => {
    const cls = line.startsWith('+')
      ? 'add'
      : line.startsWith('-')
        ? 'del'
        : line.startsWith('@@')
          ? 'hunk'
          : 'ctx';
    return `<span class="${cls}">${escapeHtml(line) || '&nbsp;'}</span>`;
  });
  return `<div class="scroll"><pre class="diff">${lines.join('')}</pre></div>`;
}

function codeBlock(text: string, max: number, mediaType?: string): string {
  const { body, note } = truncated(text, max);
  const block = looksLikeDiff(body, mediaType)
    ? diffBlock(body)
    : `<div class="scroll"><pre>${escapeHtml(body)}</pre></div>`;
  return note ? `${block}<p class="muted">${escapeHtml(note)}</p>` : block;
}

function kvRow(key: string, valueHtml: string): string {
  return `<dt>${escapeHtml(key)}</dt><dd>${valueHtml}</dd>`;
}

function attrsBlock(attrs: Record<string, unknown>, max: number): string {
  const rows = Object.entries(attrs).map(([key, value]) =>
    kvRow(
      key,
      isScalar(value)
        ? escapeHtml(value)
        : codeBlock(json(value), Math.min(max, 8000), 'application/json'),
    ),
  );
  return `<h3>attrs</h3><dl class="kv">${rows.join('')}</dl>`;
}

function payloadBlock(payload: unknown, blobs: Record<string, string>, max: number): string {
  const ref = asBlobRef(payload);
  if (ref) {
    const digest = ref.$blob;
    const content = blobs[digest] ?? blobs[digest.replace(/^sha256:/, '')];
    const meta = `<dl class="kv">${kvRow('digest', escapeHtml(digest))}${kvRow(
      'size',
      escapeHtml(formatBytes(ref.bytes)),
    )}${ref.media_type ? kvRow('media type', escapeHtml(ref.media_type)) : ''}</dl>`;
    const body =
      content === undefined
        ? `<p class="muted">payload omitted, ${escapeHtml(ref.bytes)} bytes</p>`
        : codeBlock(content, max, ref.media_type);
    return `<h3>payload</h3>${meta}${body}`;
  }
  const text = typeof payload === 'string' ? payload : json(payload);
  return `<h3>payload</h3>${codeBlock(text, max, typeof payload === 'string' ? undefined : 'application/json')}`;
}

function paneHtml(
  event: TraceEvent,
  row: TimelineRow,
  index: number,
  blobs: Record<string, string>,
  max: number,
): string {
  const attrs =
    event.attrs && typeof event.attrs === 'object' && Object.keys(event.attrs).length > 0
      ? (event.attrs as Record<string, unknown>)
      : null;

  const facts = [
    kvRow('seq', escapeHtml(event.seq)),
    kvRow('type', escapeHtml(event.type)),
    kvRow('actor', escapeHtml(event.actor)),
    kvRow('turn', escapeHtml(event.turn)),
    kvRow('elapsed', escapeHtml(`+${formatDuration((event.mono_us ?? 0) / 1000)}`)),
    kvRow('wall clock', escapeHtml(event.ts)),
    event.causes?.length ? kvRow('causes', escapeHtml(event.causes.join(', '))) : '',
    event.redacted?.length ? kvRow('redacted', escapeHtml(event.redacted.join(', '))) : '',
  ].join('');

  return [
    `<article class="pane" role="tabpanel" id="orca-pane-${index}"`,
    ` aria-labelledby="orca-row-${index}" tabindex="0"${index === 0 ? '' : ' hidden'}>`,
    `<h2 class="pane-title">${chip(row.kind, row.tone)}<span class="name">${escapeHtml(row.label)}</span></h2>`,
    `<dl class="kv">${facts}</dl>`,
    attrs ? attrsBlock(attrs, max) : '',
    event.payload === undefined || event.payload === null
      ? ''
      : payloadBlock(event.payload, blobs, max),
    '</article>',
  ].join('');
}

function rowHtml(row: TimelineRow, index: number, previous: TimelineRow | undefined): string {
  // Turns are the unit an agent thinks in; a heavier rule at each boundary makes them legible
  // without spending a colour or an extra element on it.
  const turnStart = previous !== undefined && previous.turn !== row.turn;
  return [
    `<button class="row" type="button" role="tab" id="orca-row-${index}"`,
    ` aria-controls="orca-pane-${index}" aria-selected="${index === 0}"`,
    ` tabindex="${index === 0 ? 0 : -1}" data-tone="${row.tone}"`,
    turnStart ? ' data-turn-start="true"' : '',
    '>',
    `<span class="seq">${escapeHtml(row.seq)}</span>`,
    chip(row.kind, row.tone),
    `<span class="text"><span class="label">${escapeHtml(row.label)}</span>`,
    row.detail ? ` <span class="detail">${escapeHtml(row.detail)}</span>` : '',
    `</span><span class="meta">${escapeHtml(row.meta)}</span>`,
    '</button>',
  ].join('');
}

function statHtml(label: string, value: string, flag = false): string {
  return `<div class="stat"><dt>${escapeHtml(label)}</dt><dd${
    flag ? ' class="flag"' : ''
  }>${escapeHtml(value)}</dd></div>`;
}

/** Renders a complete, standalone HTML document for one run. */
export function renderTraceHtml(input: RenderInput, options: RenderOptions = {}): string {
  const { manifest, events } = input;
  const blobs = input.blobs ?? {};
  const max = options.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS;
  const script = options.script ?? CLIENT_SOURCE;

  const rows = buildTimeline(events);
  const summary = summarize(manifest, events);
  const loops = detectLoops(events);

  const stats = [
    statHtml('duration', formatDuration(summary.durationMs)),
    statHtml('events', formatTokens(summary.eventCount)),
    statHtml('turns', formatTokens(summary.turnCount)),
    statHtml(
      'tokens',
      `${formatTokens(summary.totalUsage.input)} in · ${formatTokens(summary.totalUsage.output)} out`,
    ),
    statHtml('blobs', formatTokens(summary.blobCount)),
    summary.errorCount > 0 ? statHtml('errors', formatTokens(summary.errorCount), true) : '',
    summary.divergenceCount > 0
      ? statHtml('divergences', formatTokens(summary.divergenceCount), true)
      : '',
    statHtml(
      'exit',
      summary.exitCode === null ? '—' : String(summary.exitCode),
      summary.exitCode !== null && summary.exitCode !== 0,
    ),
  ].join('');

  const findings = loops.length
    ? `<section class="findings" aria-label="Analyzer findings">${loops
        .map(
          (loop) =>
            `<p class="finding"><span class="chip attention">LOOP</span><span>turns ${escapeHtml(
              loop.fromTurn,
            )}–${escapeHtml(loop.toTurn)} left the workspace unchanged at tree ${escapeHtml(
              loop.tree,
            )} (${escapeHtml(loop.turns.length)} turns)</span></p>`,
        )
        .join('')}</section>`
    : '';

  const list = rows.length
    ? `<div class="rows" role="tablist" aria-orientation="vertical" aria-label="Events">${rows
        .map((row, index) => rowHtml(row, index, rows[index - 1]))
        .join('')}</div>`
    : '<div class="rows"><p class="empty">This trace has no events.</p></div>';

  const panes = rows.length
    ? rows.map((row, index) => paneHtml(events[index]!, row, index, blobs, max)).join('')
    : '<p class="empty">Nothing to inspect.</p>';

  const countLabel = `${formatTokens(rows.length)} ${rows.length === 1 ? 'event' : 'events'}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${escapeHtml(manifest.run_id)} · OrcaReplay</title>
<style>${VIEWER_CSS}</style>
</head>
<body>
<header class="band">
<h1>${escapeHtml(manifest.run_id)}</h1>
<span class="sub">${escapeHtml(summary.adapter)}</span>
<dl class="stats">${stats}</dl>
<button id="orca-theme" type="button" aria-label="Switch colour theme">auto</button>
</header>
${findings}
<main class="split">
<section class="list" aria-label="Timeline">
<div class="filterbar">
<input id="orca-filter" type="text" aria-label="Filter events" autocomplete="off" spellcheck="false" placeholder="filter · / to focus · j k to move">
<span id="orca-count" aria-live="polite">${escapeHtml(countLabel)}</span>
</div>
${list}
</section>
<section class="pane-col" aria-label="Event detail">${panes}</section>
</main>
<footer>Recorded with OrcaReplay · npx orcareplay</footer>
<script>${script}</script>
</body>
</html>
`;
}
