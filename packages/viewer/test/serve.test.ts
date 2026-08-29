import { afterAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { serveViewer } from '../src/serve.js';
import { ev, resetSeq, tempRunDir, writeRun } from './fixtures.js';

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runDir(): Promise<string> {
  resetSeq();
  const dir = await tempRunDir('serve');
  scratch.push(dir);
  await writeRun(dir, {
    events: [ev({ type: 'run.start' }), ev({ type: 'shell.exec', attrs: { command: 'ls' } })],
  });
  return dir;
}

describe('serveViewer', () => {
  it('serves the rendered trace on loopback and closes cleanly', async () => {
    const server = await serveViewer({ runDir: await runDir(), port: 0 });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const response = await fetch(server.url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/text\/html/);
      const body = await response.text();
      expect(body.startsWith('<!doctype html>')).toBe(true);
      expect(body).toContain('Recorded with OrcaReplay');
      expect(body).toContain('ls');
    } finally {
      await server.close();
    }
    // A trace is sensitive: the socket must actually be gone afterwards.
    const url = server.url;
    await expect(fetch(url)).rejects.toThrow();
  });

  it('refuses to bind anything but loopback', async () => {
    const dir = await runDir();
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com']) {
      await expect(serveViewer({ runDir: dir, host, port: 0 })).rejects.toThrow(/loopback/i);
    }
  });

  it('answers only GET and HEAD on /', async () => {
    const server = await serveViewer({ runDir: await runDir(), port: 0 });
    try {
      expect((await fetch(`${server.url}nope`)).status).toBe(404);
      expect((await fetch(server.url, { method: 'POST' })).status).toBe(405);
      const head = await fetch(server.url, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
    } finally {
      await server.close();
    }
  });

  it('sends a content policy that forbids fetching anything', async () => {
    const server = await serveViewer({ runDir: await runDir(), port: 0 });
    try {
      const response = await fetch(server.url);
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      await server.close();
    }
  });

  it('picks a free port when asked for 0 and reports the real one', async () => {
    const dir = await runDir();
    const a = await serveViewer({ runDir: dir, port: 0 });
    const b = await serveViewer({ runDir: dir, port: 0 });
    try {
      expect(a.url).not.toBe(b.url);
      expect((await fetch(b.url)).status).toBe(200);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
