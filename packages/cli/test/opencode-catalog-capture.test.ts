import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeAdapter } from '@orcareplay/adapters';
import { TraceWriter } from '@orcareplay/core';
import { createProxy, type NetExchange } from '@orcareplay/proxy';
import { appendDerivedEvents, ExchangeEventDeriver } from '../src/exchange-events.js';
import { persistNetExchange } from '../src/tls-capture.js';

const exec = promisify(execFile);
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const endpoints = [
  'https://api.z.ai/api/coding/paas/v4/chat/completions',
  'https://openrouter.ai/api/v1/chat/completions',
  'https://api.minimax.io/anthropic/v1/messages',
  // A model-specific override with a different origin than its provider's default.
  'https://api.freemodel.dev/v1/responses',
  'https://api.cloudflare.com/client/v4/accounts/account-fixture/ai/v1/chat/completions',
  'http://127.0.0.1:1234/v1/chat/completions',
  'https://new-catalog-provider.test/predict',
  // A model-specific Google transport is monitored as opaque network traffic.
  'https://api.ofox.ai/gemini/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse',
];

describe('OpenCode catalog capture through emitted plugin and real proxy', () => {
  it('refreshes new APIs, records catalog calls, and replays supported dialects offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-catalog-e2e-'));
    closers.push(() => rm(root, { recursive: true, force: true }));
    const writer = await TraceWriter.create(join(root, 'runs'), {
      adapter: { id: 'opencode' },
      argv: [],
      cwd: root,
      orcaVersion: 'test',
    });
    closers.push(() => writer.close());
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const opaque: NetExchange[] = [];
    const proxy = await createProxy({
      mode: 'record',
      upstream: { openai: 'https://wrong-gateway.invalid' },
      upstreamHeaders: { authorization: 'Bearer wrong-gateway-fixture' },
      upstreamHeadersOrigin: 'https://wrong-gateway.invalid',
      onNetExchange: (exchange) => void opaque.push(exchange),
      fetchImpl: (async (url, init) => {
        calls.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        // One reply includes fields for each supported dialect; opaque bodies pass unchanged.
        return Response.json({
          id: 'reply-fixture',
          model: 'fixture-model',
          choices: [{ message: { role: 'assistant', content: 'captured' }, finish_reason: 'stop' }],
          content: [{ type: 'text', text: 'captured' }],
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'captured' }],
            },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 1 },
        });
      }) as typeof fetch,
    });
    closers.push(proxy.close);
    const launch = await openCodeAdapter.prepare({
      runId: writer.runId,
      runDir: writer.runDir,
      cwd: root,
      proxyUrl: proxy.url,
      userArgs: [],
      env: { OPENCODE_CONFIG_CONTENT: '{}' },
    });
    const script = `
      const native = globalThis.fetch;
      let catalogCalls = 0;
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.href === 'https://models.opencode.ai/api.json') {
          catalogCalls++;
          return Promise.resolve(Response.json({ added: { api: 'https://new-catalog-provider.test/predict' } }));
        }
        if (url.origin !== process.env.TEST_PROXY) throw new Error('uncaptured request: ' + url.href);
        return native(input, init);
      };
      for (const spec of JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).plugin) await (await import(spec)).default();
      if (catalogCalls !== Number(process.env.TEST_CATALOG_CALLS)) throw new Error('catalog refresh count');
      for (const url of JSON.parse(process.env.TEST_URLS)) {
        const response = await fetch(new Request(url, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer provider-fixture' },
          body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }], input: 'hello' }),
        }));
        if (!response.ok || !(await response.text()).includes('captured')) throw new Error('capture failed');
      }
    `;
    const env = {
      ...launch.env,
      CLOUDFLARE_ACCOUNT_ID: 'account-fixture',
      TEST_PROXY: proxy.url,
      TEST_URLS: JSON.stringify(endpoints),
      TEST_CATALOG_CALLS: '1',
    };
    await exec(process.execPath, ['--input-type=module', '-e', script], { env, cwd: root });
    expect(calls.map((call) => call.url)).toEqual(endpoints);
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe('Bearer provider-fixture');
      expect(JSON.parse(call.body).model).toBe('fixture-model');
    }
    expect(proxy.exchanges().map((e) => e.dialect)).toEqual([
      'openai',
      'openai',
      'anthropic',
      'openai-responses',
      'openai',
      'openai',
    ]);
    expect(opaque).toHaveLength(2);
    const deriver = new ExchangeEventDeriver();
    for (const [i, exchange] of proxy.exchanges().entries())
      await appendDerivedEvents(writer, deriver, exchange, i + 1);
    for (const exchange of opaque) await persistNetExchange(writer, 7, exchange);
    const text = await readFile(join(writer.runDir, 'events.jsonl'), 'utf8');
    const events = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.filter((e) => e.type === 'model.request')).toHaveLength(6);
    expect(events.filter((e) => e.type === 'model.response')).toHaveLength(6);
    expect(events.filter((e) => e.type === 'net.request')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'net.response')).toHaveLength(2);
    expect(text + JSON.stringify(proxy.exchanges()) + JSON.stringify(opaque)).not.toMatch(
      /provider-fixture|wrong-gateway-fixture/,
    );

    const replay = await createProxy({
      mode: 'replay',
      exchanges: proxy.exchanges(),
      fetchImpl: (async () => {
        throw new Error('replay went live');
      }) as typeof fetch,
    });
    closers.push(replay.close);
    const replayLaunch = await openCodeAdapter.prepare({
      runId: writer.runId,
      runDir: join(root, 'replay'),
      cwd: root,
      proxyUrl: replay.url,
      userArgs: [],
      env: { OPENCODE_CONFIG_CONTENT: '{}' },
    });
    await exec(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      env: {
        ...env,
        ...replayLaunch.env,
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        TEST_PROXY: replay.url,
        TEST_CATALOG_CALLS: '0',
        TEST_URLS: JSON.stringify(endpoints.slice(0, 6)),
      },
    });
    expect(replay.stats().matchedExact).toBe(6);
    expect(calls).toHaveLength(endpoints.length);
  });
});
