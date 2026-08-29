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
${text(28, height - 16, 'Recorded with OrcaReplay · github.com/Continuum-AI-Corp/OrcaReplay', { size: 11, mono: true, fill: '#6B7578' })}
</svg>`;
}

interface TextOptions {
  size: number;
  weight?: number;
  fill?: string;
  mono?: boolean;
}

function text(x: number, y: number, value: string, options: TextOptions): string {
  const family = options.mono
    ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    : 'system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${options.size}" font-weight="${
    options.weight ?? 400
  }" fill="${options.fill ?? '#E8ECEC'}">${escapeXml(value)}</text>`;
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
