import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_FILENAME, nodeOptionsWithHook, writeFetchHook } from '../src/install.js';

const run = promisify(execFile);

/**
 * Delivering the hook into an agent that is not ours.
 *
 * The hook cannot `require` anything of orca's: it runs inside the agent's process, which has its
 * own `node_modules` and no reason to contain ours. So it is written out as one self-contained
 * file, the way the shell shim and the MCP config rewrite already work.
 */
describe('writeFetchHook', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-hook-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes one file inside the directory it was given', async () => {
    const path = await writeFetchHook(dir);
    expect(path).toBe(join(dir, HOOK_FILENAME));
    expect((await readFile(path, 'utf8')).length).toBeGreaterThan(200);
  });

  it('is self-contained — it reaches into no package', async () => {
    // The check that matters. A `require('@orcareplay/...')` here resolves against the *agent's*
    // dependency tree and throws before its first line runs, taking the whole run with it.
    const source = await readFile(await writeFetchHook(dir), 'utf8');
    expect(source).not.toMatch(/require\(\s*['"][@.]/);
    expect(source).not.toContain('@orcareplay');
  });

  it('writes the same bytes every time, so replay prepares an identical launch', async () => {
    const first = await readFile(await writeFetchHook(dir), 'utf8');
    const second = await readFile(await writeFetchHook(dir), 'utf8');
    expect(first).toBe(second);
  });

  it('is valid JavaScript that a bare node can load', async () => {
    const path = await writeFetchHook(dir);
    await expect(run(process.execPath, ['--check', path])).resolves.toBeDefined();
  });
});

describe('nodeOptionsWithHook', () => {
  it('preserves options the user already set', () => {
    const composed = nodeOptionsWithHook('/run/hook.cjs', '--max-old-space-size=4096');
    expect(composed).toContain('--max-old-space-size=4096');
    expect(composed).toContain('--require');
    expect(composed).toContain('/run/hook.cjs');
  });

  it('quotes a path containing a space, which NODE_OPTIONS splits on', () => {
    const composed = nodeOptionsWithHook('/Users/a b/run/hook.cjs', undefined);
    expect(composed).toContain('"/Users/a b/run/hook.cjs"');
  });

  it('does not add the hook twice', () => {
    const once = nodeOptionsWithHook('/run/hook.cjs', undefined);
    expect(nodeOptionsWithHook('/run/hook.cjs', once)).toBe(once);
  });
});

/**
 * The proof: a real child process, an agent that reads no environment variable and hardcodes
 * `https://api.openai.com`, and no network. This is what `@ai-sdk/openai` does.
 */
describe('the hook, in a real child process', () => {
  let dir: string;
  let seen: { path: string; body: string }[];
  let server: ReturnType<typeof createServer>;
  let url: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-hook-e2e-'));
    seen = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => void server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  async function runAgent(source: string, env: Record<string, string> = {}) {
    const hook = await writeFetchHook(dir);
    const agent = join(dir, 'agent.mjs');
    await writeFile(agent, source);
    return run(process.execPath, ['--require', hook, agent], {
      env: { ...process.env, ORCA_PROXY_URL: url, ...env },
    });
  }

  const HARDCODED = `
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    });
    console.log(JSON.stringify(await res.json()));
  `;

  it('redirects a hardcoded provider URL to the proxy', async () => {
    const { stdout } = await runAgent(HARDCODED);
    expect(JSON.parse(stdout.trim())).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/v1/chat/completions');
    expect(seen[0]!.body).toContain('gpt-5.2');
  });

  it('carries the method, headers and body across, not just the URL', async () => {
    await runAgent(`
      await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-marker': 'kept' },
        body: JSON.stringify({ model: 'gpt-5.2', input: 'hello' }),
      });
    `);
    expect(seen[0]!.path).toBe('/v1/responses');
    expect(seen[0]!.body).toContain('hello');
  });

  it('redirects a Request object as well as a string', async () => {
    // The AI SDK builds a Request and hands it to fetch; rewriting only strings misses it.
    await runAgent(`
      const req = new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.2', input: 'via Request' }),
      });
      await fetch(req);
    `);
    expect(seen[0]!.path).toBe('/v1/responses');
    expect(seen[0]!.body).toContain('via Request');
  });

  it('leaves an unrelated host to fail on its own, rather than swallowing it', async () => {
    // Silently answering someone else's telemetry call with the proxy's reply would be a worse
    // bug than not capturing anything.
    await runAgent(`
      try { await fetch('https://registry.npmjs.org/react'); } catch { console.log('unreached'); }
    `);
    expect(seen).toHaveLength(0);
  });

  it('does nothing when ORCA_PROXY_URL is absent, so the file is inert outside a recording', async () => {
    const hook = await writeFetchHook(dir);
    const agent = join(dir, 'inert.mjs');
    await writeFile(agent, `console.log(typeof fetch);`);
    const { stdout } = await run(process.execPath, ['--require', hook, agent], {
      env: { ...process.env, ORCA_PROXY_URL: '' },
    });
    expect(stdout.trim()).toBe('function');
    expect(seen).toHaveLength(0);
  });

  it('never takes the agent down, whatever it is handed', async () => {
    const { stdout } = await runAgent(`
      try { await fetch('::::not a url::::'); } catch { }
      console.log('agent survived');
    `);
    expect(stdout).toContain('agent survived');
  });
});

/**
 * The body of a rewritten `Request`.
 *
 * Rebuilding with `new Request(newUrl, oldRequest)` looks right and loses the body: a Request's
 * own `body` is a stream, and passing it back in as an init is not the same thing as passing the
 * bytes. The proxy then receives an empty body — which, for a JSON dialect, is a request it cannot
 * read at all. Half a run captured, and the half that is missing is the one with the tool results.
 */
describe('the body of a rewritten Request', () => {
  let dir: string;
  let seen: { path: string; body: string; method: string; marker?: string }[];
  let server: ReturnType<typeof createServer>;
  let url: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-hook-body-'));
    seen = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          path: req.url ?? '',
          method: req.method ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          marker: req.headers['x-marker'] as string | undefined,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => void server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  async function runAgent(source: string) {
    const hook = await writeFetchHook(dir);
    const agent = join(dir, 'agent.mjs');
    await writeFile(agent, source);
    return run(process.execPath, ['--require', hook, agent], {
      env: { ...process.env, ORCA_PROXY_URL: url },
    });
  }

  it('arrives whole, for a body big enough to be chunked', async () => {
    const payload = JSON.stringify({ model: 'gpt-5.2', input: 'x'.repeat(20000) });
    await runAgent(`
      const req = new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-marker': 'kept' },
        body: ${JSON.stringify(payload)},
      });
      await fetch(req);
    `);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.marker).toBe('kept');
    expect(seen[0]!.body).toBe(payload);
  });

  it('survives a Request carrying an abort signal', async () => {
    // Real SDKs attach one. Dropping or mishandling it turns a working call into a hang.
    await runAgent(`
      const req = new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"gpt-5.2"}',
        signal: AbortSignal.timeout(5000),
      });
      const res = await fetch(req);
      if (!res.ok) throw new Error('status ' + res.status);
    `);
    expect(seen[0]!.body).toBe('{"model":"gpt-5.2"}');
  });

  it('leaves a bodyless GET alone', async () => {
    await runAgent(`await fetch(new Request('https://api.openai.com/v1/models'));`);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.body).toBe('');
  });
});
