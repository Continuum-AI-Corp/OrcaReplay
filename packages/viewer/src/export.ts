/**
 * Writes one run directory out as a single HTML file — the artefact you attach to an issue.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { renderTraceHtml } from './html.js';
import { readTraceDir, type ReadTraceOptions } from './trace-dir.js';

export interface ExportOptions extends ReadTraceOptions {
  /** Client runtime to inline; pass `await bundleViewerScript()` for a smaller file. */
  script?: string;
  maxInlineChars?: number;
}

export interface ExportResult {
  bytes: number;
  path: string;
}

/**
 * Reads `runDir` (manifest.json + events.jsonl + blobs/) and writes a self-contained document
 * to `outPath`. Blob bytes past `maxBlobBytes` (8 MB by default) become "payload omitted"
 * placeholders rather than a file nobody can open.
 */
export async function exportTraceHtml(
  runDir: string,
  outPath: string,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const { manifest, events, blobs } = await readTraceDir(runDir, options);
  const html = renderTraceHtml({ manifest, events, blobs }, options);
  const target = resolve(outPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, html, 'utf8');
  return { bytes: Buffer.byteLength(html, 'utf8'), path: target };
}
