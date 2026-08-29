/**
 * Minifies the client runtime for inlining.
 *
 * esbuild is a repo-root build tool, not a dependency of this package: a published
 * `@orcareplay/viewer` ships `dist` only and must render without it. So the import is dynamic
 * and guarded, and the readable source is a first-class fallback rather than an error path —
 * `renderTraceHtml` stays synchronous and correct either way.
 */

import { CLIENT_SOURCE } from './client/main.js';

/** The client runtime as a single minified IIFE with no imports. */
export async function bundleViewerScript(): Promise<string> {
  try {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
      stdin: { contents: CLIENT_SOURCE, loader: 'js', sourcefile: 'orca-viewer-client.js' },
      bundle: true,
      format: 'iife',
      target: 'es2019',
      minify: true,
      write: false,
      legalComments: 'none',
    });
    const text = result.outputFiles?.[0]?.text;
    return text ? text.trim() : CLIENT_SOURCE;
  } catch {
    // No esbuild (published install, offline CI): ship the readable source. Same behaviour,
    // a few kilobytes larger. Never a reason to fail an export.
    return CLIENT_SOURCE;
  }
}
