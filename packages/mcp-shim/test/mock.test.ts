import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  indexFrames,
  keyOf,
  runMock,
  type JsonRpcMessage,
  type RecordedFrame,
} from '../src/mock.js';

/**
 * Serving an MCP client from a recording.
 *
 * Capture was only half of what this layer is for. The reason to record a server's traffic is that
 * the run stays reproducible once the server is not — the token revoked, the repository moved, the
 * service retired. Replay used to re-instrument the same config and start the real server again,
 * so an MCP recording could be read but not reproduced, and came apart on the first call when the
 * server had gone.
 */

/** Ids are explicit: a counter shared across tests silently pairs a request with another's reply. */
function req(id: number, method: string, params?: unknown): RecordedFrame {
  return {
    server: 's',
    direction: 'in',
    at: '2026-01-01T00:00:00.000Z',
    id,
    method,
    message: { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) },
  };
}
function res(id: number, result: unknown): RecordedFrame {
  return {
    server: 's',
    direction: 'out',
    at: '2026-01-01T00:00:00.000Z',
    id,
    message: { jsonrpc: '2.0', id, result },
  };
}

/** Drive the mock with a list of client messages and collect what it wrote back. */
async function ask(frames: RecordedFrame[], sent: JsonRpcMessage[]): Promise<JsonRpcMessage[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out: JsonRpcMessage[] = [];
  stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() !== '') out.push(JSON.parse(line) as JsonRpcMessage);
    }
  });
  const done = runMock({ name: 's', frames, stdin, stdout });
  for (const message of sent) stdin.write(`${JSON.stringify(message)}\n`);
  stdin.end();
  await done;
  return out;
}

describe('keyOf', () => {
  /**
   * `_meta` is the protocol's own side channel and every client fills it with values that are new
   * each run — Claude Code puts the tool-use id and a progress token there. Comparing it made an
   * exact match impossible for `tools/call`, which is the one call anybody replays.
   */
  it('ignores the per-run identifiers MCP carries beside the arguments', () => {
    const bare = keyOf({ method: 'tools/call', params: { name: 'x', arguments: {} } });
    const withMeta = keyOf({
      method: 'tools/call',
      params: { name: 'x', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_abc' } },
    });
    expect(withMeta).toBe(bare);
  });

  it('separates calls that differ in their real arguments', () => {
    expect(keyOf({ method: 'tools/call', params: { name: 'a' } })).not.toBe(
      keyOf({ method: 'tools/call', params: { name: 'b' } }),
    );
  });
});

describe('indexFrames', () => {
  it('ties each response to the question its id answered', () => {
    const { byKey, byMethod } = indexFrames([
      req(1, 'tools/list'),
      res(1, { tools: [] }),
      req(2, 'tools/call', { name: 'x' }),
      res(2, { content: 'first' }),
    ]);
    expect(byKey.get(keyOf({ method: 'tools/call', params: { name: 'x' } }))).toEqual([
      { jsonrpc: '2.0', id: 2, result: { content: 'first' } },
    ]);
    expect(byMethod.get('tools/list')).toHaveLength(1);
  });
});

describe('runMock', () => {
  it('answers a repeated call in the order the recording answered it', async () => {
    const frames = [
      req(1, 'tools/call', { name: 'next' }),
      res(1, { content: 'first' }),
      req(2, 'tools/call', { name: 'next' }),
      res(2, { content: 'second' }),
    ];
    const out = await ask(frames, [
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'next' } },
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'next' } },
    ]);
    expect(out.map((m) => m.result)).toEqual([{ content: 'first' }, { content: 'second' }]);
    // The recorded id belonged to the recorded session; the client is waiting on its own.
    expect(out.map((m) => m.id)).toEqual([10, 11]);
  });

  /**
   * The call anybody actually replays. Claude Code puts a fresh `claudecode/toolUseId` in `_meta`
   * on every run, so comparing it made an exact match impossible for `tools/call` — the recording
   * was there and the answer never came out of it.
   */
  it('answers a tools/call whose _meta is new this run', async () => {
    const frames = [
      req(1, 'tools/call', {
        name: 'magic',
        arguments: {},
        _meta: { 'claudecode/toolUseId': 'toolu_recorded' },
      }),
      res(1, { content: [{ type: 'text', text: 'MAGIC-7788' }] }),
    ];
    const out = await ask(frames, [
      {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: 'magic',
          arguments: {},
          _meta: { 'claudecode/toolUseId': 'toolu_totally_different', progressToken: 9 },
        },
      },
    ]);
    expect(out[0]?.result).toEqual({ content: [{ type: 'text', text: 'MAGIC-7788' }] });
  });

  /**
   * `initialize` carries the client's own version and capabilities, so it can never match
   * byte-for-byte across runs — and nothing else in a session happens until it is answered.
   */
  it('answers by method when the arguments could not repeat', async () => {
    const frames = [
      req(1, 'initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'recorded' } }),
      res(1, { serverInfo: { name: 'srv' } }),
    ];
    const out = await ask(frames, [
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', clientInfo: { name: 'different' } },
      },
    ]);
    expect(out).toEqual([{ jsonrpc: '2.0', id: 7, result: { serverInfo: { name: 'srv' } } }]);
  });

  // Answering one would desynchronise a client that is not waiting for a reply.
  it('says nothing to a notification', async () => {
    const out = await ask(
      [req(1, 'tools/list'), res(1, { tools: [] })],
      [{ jsonrpc: '2.0', method: 'notifications/initialized' }],
    );
    expect(out).toEqual([]);
  });

  // Silence is a hang, and a hang is the failure a client cannot recover from or report.
  it('answers a method the recording never saw with an error rather than nothing', async () => {
    const misses: string[] = [];
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const seen: JsonRpcMessage[] = [];
    stdout.on('data', (c: Buffer) => seen.push(JSON.parse(c.toString('utf8')) as JsonRpcMessage));
    const done = runMock({
      name: 's',
      frames: [],
      stdin,
      stdout,
      onMiss: (method) => misses.push(method),
    });
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read' })}\n`);
    stdin.end();
    await done;
    expect(misses).toEqual(['resources/read']);
    expect((seen[0]?.error as { code: number }).code).toBe(-32601);
  });

  it('repeats the last answer rather than failing when a client asks once more', async () => {
    const frames = [req(1, 'tools/call', { name: 'x' }), res(1, { content: 'only' })];
    const out = await ask(frames, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } },
    ]);
    expect(out.map((m) => m.result)).toEqual([{ content: 'only' }, { content: 'only' }]);
  });
});
