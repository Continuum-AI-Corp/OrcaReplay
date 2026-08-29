/**
 * Serves the same rendered document over loopback, for `orca view`.
 *
 * A trace is sensitive material (spec §5), so this binds 127.0.0.1 and refuses anything else —
 * there is no flag to open it to the network, on purpose.
 */

import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { renderTraceHtml, type RenderOptions } from './html.js';
import { readTraceDir, type ReadTraceOptions } from './trace-dir.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Blocks every fetch the page could attempt. It should never need one. */
const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'img-src data:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

export interface ServeOptions extends ReadTraceOptions, RenderOptions {
  runDir: string;
  /** 0 (the default) picks a free port; the real one comes back in `url`. */
  port?: number;
  /** Loopback only: 127.0.0.1 (default), localhost or ::1. */
  host?: string;
}

export interface ViewerServer {
  url: string;
  close(): Promise<void>;
}

export async function serveViewer(options: ServeOptions): Promise<ViewerServer> {
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `serveViewer binds loopback only; refusing host "${host}". A trace is sensitive material.`,
    );
  }

  let cache: { key: string; html: string } | null = null;

  async function stamp(): Promise<string> {
    try {
      const info = await stat(join(options.runDir, 'events.jsonl'));
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return 'absent';
    }
  }

  // Re-render only when events.jsonl has moved, so a live run can be watched with refresh.
  async function document(): Promise<string> {
    const key = await stamp();
    if (cache && cache.key === key) return cache.html;
    const { manifest, events, blobs } = await readTraceDir(options.runDir, options);
    const html = renderTraceHtml({ manifest, events, blobs }, options);
    cache = { key, html };
    return html;
  }

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed\n');
        return;
      }
      const path = (req.url ?? '/').split('?')[0];
      if (path !== '/' && path !== '/index.html') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found\n');
        return;
      }
      try {
        const body = Buffer.from(await document(), 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(body.byteLength),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': CSP,
        });
        res.end(method === 'HEAD' ? undefined : body);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`${(error as Error).message}\n`);
      }
    })();
  });

  await new Promise<void>((settle, fail) => {
    server.once('error', fail);
    server.listen({ host, port: options.port ?? 0, exclusive: true }, () => {
      server.off('error', fail);
      settle();
    });
  });

  const address = server.address() as AddressInfo;
  const shown = address.address.includes(':') ? `[${address.address}]` : address.address;

  return {
    url: `http://${shown}:${address.port}/`,
    close: () =>
      new Promise<void>((settle, fail) => {
        server.closeAllConnections();
        server.close((error) => (error ? fail(error) : settle()));
      }),
  };
}
