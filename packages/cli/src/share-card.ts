import type { GraphNode, RunGraph } from '@orcareplay/core';
import { CREDIT_MADE_BY, CREDIT_REPO } from '@orcareplay/viewer';
import type { CompareRow } from './commands/compare.js';

/**
 * A comparison table as one self-contained SVG.
 *
 * The compare table is the most shareable thing OrcaReplay produces — a model-versus-model result
 * grounded in a real task rather than a synthetic benchmark. It is only worth sharing if it says
 * what it measured, so the card carries the fork point and the verify command alongside the
 * verdicts. A cost column with no stated verdict command is a number people will quote out of
 * context.
 *
 * Monochrome and dependency-free for the same reason the viewer is: it has to survive being
 * dropped into an issue, a README, a chat window, or a dark-mode client, and it has to render
 * with nothing installed.
 */

export interface CardMeta {
  runId: string;
  forkPoint: number;
  verify?: string;
}

const ROW_HEIGHT = 30;
const HEADER = 120;
const FOOTER = 46;
const WIDTH = 720;

export function renderCompareCard(rows: CompareRow[], meta: CardMeta): string {
  const height = HEADER + Math.max(1, rows.length) * ROW_HEIGHT + FOOTER;
  const measured = meta.verify
    ? `verdict = exit code of \`${meta.verify}\``
    : 'verdict = the agent’s own exit code';

  const body = rows
    .map((row, i) => {
      const y = HEADER + i * ROW_HEIGHT;
      const failed = row.verdict === 'fail';
      return [
        `<rect x="0" y="${y - 21}" width="${WIDTH}" height="${ROW_HEIGHT}" fill="${
          i % 2 === 0 ? '#0E1214' : '#0A0D0F'
        }"/>`,
        text(28, y, row.model, { size: 13, weight: failed ? 600 : 400 }),
        // Verdict reads by form as well as word: the failing row is the one in solid inverse.
        failed
          ? `<rect x="286" y="${y - 14}" width="42" height="18" fill="#E8ECEC"/>` +
            text(291, y, 'FAIL', { size: 10, weight: 600, fill: '#08090A', mono: true })
          : `<rect x="286" y="${y - 14}" width="42" height="18" fill="none" stroke="#374043"/>` +
            text(291, y, 'PASS', { size: 10, fill: '#9AA4A7', mono: true }),
        text(360, y, formatTokens(row.inputTokens + row.outputTokens), {
          size: 12,
          mono: true,
          fill: '#9AA4A7',
        }),
        text(470, y, row.cost === null ? '—' : `$${trimCost(row.cost)}`, { size: 12, mono: true }),
        text(600, y, `${(row.wallMs / 1000).toFixed(0)}s`, {
          size: 12,
          mono: true,
          fill: '#9AA4A7',
        }),
      ].join('');
    })
    .join('');

  const empty =
    rows.length === 0 ? text(28, HEADER, 'no models compared', { size: 13, fill: '#6B7578' }) : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-label="OrcaReplay model comparison">
<rect width="${WIDTH}" height="${height}" fill="#08090A"/>
${text(28, 40, 'Same task, same state, different model', { size: 17, weight: 600 })}
${text(28, 62, `${meta.runId} · forked at checkpoint ${meta.forkPoint}`, { size: 11, mono: true, fill: '#9AA4A7' })}
${text(28, 78, measured, { size: 11, mono: true, fill: '#6B7578' })}
<line x1="0" y1="${HEADER - 24}" x2="${WIDTH}" y2="${HEADER - 24}" stroke="#1F2426"/>
${text(28, HEADER - 30, 'MODEL', { size: 9, mono: true, fill: '#6B7578' })}
${text(286, HEADER - 30, 'VERDICT', { size: 9, mono: true, fill: '#6B7578' })}
${text(360, HEADER - 30, 'TOKENS', { size: 9, mono: true, fill: '#6B7578' })}
${text(470, HEADER - 30, 'COST', { size: 9, mono: true, fill: '#6B7578' })}
${text(600, HEADER - 30, 'WALL', { size: 9, mono: true, fill: '#6B7578' })}
${body}${empty}
<line x1="0" y1="${height - FOOTER + 14}" x2="${WIDTH}" y2="${height - FOOTER + 14}" stroke="#1F2426"/>
${text(28, height - 16, CREDIT_MADE_BY, { size: 10, mono: true, fill: '#6B7578' })}
${text(WIDTH - 28, height - 16, CREDIT_REPO, { size: 10, mono: true, fill: '#6B7578', anchor: 'end' })}
</svg>`;
}

/**
 * The path to write a card to, or a refusal.
 *
 * Everything here renders SVG and nothing rasterises, so a name ending `.png` used to get SVG
 * bytes and a success line — and PNG is precisely what someone asks for, since it is the format
 * that posts where SVG does not. Failing loudly costs one retry; succeeding falsely costs a file
 * that no viewer opens and no error explaining why.
 */
export function svgTarget(name: string, flag: string): string {
  if (/\.svg$/i.test(name)) return name;
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1];
  throw new Error(
    ext === undefined
      ? `${flag} needs a filename ending in .svg — got ${JSON.stringify(name)}`
      : `${flag} writes SVG, so it cannot write ${JSON.stringify(name)}. ` +
          `Name it .svg instead; orca does not rasterise to .${ext} yet.`,
  );
}

// ---------------------------------------------------------------------------
// the chain card
// ---------------------------------------------------------------------------

export interface ChainCardMeta {
  runId: string;
}

const CHAIN_ROW = 30;
const CHAIN_HEAD = 96;
const CHAIN_FOOT = 76;
const RAIL_X = 92;

/**
 * One causal chain as a self-contained SVG.
 *
 * The timeline answers "what happened"; this answers "what produced this", which is the shape of
 * the thing worth showing someone else. It carries three things a picture that travels without
 * its trace has to carry on its own face: the claim, stated first; the command that reproduces it;
 * and — where any hop was inferred — the fact that it was, because a dashed line nobody explains
 * launders a guess into a fact.
 *
 * Monochrome and dependency-free for the same reason the viewer is: it has to survive being
 * dropped into an issue, a README, a chat window or a dark-mode client with nothing installed.
 */
export function renderChainCard(graph: RunGraph, meta: ChainCardMeta): string {
  const nodes = [...graph.nodes].sort((a, b) => a.seq - b.seq);
  const inferred = graph.edges.filter((e) => e.kind === 'inferred').length;
  const last = nodes[nodes.length - 1];
  const height = CHAIN_HEAD + Math.max(1, nodes.length) * CHAIN_ROW + CHAIN_FOOT;

  if (nodes.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} 120" width="${WIDTH}" height="120" role="img" aria-label="OrcaReplay causal chain">
<rect width="${WIDTH}" height="120" fill="#0E1214"/>
${text(28, 56, 'Nothing to show — this chain has no events', { size: 15, weight: 600 })}
${text(28, 92, CREDIT_MADE_BY, { size: 10, mono: true, fill: '#6B7578' })}
</svg>`;
  }

  // One segment per hop, each drawn as what that hop actually is. A single rail dashed whenever
  // *any* hop was inferred told the reader every hop was a guess — the legend cannot rescue a
  // picture whose own lines overstate what the trace vouches for.
  const kindOf = new Map(graph.edges.map((e) => [`${e.from}→${e.to}`, e.kind]));
  const rail = nodes
    .slice(0, -1)
    .map((node, i) => {
      const next = nodes[i + 1];
      if (!next) return '';
      const y = CHAIN_HEAD + i * CHAIN_ROW;
      const guessed = kindOf.get(`${node.seq}→${next.seq}`) === 'inferred';
      return `<line x1="${RAIL_X}" y1="${y + 6}" x2="${RAIL_X}" y2="${y + CHAIN_ROW - 6}" stroke="#5A6669" stroke-width="1.5"${
        guessed ? ' stroke-dasharray="4 3"' : ''
      }/>`;
    })
    .join('');

  const rows = nodes
    .map((node, i) => {
      const y = CHAIN_HEAD + i * CHAIN_ROW;
      const terminal = node.seq === last?.seq;
      const detail = detailOf(node);
      return [
        `<circle cx="${RAIL_X}" cy="${y}" r="3.5" fill="${terminal ? '#E8ECEC' : '#0E1214'}" stroke="#9AA4A7" stroke-width="1.5"/>`,
        text(30, y + 4, `seq ${node.seq}`, { size: 11, mono: true, fill: '#6E7B7F' }),
        text(110, y + 4, node.type, { size: 12, mono: true }),
        detail === '' ? '' : text(250, y + 4, detail, { size: 11, mono: true, fill: '#9AA4A7' }),
      ].join('');
    })
    .join('');

  const footTop = height - CHAIN_FOOT + 30;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-label="OrcaReplay causal chain">
<rect width="${WIDTH}" height="${height}" fill="#0E1214"/>
${text(28, 38, headline(last), { size: 16, weight: 600 })}
${text(28, 60, `${meta.runId} · causal chain, ${nodes.length} event${nodes.length === 1 ? '' : 's'}`, { size: 11, mono: true, fill: '#9AA4A7' })}
<line x1="28" y1="76" x2="${WIDTH - 28}" y2="76" stroke="#374043"/>
${rail}${rows}
<line x1="28" y1="${footTop - 18}" x2="${WIDTH - 28}" y2="${footTop - 18}" stroke="#374043"/>
${text(28, footTop, `orca graph ${meta.runId} --to ${last?.seq ?? 0}`, { size: 10, mono: true, fill: '#6E7B7F' })}
${
  inferred > 0
    ? text(WIDTH - 28, footTop, 'dashed = inferred, not recorded', {
        size: 10,
        mono: true,
        fill: '#6E7B7F',
        anchor: 'end',
      })
    : ''
}
${text(28, footTop + 22, CREDIT_MADE_BY, { size: 10, mono: true, fill: '#6B7578' })}
${text(WIDTH - 28, footTop + 22, CREDIT_REPO, { size: 10, mono: true, fill: '#6B7578', anchor: 'end' })}
</svg>`;
}

/**
 * The claim, from the event the chain ends at.
 *
 * Stated as what went wrong rather than as an event type, because a card is read by someone who
 * has not seen the run and may never open it.
 */
function headline(node: GraphNode | undefined): string {
  if (!node) return 'A causal chain';
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case 'shell.result': {
      const code = attrs['exit_code'];
      return typeof code === 'number' && code !== 0
        ? `A command the agent ran exited ${code}`
        : 'A command the agent ran finished';
    }
    case 'tool.result':
      return attrs['is_error'] === true
        ? 'A tool call came back as an error'
        : 'A tool call returned';
    case 'fs.change':
      return `What changed ${String(attrs['path'] ?? 'a file')}`;
    case 'error':
      return 'What led to the error';
    case 'divergence':
      return 'What led to the divergence';
    default:
      return `What produced ${node.type}`;
  }
}

/** The one fact worth reading beside the event type. Never more than a line. */
function detailOf(node: GraphNode): string {
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case 'model.response':
      return String(attrs['stop_reason'] ?? '');
    case 'tool.call':
      return String(attrs['name'] ?? '');
    case 'shell.exec': {
      const argv = attrs['argv'];
      if (!Array.isArray(argv)) return '';
      let longest = '';
      for (const part of argv) {
        if (typeof part === 'string' && part.length > longest.length) longest = part;
      }
      return longest.length > 44 ? `${longest.slice(0, 43)}…` : longest;
    }
    case 'shell.result':
      return `exit ${String(attrs['exit_code'] ?? '?')}`;
    case 'fs.change':
      return String(attrs['path'] ?? '');
    case 'tool.result':
      return attrs['is_error'] === true ? 'error' : 'ok';
    default:
      return '';
  }
}

interface TextOptions {
  size: number;
  weight?: number;
  fill?: string;
  mono?: boolean;
  /** Anchor at `x` rather than starting from it: against the right margin, or centred. */
  anchor?: 'end' | 'middle';
}

function text(x: number, y: number, value: string, options: TextOptions): string {
  const family = options.mono
    ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    : 'system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
  const anchor = options.anchor ? ` text-anchor="${options.anchor}"` : '';
  return `<text x="${x}" y="${y}"${anchor} font-family="${family}" font-size="${
    options.size
  }" font-weight="${options.weight ?? 400}" fill="${
    options.fill ?? '#E8ECEC'
  }">${escapeXml(value)}</text>`;
}

/** Model names come out of a trace, which is someone else's machine. Treat them as untrusted. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function trimCost(amount: number): string {
  if (amount >= 0.01) return amount.toFixed(2);
  if (amount >= 0.0001) return amount.toFixed(6);
  return amount.toExponential(2);
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// ---------------------------------------------------------------------------
// the graph card
// ---------------------------------------------------------------------------

export interface GraphCardMeta {
  runId: string;
  /** Seqs to light up — normally one causal chain. Everything else is drawn dim. */
  highlight: Set<number>;
}

export interface ScopedGraph extends RunGraph {
  /** True when turns were dropped to keep the picture readable. Said on the card. */
  narrowed: boolean;
  /** Events that belong to no lane, or fell outside the scope. Counted on the card. */
  omitted: number;
  turns: number[];
}

/** Which row an event is drawn on. Undefined means it is not part of the loop and is not drawn. */
function laneOf(type: string): 'model' | 'tool' | 'effect' | undefined {
  if (type === 'model.request' || type === 'model.response') return 'model';
  if (type.startsWith('tool.') || type.startsWith('mcp.')) return 'tool';
  if (type.startsWith('shell.') || type.startsWith('fs.change') || type.startsWith('net.')) {
    return 'effect';
  }
  return undefined;
}

const LANE_Y = { model: 118, tool: 194, effect: 270 } as const;
const NODE_X0 = 116;
const NODE_STEP = 66;
const NODE_R = 12;
const GRAPH_HEIGHT = 360;

/**
 * The part of a graph worth drawing, narrowed when a whole run would be a hairball.
 *
 * A pane that draws all 400 events of a real run is strictly worse than the list beside it, so
 * past `max` drawable events this keeps only the turns the highlighted chain touches. Narrowing
 * is recorded rather than silent: a picture of part of a run that looks like a picture of the run
 * is the same failure as an inferred edge that looks recorded.
 */
export function scopeForCard(graph: RunGraph, highlight: Set<number>, max = 18): ScopedGraph {
  const drawable = graph.nodes.filter((n) => laneOf(n.type) !== undefined);
  const undrawable = graph.nodes.length - drawable.length;

  let kept = drawable;
  let narrowed = false;
  if (drawable.length > max) {
    const turns = new Set(drawable.filter((n) => highlight.has(n.seq)).map((n) => n.turn));
    // Nothing highlighted to narrow around: keep the most recent turns instead, since that is
    // where a run ends up and the earlier ones are the cheapest to lose.
    const chosen = turns.size > 0 ? turns : new Set(drawable.slice(-max).map((n) => n.turn));
    kept = drawable.filter((n) => chosen.has(n.turn));
    narrowed = kept.length !== drawable.length;
  }

  const seqs = new Set(kept.map((n) => n.seq));
  return {
    nodes: kept,
    // An edge with one end off the picture would point at nothing.
    edges: graph.edges.filter((e) => seqs.has(e.from) && seqs.has(e.to)),
    narrowed,
    omitted: undrawable + (drawable.length - kept.length),
    turns: [...new Set(kept.map((n) => n.turn))].sort((a, b) => a - b),
  };
}

/**
 * A whole run as a causal graph: time left to right, kind of thing top to bottom.
 *
 * The chain card follows one path; this shows the shape. Two things only the shape gives you —
 * the run's repeating motif, so anything that breaks it is worth a look, and an event with no edge
 * leaving it, which is an absence a list cannot show at all.
 */
export function renderGraphCard(graph: RunGraph | ScopedGraph, meta: GraphCardMeta): string {
  const scoped: ScopedGraph =
    'narrowed' in graph ? graph : scopeForCard(graph, meta.highlight, Number.MAX_SAFE_INTEGER);
  const nodes = [...scoped.nodes].sort((a, b) => a.seq - b.seq);

  if (nodes.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} 120" width="${WIDTH}" height="120" role="img" aria-label="OrcaReplay causal graph">
<rect width="${WIDTH}" height="120" fill="#0E1214"/>
${text(28, 56, 'Nothing to show — this run has no model loop', { size: 15, weight: 600 })}
${text(28, 92, CREDIT_MADE_BY, { size: 10, mono: true, fill: '#6B7578' })}
</svg>`;
  }

  const at = new Map(nodes.map((n, i) => [n.seq, NODE_X0 + i * NODE_STEP]));
  const yOf = (type: string): number => LANE_Y[laneOf(type) ?? 'model'];
  const width = Math.max(WIDTH, NODE_X0 + (nodes.length - 1) * NODE_STEP + 48);

  const bands = scoped.turns
    .map((turn) => {
      const inTurn = nodes.filter((n) => n.turn === turn);
      const first = at.get(inTurn[0]?.seq ?? -1);
      const last = at.get(inTurn[inTurn.length - 1]?.seq ?? -1);
      if (first === undefined || last === undefined) return '';
      const x = first - 26;
      const w = last - first + 52;
      return (
        `<rect x="${x}" y="84" width="${w}" height="216" rx="4" fill="none" stroke="#232A2D" stroke-dasharray="3 3"/>` +
        text(x + w / 2, 76, `TURN ${turn}`, {
          size: 9,
          mono: true,
          fill: '#6E7B7F',
          anchor: 'middle',
        })
      );
    })
    .join('');

  const edges = scoped.edges
    .map((e) => {
      const x1 = at.get(e.from);
      const x2 = at.get(e.to);
      if (x1 === undefined || x2 === undefined) return '';
      const y1 = yOf(nodes.find((n) => n.seq === e.from)?.type ?? '');
      const y2 = yOf(nodes.find((n) => n.seq === e.to)?.type ?? '');
      const lit = meta.highlight.has(e.from) && meta.highlight.has(e.to);
      // Shorten both ends so the line meets the circle rather than running under it.
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ox = (dx / len) * (NODE_R + 3);
      const oy = (dy / len) * (NODE_R + 3);
      return `<line class="e" x1="${(x1 + ox).toFixed(1)}" y1="${(y1 + oy).toFixed(1)}" x2="${(x2 - ox).toFixed(1)}" y2="${(y2 - oy).toFixed(1)}" stroke="${lit ? '#E8ECEC' : '#4A5457'}" stroke-width="${lit ? 1.8 : 1.3}"${e.kind === 'inferred' ? ' stroke-dasharray="4 3"' : ''}/>`;
    })
    .join('');

  const drawn = nodes
    .map((node) => {
      const x = at.get(node.seq) ?? 0;
      const y = yOf(node.type);
      const lit = meta.highlight.has(node.seq);
      return (
        `<circle class="n${lit ? ' on' : ''}" cx="${x}" cy="${y}" r="${NODE_R}" fill="${lit ? '#1C2427' : '#0E1214'}" stroke="${lit ? '#E8ECEC' : '#3A4448'}" stroke-width="${lit ? 2 : 1.4}"/>` +
        text(x, y + 3.5, String(node.seq), {
          size: 9.5,
          mono: true,
          fill: lit ? '#E8ECEC' : '#6E7B7F',
          anchor: 'middle',
        }) +
        // Model edges always descend into the tool lane, so a label below the node sits right on
        // the line leaving it. Above for that lane, below for the rest.
        text(x, laneOf(node.type) === 'model' ? y - 20 : y + 26, shortLabel(node), {
          size: 8.5,
          mono: true,
          fill: lit ? '#9AA4A7' : '#5A6669',
          anchor: 'middle',
        })
      );
    })
    .join('');

  const turnLabel =
    scoped.turns.length === 1
      ? `turn ${scoped.turns[0]}`
      : `turns ${scoped.turns[0]}–${scoped.turns.at(-1)}`;
  const subtitle =
    `${meta.runId} · ${turnLabel} · ${nodes.length} events` +
    (scoped.omitted > 0 ? ` · ${scoped.omitted} not shown` : '') +
    (scoped.narrowed ? ' · narrowed' : '');

  const inferred = scoped.edges.filter((e) => e.kind === 'inferred').length;
  const foot = GRAPH_HEIGHT - 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${GRAPH_HEIGHT}" width="${width}" height="${GRAPH_HEIGHT}" role="img" aria-label="OrcaReplay causal graph">
<rect width="${width}" height="${GRAPH_HEIGHT}" fill="#0E1214"/>
${text(28, 38, 'What caused what', { size: 16, weight: 600 })}
${text(28, 60, subtitle, { size: 11, mono: true, fill: '#9AA4A7' })}
${bands}
${text(16, LANE_Y.model + 4, 'MODEL', { size: 9, mono: true, fill: '#6E7B7F' })}
${text(16, LANE_Y.tool + 4, 'TOOL', { size: 9, mono: true, fill: '#6E7B7F' })}
${text(16, LANE_Y.effect + 4, 'EFFECT', { size: 9, mono: true, fill: '#6E7B7F' })}
${edges}${drawn}
<line x1="28" y1="${foot - 22}" x2="${width - 28}" y2="${foot - 22}" stroke="#374043"/>
${text(28, foot, CREDIT_MADE_BY, { size: 10, mono: true, fill: '#6B7578' })}
${
  inferred > 0
    ? text(width - 28, foot, 'dashed = inferred, not recorded', {
        size: 10,
        mono: true,
        fill: '#6B7578',
        anchor: 'end',
      })
    : text(width - 28, foot, CREDIT_REPO, { size: 10, mono: true, fill: '#6B7578', anchor: 'end' })
}
</svg>`;
}

/** A few characters under a node: enough to tell two of the same type apart. */
function shortLabel(node: GraphNode): string {
  const attrs = node.attrs ?? {};
  const raw = (() => {
    switch (node.type) {
      case 'model.request':
        return 'req';
      case 'model.response':
        return String(attrs['stop_reason'] ?? 'resp');
      case 'tool.call':
        return String(attrs['name'] ?? 'call');
      case 'tool.result':
        return attrs['is_error'] === true ? 'error' : 'result';
      case 'shell.exec':
        return 'exec';
      case 'shell.result':
        return `exit ${String(attrs['exit_code'] ?? '?')}`;
      case 'fs.change':
        return String(attrs['path'] ?? 'file');
      default:
        return node.type.split('.')[1] ?? node.type;
    }
  })();
  return raw.length > 9 ? `${raw.slice(0, 8)}…` : raw;
}
