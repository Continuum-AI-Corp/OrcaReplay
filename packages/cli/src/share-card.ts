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
  /** Anchor at `x` rather than starting from it, for text set against the right margin. */
  anchor?: 'end';
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
