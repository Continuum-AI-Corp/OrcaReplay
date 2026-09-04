import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_FILENAME,
  bunOptionsWithHook,
  nodeOptionsWithHook,
  writeFetchHook,
} from '../src/install.js';
import { DEFAULT_INSTRUMENTED_HOSTS, hostMatches, rewriteUrl } from '../src/rewrite.js';

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

  it('carries the real matcher, not a copy of it', async () => {
    // The finding this asserts: `rewrite.ts` calls itself the security boundary and is the only
    // thing `rewrite.test.ts` covers, while the hook that actually ran carried a second,
    // hand-written matcher. A fix to one would have gone green without touching the other.
    const source = await readFile(await writeFetchHook(dir), 'utf8');
    expect(source).toContain(rewriteUrl.toString());
    expect(source).toContain(hostMatches.toString());
  });

  it('defaults to the same host list the module does', async () => {
    const source = await readFile(await writeFetchHook(dir), 'utf8');
    expect(source).toContain(DEFAULT_INSTRUMENTED_HOSTS.join(','));
  });

  it('is valid JavaScript that a bare node can load', async () => {
    const path = await writeFetchHook(dir);
    await expect(run(process.execPath, ['--check', path])).resolves.toBeDefined();
  });
});

describe('bunOptionsWithHook', () => {
  it('preloads the hook, because Bun ignores --require in NODE_OPTIONS', () => {
    // Verified, not assumed: with NODE_OPTIONS=--require the hook never runs under Bun and the
    // request goes to the real provider. Bun's own --preload does run it, and BUN_OPTIONS is how
    // that reaches a command orca did not write. grok-cli is the agent this matters for today.
    const composed = bunOptionsWithHook('/run/hook.cjs', undefined);
    expect(composed).toContain('--preload');
    expect(composed).toContain('/run/hook.cjs');
  });

  it('preserves options the user already set, and does not add the hook twice', () => {
    const once = bunOptionsWithHook('/run/hook.cjs', '--smol');
    expect(once).toContain('--smol');
    expect(bunOptionsWithHook('/run/hook.cjs', once)).toBe(once);
  });

  it('quotes a path containing a space', () => {
    expect(bunOptionsWithHook('/Users/a b/hook.cjs', undefined)).toContain('"/Users/a b/hook.cjs"');
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

  /**
   * The quoting is where the parser starts reading a backslash as an escape. Unquoted,
   * `C:\\run\\hook.cjs` reaches the loader intact; quoted, the same path reaches it as
   * `C:runhook.cjs` and the preload is silently not found — so orca worked until the project sat in
   * a directory with a space in its name, and then every run went uninstrumented.
   *
   * Checked against node 22: doubling the backslashes loads the hook, leaving them does not.
   */
  it('escapes backslashes inside the quotes, which the parser would otherwise eat', () => {
    const composed = nodeOptionsWithHook(String.raw`C:\My Projects\run\hook.cjs`, undefined);
    expect(composed).toBe(String.raw`--require "C:\\My Projects\\run\\hook.cjs"`);
  });

  /**
   * The rule is the parser's, not the platform's: a backslash is a legal character in a POSIX
   * filename, and one in a path that also holds a space is mangled exactly the same way.
   */
  it('escapes them on POSIX too, where the same parser reads the same variable', () => {
    const path = '/home/d/a b/od' + String.fromCharCode(92) + 'd/hook.cjs';
    expect(nodeOptionsWithHook(path, undefined)).toContain(
      'od' + String.fromCharCode(92) + String.fromCharCode(92) + 'd',
    );
  });

  /**
   * The guard that stops the hook being added twice has to recognise the path, not one spelling of
   * it. A build from before the escaping left `--require "C:\a b\h.cjs"` in the variable; matching
   * only the new spelling appends a second `--require` and leaves the unreadable one to be loaded
   * first, so the run dies exactly as it did before the fix.
   */
  it('replaces an unescaped hook left by an older build rather than adding a second', () => {
    const path = String.raw`C:\My Projects\run\hook.cjs`;
    const stale = `--require "${path}"`;
    const composed = nodeOptionsWithHook(path, stale);
    expect(composed.match(/--require/g)).toHaveLength(1);
    expect(composed).toBe(String.raw`--require "C:\\My Projects\\run\\hook.cjs"`);
  });

  /** A path with no space is not quoted, so nothing is escaped and nothing needs to be. */
  it('leaves an unquoted path exactly as it was', () => {
    const path = String.raw`C:\run\hook.cjs`;
    expect(nodeOptionsWithHook(path, undefined)).toBe(`--require ${path}`);
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

/**
 * The same hook, under Bun.
 *
 * Skipped where `bun` is not installed — CI runners have Node only — but it is the test that
 * caught the gap: with `NODE_OPTIONS=--require` the hook silently does not run under Bun, and the
 * agent's traffic goes to the real provider unrecorded. An agent that quietly escapes capture is
 * exactly what this package exists to prevent, so the escape hatch gets a real runtime.
 */
const hasBun = (() => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasBun)('the hook under Bun', () => {
  let dir: string;
  let seen: string[];
  let server: ReturnType<typeof createServer>;
  let url: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-hook-bun-'));
    seen = [];
    server = createServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => void server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  const AGENT = `
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"x"}',
    });
    console.log(r.status);
  `;

  it('runs when BUN_OPTIONS carries --preload', async () => {
    const hook = await writeFetchHook(dir);
    const agent = join(dir, 'agent.mjs');
    await writeFile(agent, AGENT);

    await run('bun', [agent], {
      env: {
        ...process.env,
        ORCA_PROXY_URL: url,
        BUN_OPTIONS: bunOptionsWithHook(hook, undefined),
      },
    });

    expect(seen).toEqual(['/v1/responses']);
  });

  it('is what the node adapter sets, so `orca record node` covers a Bun agent', async () => {
    // NODE_OPTIONS alone is not enough here, which is the whole reason BUN_OPTIONS is set too.
    const hook = await writeFetchHook(dir);
    expect(nodeOptionsWithHook(hook, undefined)).toContain('--require');
    expect(bunOptionsWithHook(hook, undefined)).toContain('--preload');
  });
});
