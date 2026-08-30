import { execFile } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orca } from '../src/api.js';
import { MCP_TOOLS, handleMcpMessage, serveMcp } from '../src/mcp-server.js';
import { startResponsesModel } from './fixtures/responses-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const AGENT = join(here, 'fixtures', 'responses-agent.mjs');

/**
 * Orca as tools an agent can call.
 *
 * The MCP shim in this repo records an agent's *own* MCP traffic. It is a tee, not a server, so
 * nothing has ever let an agent ask orca a question — and "replay my last run and tell me what
 * diverged" is the single most useful thing an agent could ask a replay debugger.
 *
 * Built on the framer the shim already has, so no runtime dependency is added for a protocol that
 * is newline-delimited JSON-RPC and a handful of method names.
 */
describe('the MCP server', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startResponsesModel>>;
  let orca: Orca;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-mcp-'));
    model = await startResponsesModel();
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
    orca = new Orca({ cwd: workspace });
  });

  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const seed = () =>
    orca.record({
      adapter: 'generic-openai',
      command: [process.execPath, AGENT],
      upstream: { openai: model.url },
    });

  const call = (method: string, params?: unknown, id: number | string = 1) =>
    handleMcpMessage(orca, { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await call('tools/call', { name, arguments: args })) as {
      result?: { content: { type: string; text: string }[]; isError?: boolean };
    };
    const text = res.result?.content[0]?.text ?? '';
    return { isError: res.result?.isError === true, text, json: () => JSON.parse(text) };
  };

  describe('handshake', () => {
    it('answers initialize with a protocol version and a tools capability', async () => {
      const res = (await call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      })) as { result?: Record<string, unknown> };
      expect(res.result?.protocolVersion).toEqual(expect.any(String));
      expect(res.result?.capabilities).toMatchObject({ tools: expect.any(Object) });
      expect(res.result?.serverInfo).toMatchObject({ name: expect.any(String) });
    });

    it('says nothing back to a notification, which has no id to answer', async () => {
      const res = await handleMcpMessage(orca, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      expect(res).toBeUndefined();
    });

    it('answers an unknown method with an error rather than dying', async () => {
      const res = (await call('resources/list')) as { error?: { code: number; message: string } };
      expect(res.error?.code).toBe(-32601);
    });
  });

  describe('tools/list', () => {
    it('advertises the read tools and the two that do something', async () => {
      const res = (await call('tools/list')) as { result?: { tools: { name: string }[] } };
      const names = res.result?.tools.map((t) => t.name) ?? [];
      expect(names).toEqual(
        expect.arrayContaining([
          'orca_list_runs',
          'orca_show_run',
          'orca_checkpoints',
          'orca_replay',
          'orca_compare',
        ]),
      );
    });

    it('gives every tool a description and a typed input schema', async () => {
      // A tool an agent cannot tell when to call is a tool it calls at random.
      for (const t of MCP_TOOLS) {
        expect(t.description.length, t.name).toBeGreaterThan(30);
        expect(t.inputSchema.type, t.name).toBe('object');
        expect(t.inputSchema.properties, t.name).toBeDefined();
      }
    });
  });

  describe('tools/call', () => {
    it('lists runs', async () => {
      const recorded = await seed();
      const res = await tool('orca_list_runs');
      expect(res.isError).toBe(false);
      expect(res.json().map((r: { runId: string }) => r.runId)).toContain(recorded.runId);
    });

    it('returns a timeline an agent can reason over', async () => {
      const recorded = await seed();
      const res = await tool('orca_show_run', { run: recorded.runId });
      const doc = res.json();
      expect(doc.runId).toBe(recorded.runId);
      expect(doc.events.some((e: { kind: string }) => e.kind === 'TOOL')).toBe(true);
    });

    it('defaults to the newest run, the way `last` does on the command line', async () => {
      const recorded = await seed();
      expect((await tool('orca_show_run')).json().runId).toBe(recorded.runId);
    });

    it('replays and reports what diverged', async () => {
      const recorded = await seed();
      const before = model.calls.length;

      const res = await tool('orca_replay', { run: recorded.runId });

      expect(res.isError).toBe(false);
      expect(res.json()).toMatchObject({ matchedExact: 2, divergences: 0, unmatched: 0 });
      // Still offline. An agent calling this must not spend tokens without saying so.
      expect(model.calls.length).toBe(before);
    });

    it('returns the checkpoints a fork could start from', async () => {
      await seed();
      const res = await tool('orca_checkpoints');
      expect(res.json().length).toBeGreaterThan(0);
    });

    it('reports a failed call as an error result, not a transport error', async () => {
      // MCP says a tool that fails answers with isError, so the model can read the reason and
      // try something else. Throwing across the transport instead kills the session.
      const res = await tool('orca_show_run', { run: 'run_doesnotexist' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('run_doesnotexist');
    });

    it('rejects an unknown tool by name', async () => {
      const res = await tool('orca_delete_everything');
      expect(res.isError).toBe(true);
      expect(res.text).toContain('orca_delete_everything');
    });

    it('rejects arguments of the wrong shape rather than coercing them', async () => {
      const res = await tool('orca_replay', { run: 'last', from: 'not-a-number' });
      expect(res.isError).toBe(true);
    });
  });

  describe('over a stdio stream', () => {
    it('reads newline-delimited JSON-RPC and writes replies the same way', async () => {
      const recorded = await seed();
      const input = new PassThrough();
      const output = new PassThrough();
      const lines: string[] = [];
      output.on('data', (c: Buffer) => lines.push(c.toString('utf8')));

      const done = serveMcp({ orca, input, output });
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
      );
      input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      input.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'orca_list_runs', arguments: {} },
        })}\n`,
      );
      input.end();
      await done;

      const messages = lines
        .join('')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { id?: number });
      // Two requests, two replies — and nothing for the notification.
      expect(messages.map((m) => m.id)).toEqual([1, 2]);
      expect(JSON.stringify(messages[1])).toContain(recorded.runId);
    });

    it('survives a garbage line without dropping the session', async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const lines: string[] = [];
      output.on('data', (c: Buffer) => lines.push(c.toString('utf8')));

      const done = serveMcp({ orca, input, output });
      input.write('this is not json\n');
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`);
      input.end();
      await done;

      const ids = lines
        .join('')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => (JSON.parse(l) as { id?: number }).id);
      expect(ids).toContain(7);
    });
  });
});

/**
 * The command an agent's MCP config actually points at.
 *
 * A server nobody can start is a library, not an integration — the config line is the product.
 */
describe('orca mcp', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-mcp-cli-'));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('speaks MCP on stdio when launched as a subprocess', async () => {
    const cli = join(here, '..', 'dist', 'cli.js');
    const child = execFile(process.execPath, [cli, 'mcp'], { cwd: workspace });
    const seen: string[] = [];
    child.stdout?.on('data', (c: Buffer) => seen.push(c.toString('utf8')));

    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    );
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    child.stdin?.end();
    await new Promise((resolve) => child.on('exit', resolve));

    const messages = seen
      .join('')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { id: number; result?: { tools?: { name: string }[] } });
    expect(messages.map((m) => m.id)).toEqual([1, 2]);
    expect(messages[1]!.result?.tools?.map((t) => t.name)).toContain('orca_show_run');
  });
});
