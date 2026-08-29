import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { JsonRpcFrame } from '../src/index.js';
import { runShim } from '../src/index.js';

/** A fake MCP server: echoes a JSON-RPC response per request, then reports what it received. */
const ECHO_SERVER = `
let buf = '';
const seen = [];
process.stdin.on('data', (d) => {
  seen.push(Buffer.from(d));
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.method } }) + '\\n');
  }
});
process.stdin.on('end', () => {
  // No process.exit: writes to a pipe are async, and exiting drops whatever is still queued.
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'received', params: { b64: Buffer.concat(seen).toString('base64') } }) + '\\n');
});
`;

interface Collector {
  /** What has been emitted so far — for polling while the child is still running. */
  bytes: () => Buffer;
  /**
   * Everything, once the stream has drained. The child closing does not mean the destination has
   * emitted its buffered bytes yet, so a same-tick read of `bytes()` is a race.
   */
  drained: () => Promise<Buffer>;
}

function collect(stream: PassThrough): Collector {
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  return {
    bytes: () => Buffer.concat(chunks),
    drained: () =>
      new Promise<Buffer>((resolve) => {
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.end();
      }),
  };
}

function io() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return { stdin, stdout, stderr, out: collect(stdout), err: collect(stderr) };
}

describe('runShim', () => {
  it('forwards stdin to the child byte for byte', async () => {
    const { stdin, stdout, stderr, out } = io();
    const written = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"t":"\u{1F419} é"}}\n' +
        '{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
      'utf8',
    );
    const done = runShim({
      name: 'echo',
      command: process.execPath,
      args: ['-e', ECHO_SERVER],
      stdin,
      stdout,
      stderr,
    });
    // Split mid-multibyte so the tee cannot get away with re-encoding what it decoded.
    const cut = written.indexOf(Buffer.from('\u{1F419}', 'utf8')) + 2;
    expect(cut).toBeGreaterThan(2);
    stdin.write(written.subarray(0, cut));
    stdin.write(written.subarray(cut));
    stdin.end();
    expect(await done).toBe(0);

    const lines = (await out.drained())
      .toString('utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const received = lines.find((l) => l.method === 'received');
    expect(Buffer.from(received.params.b64, 'base64').equals(written)).toBe(true);
  });

  it('forwards child stdout to our stdout byte for byte', async () => {
    // The head carries the awkward bytes; the tail is one line far larger than any pipe buffer.
    // Only the head crosses argv — a 200 kB command line trips the OS argument limit.
    const head = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"result":{"text":"\u{1F419} café -ish"}}\n' + 'not json at all\n',
      'utf8',
    );
    const tail = Buffer.from(
      `{"jsonrpc":"2.0","id":2,"result":{"pad":"${'x'.repeat(200_000)}"}}\n`,
      'utf8',
    );
    const payload = Buffer.concat([head, tail]);
    const server = `
      const b = Buffer.concat([
        Buffer.from(${JSON.stringify(head.toString('base64'))}, 'base64'),
        Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"pad":"' + 'x'.repeat(200000) + '"}}\\n'),
      ]);
      let i = 0;
      const tick = () => {
        if (i >= b.length) return;
        const n = Math.min(7, b.length - i);
        process.stdout.write(b.subarray(i, i + n));
        i += n;
        setImmediate(tick);
      };
      tick();
    `;
    const { stdin, stdout, stderr, out } = io();
    const code = await runShim({
      name: 'echo',
      command: process.execPath,
      args: ['-e', server],
      stdin,
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect((await out.drained()).equals(payload)).toBe(true);
  });

  it('observes frames in both directions', async () => {
    const { stdin, stdout, stderr } = io();
    const seen: Array<[string, JsonRpcFrame]> = [];
    const done = runShim({
      name: 'echo',
      command: process.execPath,
      args: ['-e', ECHO_SERVER],
      onFrame: (dir, frame) => seen.push([dir, frame]),
      stdin,
      stdout,
      stderr,
    });
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    stdin.end();
    await done;

    const inbound = seen.filter(([d]) => d === 'in').map(([, f]) => f);
    const outbound = seen.filter(([d]) => d === 'out').map(([, f]) => f);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.method).toBe('tools/list');
    expect(inbound[0]?.kind).toBe('request');
    expect(outbound.some((f) => f.kind === 'response' && f.id === 1)).toBe(true);
  });

  it('forwards a non-zero child exit code', async () => {
    const { stdin, stdout, stderr } = io();
    const code = await runShim({
      name: 'boom',
      command: process.execPath,
      args: ['-e', 'process.exit(23)'],
      stdin,
      stdout,
      stderr,
    });
    expect(code).toBe(23);
  });

  it('passes the child stderr through untouched', async () => {
    const { stdin, stdout, stderr, err } = io();
    await runShim({
      name: 'noisy',
      command: process.execPath,
      args: ['-e', 'process.stderr.write("server warning \u{1F419}\\n")'],
      stdin,
      stdout,
      stderr,
    });
    expect((await err.drained()).toString('utf8')).toBe('server warning \u{1F419}\n');
  });

  it('survives a malformed frame from the server', async () => {
    const { stdin, stdout, stderr, out } = io();
    const kinds: string[] = [];
    const code = await runShim({
      name: 'bad',
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write("<<<not json>>>\\n{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"result\\":1}\\n")',
      ],
      onFrame: (_dir, f) => kinds.push(f.kind),
      stdin,
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(kinds).toEqual(['unknown', 'response']);
    expect((await out.drained()).toString('utf8')).toBe(
      '<<<not json>>>\n{"jsonrpc":"2.0","id":1,"result":1}\n',
    );
  });

  it('keeps the stream flowing when the capture callback throws', async () => {
    const { stdin, stdout, stderr, out } = io();
    const code = await runShim({
      name: 'echo',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("{\\"id\\":1,\\"result\\":1}\\n")'],
      onFrame: () => {
        throw new Error('capture side blew up');
      },
      stdin,
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect((await out.drained()).toString('utf8')).toBe('{"id":1,"result":1}\n');
  });

  it('names the command when it cannot be spawned', async () => {
    const { stdin, stdout, stderr } = io();
    await expect(
      runShim({
        name: 'missing',
        command: 'orca-no-such-mcp-server',
        args: [],
        stdin,
        stdout,
        stderr,
      }),
    ).rejects.toThrow(/orca-no-such-mcp-server/);
  });

  it('reports a launch that fails synchronously, naming the server', async () => {
    const { stdin, stdout, stderr } = io();
    // An argv over the OS limit makes spawn throw rather than emit 'error'.
    await expect(
      runShim({
        name: 'oversized',
        command: process.execPath,
        args: ['-e', 'x'.repeat(4_000_000)],
        stdin,
        stdout,
        stderr,
      }),
    ).rejects.toThrow(/oversized/);
  });

  it('forwards SIGTERM to the child and unregisters its handlers afterwards', async () => {
    const before = process.listenerCount('SIGTERM');
    const { stdin, stdout, stderr, out } = io();
    const done = runShim({
      name: 'trapper',
      command: process.execPath,
      args: [
        '-e',
        'const t = setInterval(() => {}, 1000);' +
          'process.on("SIGTERM", () => { process.stdout.write("terminated\\n"); process.exitCode = 7; clearInterval(t); });' +
          'process.stdout.write("ready\\n");',
      ],
      stdin,
      stdout,
      stderr,
    });
    await new Promise<void>((resolve) => {
      const wait = (): void => {
        if (out.bytes().toString('utf8').includes('ready')) resolve();
        else setTimeout(wait, 10);
      };
      wait();
    });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    process.emit('SIGTERM');
    expect(await done).toBe(7);
    expect((await out.drained()).toString('utf8')).toContain('terminated');
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
