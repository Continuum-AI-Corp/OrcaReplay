import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeAdapter } from '@orcareplay/adapters';
import { TraceWriter } from '@orcareplay/core';
import { createProxy, type RecordedExchange } from '@orcareplay/proxy';
import { appendDerivedEvents, ExchangeEventDeriver } from '../src/exchange-events.js';

const exec = promisify(execFile);
const CHATGPT = 'https://chatgpt.com/backend-api/codex/responses';
const API = 'https://api.openai.com/v1/responses';
const MODEL = 'gpt-5.4';
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function reply() {
  const item = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'captured', annotations: [] }],
  };
  const response = {
    id: 'resp_fixture',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: MODEL,
    output: [item],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: 'captured',
    },
    {
      type: 'response.output_text.done',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: 'captured',
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  return events
    .map(
      (event, sequence_number) =>
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
    )
    .join('');
}

async function setup(oauth: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'orca-opencode-e2e-'));
  closers.push(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q'], { cwd: root });
  const writer = await TraceWriter.create(join(root, '.orca/runs'), {
    adapter: { id: 'opencode' },
    argv: [],
    cwd: root,
    orcaVersion: 'test',
  });
  closers.push(() => writer.close());
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const proxy = await createProxy({
    mode: 'record',
    // A gateway default must never receive this subscription credential.
    upstream: { codex: 'https://gateway.invalid' },
    upstreamHeaders: { authorization: 'Bearer gateway-secret' },
    upstreamHeadersOrigin: 'https://gateway.invalid',
    fetchImpl: (async (url, init) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return new Response(reply(), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch,
  });
  closers.push(proxy.close);

  // Even a broken adapter must never send the fixture credentials to a live service.
  const guard = join(root, 'guard.mjs');
  await writeFile(
    guard,
    `
    export default async function () {
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return original(input, init);
        return Promise.resolve(new Response(JSON.stringify({ error: { message: 'uncaptured external request', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } }));
      };
      Object.assign(globalThis.fetch, original);
      return {};
    }
  `,
  );
  const env = {
    PATH: process.platform === 'win32' ? (process.env.PATH ?? '') : '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_FFF: '1',
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
    npm_config_offline: 'true',
    npm_config_fetch_retries: '0',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      plugin: [pathToFileURL(guard).href],
      enabled_providers: ['openai'],
      model: `openai/${MODEL}`,
      small_model: `openai/${MODEL}`,
      provider: { openai: { models: { [MODEL]: { name: MODEL } } } },
    }),
  };
  // These fixtures import no plugin SDK. Satisfy OpenCode's dependency bookkeeping locally so
  // an empty test home does not spend the test downloading @opencode-ai/plugin and its tree.
  const configDir = join(env.XDG_CONFIG_HOME, 'opencode');
  await mkdir(join(configDir, 'node_modules'), { recursive: true });
  await writeFile(
    join(configDir, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { '@opencode-ai/plugin': '1.18.29' } } },
    }),
  );
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true });
  await writeFile(
    join(env.XDG_DATA_HOME, 'opencode/auth.json'),
    JSON.stringify({
      openai: oauth
        ? {
            type: 'oauth',
            access: 'fixture-access',
            refresh: 'fixture-refresh',
            expires: Date.now() + 3600000,
            accountId: 'fixture-account',
          }
        : { type: 'api', key: 'fixture-api-key' },
    }),
  );
  const launch = await openCodeAdapter.prepare({
    runId: writer.runId,
    runDir: writer.runDir,
    cwd: root,
    proxyUrl: proxy.url,
    userArgs: ['run', '-m', `openai/${MODEL}`, 'Reply with captured. Do not use tools.'],
    env,
  });
  // No invented credentials in the harness test: auth.json is the fixture's authority.
  delete launch.env.OPENAI_API_KEY;
  delete launch.env.ANTHROPIC_API_KEY;
  return { root, writer, proxy, calls, launch, env: { ...env, ...launch.env } };
}

async function verifyTrace(s: Awaited<ReturnType<typeof setup>>, oauth: boolean) {
  expect(s.calls.length).toBeGreaterThan(0);
  for (const call of s.calls) {
    expect(call.url).toBe(oauth ? CHATGPT : API);
    expect(call.headers.get('authorization')).toBe(
      `Bearer ${oauth ? 'fixture-access' : 'fixture-api-key'}`,
    );
    if (oauth) expect(call.headers.get('chatgpt-account-id')).toBe('fixture-account');
    expect(JSON.parse(call.body).model).toBe(MODEL);
  }
  const exchanges = s.proxy.exchanges();
  const deriver = new ExchangeEventDeriver();
  for (const [i, exchange] of exchanges.entries()) {
    expect(exchange.dialect).toBe(oauth ? 'codex' : 'openai-responses');
    expect(exchange.streamed).toBe(true);
    await appendDerivedEvents(s.writer, deriver, exchange, i + 1);
  }
  const text = await readFile(join(s.writer.runDir, 'events.jsonl'), 'utf8');
  const events = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events.filter((e) => e.type === 'model.request')).toHaveLength(exchanges.length);
  expect(events.filter((e) => e.type === 'model.response')).toHaveLength(exchanges.length);
  expect(events.find((e) => e.type === 'model.response').attrs).toMatchObject({
    status: 200,
    output_tokens: 2,
  });
  expect(JSON.stringify(exchanges) + text).not.toMatch(
    /fixture-access|fixture-api-key|gateway-secret/,
  );
  return exchanges;
}

describe('OpenCode capture through emitted plugin, proxy and events.jsonl', () => {
  it.each([true, false])('records and replays the final fetch (OAuth=%s)', async (oauth) => {
    const s = await setup(oauth);
    const script = `
      for (const spec of JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).plugin) await (await import(spec)).default();
      const response = await fetch(${JSON.stringify(oauth ? CHATGPT : API)}, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ${oauth ? 'fixture-access' : 'fixture-api-key'}', 'ChatGPT-Account-Id': 'fixture-account' },
        body: JSON.stringify({ model: '${MODEL}', input: [{ role: 'user', content: 'hello' }], stream: true })
      });
      if (response.status !== 200 || !(await response.text()).includes('captured')) process.exit(1);
    `;
    await exec(process.execPath, ['--input-type=module', '-e', script], {
      env: s.env,
      cwd: s.root,
    });
    const exchanges = await verifyTrace(s, oauth);
    const replay = await createProxy({
      mode: 'replay',
      exchanges: exchanges as RecordedExchange[],
      fetchImpl: (async () => {
        throw new Error('replay went live');
      }) as typeof fetch,
    });
    closers.push(replay.close);
    const launch = await openCodeAdapter.prepare({
      runId: s.writer.runId,
      runDir: join(s.root, 'replay'),
      cwd: s.root,
      proxyUrl: replay.url,
      env: { ...s.env, OPENCODE_CONFIG_CONTENT: s.launch.env.OPENCODE_CONFIG_CONTENT },
      userArgs: [],
    });
    await exec(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...s.env, ...launch.env },
      cwd: s.root,
    });
    expect(s.calls).toHaveLength(1);
    expect(replay.stats().matchedExact).toBe(1);
  });
});

// Opt in with ORCA_TEST_OPENCODE=/absolute/path/to/opencode. Real compiled harness, fake auth,
// local upstream stub, isolated configuration/data, and a guard against direct external fetches.
describe.skipIf(!process.env.ORCA_TEST_OPENCODE)('installed OpenCode harness', () => {
  it('reproduces the OAuth bypass without the capture plugin', async () => {
    const s = await setup(true);
    const config = JSON.parse(s.env.OPENCODE_CONFIG_CONTENT);
    config.plugin = config.plugin.filter(
      (spec: string) => !spec.endsWith('/orca-opencode-capture.mjs'),
    );
    const pending = exec(process.env.ORCA_TEST_OPENCODE!, s.launch.args, {
      env: { ...s.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      cwd: s.root,
      timeout: 45000,
      maxBuffer: 2 * 1024 * 1024,
    });
    pending.child.stdin?.end();
    await expect(pending).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('uncaptured external request'),
    });
    expect(s.calls).toHaveLength(0);
    expect(s.proxy.exchanges()).toHaveLength(0);
  }, 60000);

  it.each([true, false])(
    'records actual OpenCode model calls (OAuth=%s)',
    async (oauth) => {
      const s = await setup(oauth);
      const pending = exec(
        process.env.ORCA_TEST_OPENCODE!,
        ['--print-logs', '--log-level', 'DEBUG', ...s.launch.args],
        {
          env: s.env,
          cwd: s.root,
          timeout: 45000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      // OpenCode reads piped stdin even with a prompt argument. execFile leaves it open by default.
      pending.child.stdin?.end();
      const result = await pending;
      expect(result.stdout + result.stderr).toContain('captured');
      await verifyTrace(s, oauth);
    },
    60000,
  );
});
