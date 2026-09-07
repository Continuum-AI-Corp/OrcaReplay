import { execFile } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const MODEL = 'claude-sonnet-4-6';
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function message(model: string) {
  return {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'captured' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

function stream(model: string) {
  const events = [
    {
      type: 'message_start',
      message: {
        ...message(model),
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'captured' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

async function setup(binary: string) {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-capture-'));
  closers.push(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q'], { cwd: root });
  const calls: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const paths: string[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const path = new URL(req.url!, 'http://fixture').pathname;
    paths.push(path);
    if (path === '/v1/messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":10}');
      return;
    }
    if (path !== '/v1/messages') {
      res.writeHead(404).end();
      return;
    }
    calls.push({ path, headers: req.headers, body });
    res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' });
    res.end(body.stream ? stream(body.model) : JSON.stringify(message(body.model)));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  // Block unintended external requests from the isolated harness, including OAuth profile lookups.
  const deny = createServer((_req, res) => res.writeHead(403).end());
  deny.on('connect', (_req, socket) => {
    socket.on('error', () => undefined);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise<void>((resolve) => deny.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => deny.close(() => resolve())));
  const denyUrl = `http://127.0.0.1:${(deny.address() as { port: number }).port}`;
  const env: Record<string, string> = {
    PATH: [dirname(binary), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    HOME: root,
    USERPROFILE: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    HTTP_PROXY: denyUrl,
    HTTPS_PROXY: denyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  };
  return { root, calls, paths, upstreamUrl, env };
}

async function record(s: Awaited<ReturnType<typeof setup>>, adapter: string, args: string[]) {
  const pending = exec(
    process.execPath,
    [
      CLI,
      'record',
      adapter,
      '--no-fs',
      '--no-shell',
      '--json',
      '--upstream-anthropic',
      s.upstreamUrl,
      '--',
      ...args,
    ],
    {
      cwd: s.root,
      env: s.env,
      timeout: 45000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  pending.child.stdin?.end();
  const result = await pending.catch((error) => {
    throw new Error(`${String(error)}\nObserved upstream paths: ${JSON.stringify(s.paths)}`);
  });
  const recorded = JSON.parse(result.stdout);
  expect(recorded.exitCode, result.stderr).toBe(0);
  expect(recorded.modelExchanges).toBeGreaterThan(0);
  const raw = await readFile(join(recorded.runDir, 'events.jsonl'), 'utf8');
  const events = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events.filter((e) => e.type === 'model.request')).toHaveLength(recorded.modelExchanges);
  expect(events.filter((e) => e.type === 'model.response')).toHaveLength(recorded.modelExchanges);
  expect(
    events.filter((e) => e.type === 'model.response').every((e) => e.attrs.status === 200),
  ).toBe(true);
  expect(
    events.some(
      (e) => e.type === 'model.response' && e.attrs.streamed && e.attrs.output_tokens === 2,
    ),
  ).toBe(true);
  expect(raw).not.toMatch(/fixture-api-secret|fixture-oauth-secret|fixture-bearer-secret/);
  return recorded;
}

// Build first; opt in with absolute installed binary paths. No real accounts or user config.
describe.skipIf(!process.env.ORCA_TEST_CLAUDE)('installed Claude Code through orca record', () => {
  it.each(['api', 'bearer', 'oauth'] as const)(
    'records %s authentication and SSE',
    async (auth) => {
      const s = await setup(process.env.ORCA_TEST_CLAUDE!);
      const secret = `fixture-${auth}-secret`;
      s.env[
        auth === 'api'
          ? 'ANTHROPIC_API_KEY'
          : auth === 'bearer'
            ? 'ANTHROPIC_AUTH_TOKEN'
            : 'CLAUDE_CODE_OAUTH_TOKEN'
      ] = secret;
      await record(s, 'claude', [
        '-p',
        'Reply with captured.',
        '--model',
        MODEL,
        '--tools',
        '',
        '--safe-mode',
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--system-prompt',
        'Reply briefly.',
      ]);
      expect(s.calls.length).toBeGreaterThan(0);
      for (const call of s.calls) {
        expect(call.body.model).toBe(MODEL);
        expect(call.headers[auth === 'api' ? 'x-api-key' : 'authorization']).toBe(
          auth === 'api' ? secret : `Bearer ${secret}`,
        );
        if (auth === 'oauth') expect(call.headers['anthropic-beta']).toContain('oauth-2025-04-20');
      }
    },
    60000,
  );
});

describe.skipIf(!process.env.ORCA_TEST_OPENCODE)('OpenCode Anthropic through orca record', () => {
  it('records Claude model requests with an API key', async () => {
    const s = await setup(process.env.ORCA_TEST_OPENCODE!);
    s.env.ANTHROPIC_API_KEY = 'fixture-api-secret';
    Object.assign(s.env, {
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_FFF: '1',
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        enabled_providers: ['anthropic'],
        model: `anthropic/${MODEL}`,
        small_model: `anthropic/${MODEL}`,
        provider: { anthropic: { models: { [MODEL]: { name: MODEL } } } },
      }),
    });
    const configDir = join(s.env.XDG_CONFIG_HOME!, 'opencode');
    await mkdir(join(configDir, 'node_modules'), { recursive: true });
    await writeFile(
      join(configDir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { dependencies: { '@opencode-ai/plugin': '1.18.29' } } },
      }),
    );
    await record(s, 'opencode', [
      'run',
      '-m',
      `anthropic/${MODEL}`,
      'Reply with captured. Do not use tools.',
    ]);
    for (const call of s.calls) expect(call.headers['x-api-key']).toBe('fixture-api-secret');
  }, 60000);
});
