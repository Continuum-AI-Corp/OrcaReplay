import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { Output, type LogEntry } from '../src/out.js';
import { pullCommand, pushCommand } from '../src/commands/sync.js';
import { readArchive, writeArchive } from '../src/archive.js';

/**
 * `orca push` and `orca pull`, against a gateway stood up in-process.
 *
 * A real HTTP server rather than a stubbed fetch: what these commands get wrong is the wire — the
 * multipart body, which header carries the key, what a 4xx body means — and a stub asserts only
 * that the code calls the function the test already believes it calls.
 */
describe('push and pull', () => {
  let workspace: string;
  let home: string;
  let server: Server;
  let url: string;
  let out: Output;
  let logs: LogEntry[];
  let received: {
    method: string;
    path: string;
    auth?: string;
    apiKey?: string;
    body: Buffer;
    contentType?: string;
  }[];
  let reply: { status: number; body: string | Buffer; headers?: Record<string, string> };

  const runId = 'run_abc123';

  async function seedRun(): Promise<void> {
    const dir = join(workspace, '.orca', 'runs', runId);
    await mkdir(join(dir, 'blobs', 'ab'), { recursive: true });
    await writeFile(
      join(dir, 'manifest.json'),
      `${JSON.stringify({ run_id: runId, schema_version: '0.1.0' }, null, 2)}\n`,
    );
    await writeFile(join(dir, 'events.jsonl'), '{"seq":1,"type":"run.start"}\n');
    await writeFile(join(dir, 'blobs', 'ab', 'abcdef'), Buffer.from([1, 2, 3]));
  }

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-sync-'));
    home = await mkdtemp(join(tmpdir(), 'orca-sync-home-'));
    logs = [];
    out = new Output({ write: () => {}, sink: (e) => void logs.push(e), isTTY: false });
    received = [];
    reply = { status: 200, body: JSON.stringify({ success: true, data: { run_key: runId } }) };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => void chunks.push(c));
      req.on('end', () => {
        received.push({
          method: req.method ?? '',
          path: req.url ?? '',
          auth: req.headers.authorization,
          apiKey: req.headers['x-api-key'] as string | undefined,
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks),
        });
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        res.end(reply.body);
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    XDG_CONFIG_HOME: home,
    ORCA_GATEWAY_URL: url,
    ORCA_GATEWAY_KEY: 'sk-replay-test',
    ...extra,
  });

  it('pushes the run as a zip the gateway can read back', async () => {
    await seedRun();
    await pushCommand(parseArgs(['push', runId]), out, workspace, env());

    expect(received).toHaveLength(1);
    const req = received[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/api/replay/runs');
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);

    // The archive survives the multipart framing intact, which is what the gateway's integrity
    // check verifies on arrival.
    const start = req.body.indexOf('PK');
    const end = req.body.lastIndexOf('\r\n--');
    const entries = await readArchive(new Uint8Array(req.body.subarray(start, end)));
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual([
      `${runId}/blobs/ab/abcdef`,
      `${runId}/events.jsonl`,
      `${runId}/manifest.json`,
    ]);
    const events = entries.find((e) => e.name === `${runId}/events.jsonl`)!;
    expect(new TextDecoder().decode(events.bytes)).toBe('{"seq":1,"type":"run.start"}\n');
  });

  /**
   * The credential goes in headers and NOWHERE else — not the URL, not a form field, and above all
   * not the terminal. push is the first command that sends one to a host the user named, so this is
   * the test that keeps CONTRIBUTING's "secrets never reach a TTY" true for a new sink.
   */
  it('sends the key as a header and never prints it', async () => {
    await seedRun();
    await pushCommand(parseArgs(['push', runId]), out, workspace, env());

    const req = received[0]!;
    expect(req.auth).toBe('Bearer sk-replay-test');
    expect(req.apiKey).toBe('sk-replay-test');
    expect(req.path).not.toContain('sk-replay-test');
    expect(req.body.toString('utf8')).not.toContain('sk-replay-test');
    for (const entry of logs) {
      expect(JSON.stringify(entry)).not.toContain('sk-replay-test');
    }
  });

  it('refuses to push without a key rather than pushing anonymously', async () => {
    await seedRun();
    await expect(
      pushCommand(parseArgs(['push', runId]), out, workspace, {
        XDG_CONFIG_HOME: home,
        ORCA_GATEWAY_URL: url,
      }),
    ).rejects.toThrow(/key/i);
    expect(received).toHaveLength(0);
  });

  it('explains a rejected push instead of reporting success', async () => {
    await seedRun();
    reply = {
      status: 422,
      body: JSON.stringify({ success: false, message: 'archive contains 2 plaintext secrets' }),
    };
    await expect(pushCommand(parseArgs(['push', runId]), out, workspace, env())).rejects.toThrow(
      /plaintext secrets/,
    );
  });

  it('forwards --force so a scanned finding can be overridden deliberately', async () => {
    await seedRun();
    await pushCommand(parseArgs(['push', runId, '--force']), out, workspace, env());
    expect(received[0]!.path).toBe('/api/replay/runs?force=1');
  });

  it('pulls a run into the local store', async () => {
    const zip = await writeArchive([
      {
        name: `${runId}/manifest.json`,
        bytes: new TextEncoder().encode(`{"run_id":"${runId}"}\n`),
      },
      { name: `${runId}/events.jsonl`, bytes: new TextEncoder().encode('{"seq":1}\n') },
      { name: `${runId}/blobs/ab/abcdef`, bytes: new Uint8Array([9, 8, 7]) },
    ]);
    reply = { status: 200, body: Buffer.from(zip), headers: { 'content-type': 'application/zip' } };

    await pullCommand(parseArgs(['pull', runId]), out, workspace, env());

    expect(received[0]!.method).toBe('GET');
    expect(received[0]!.path).toBe(`/api/replay/runs/${runId}/export`);
    const dir = join(workspace, '.orca', 'runs', runId);
    expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe(`{"run_id":"${runId}"}\n`);
    expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).toBe('{"seq":1}\n');
    expect(Array.from(await readFile(join(dir, 'blobs', 'ab', 'abcdef')))).toEqual([9, 8, 7]);
  });

  /**
   * A truncated recording is one the gateway could not store whole. Pulling it is allowed — half a
   * trace still debugs — but saying so is not optional: every later command reads the result as if
   * it were the whole run.
   */
  it('warns when the gateway says the recording is incomplete', async () => {
    const zip = await writeArchive([
      {
        name: `${runId}/manifest.json`,
        bytes: new TextEncoder().encode(`{"run_id":"${runId}"}\n`),
      },
      { name: `${runId}/events.jsonl`, bytes: new TextEncoder().encode('{"seq":1}\n') },
    ]);
    reply = {
      status: 200,
      body: Buffer.from(zip),
      headers: { 'content-type': 'application/zip', 'x-orca-run-truncated': 'true' },
    };
    await pullCommand(parseArgs(['pull', runId]), out, workspace, env());
    expect(logs.some((e) => e.level === 'warn' && e.event.includes('truncated'))).toBe(true);
  });

  it('refuses to overwrite an existing run without --force', async () => {
    await seedRun();
    reply = {
      status: 200,
      body: Buffer.from(
        await writeArchive([
          {
            name: `${runId}/manifest.json`,
            bytes: new TextEncoder().encode(`{"run_id":"${runId}"}\n`),
          },
          { name: `${runId}/events.jsonl`, bytes: new TextEncoder().encode('{"seq":9}\n') },
        ]),
      ),
    };
    await expect(pullCommand(parseArgs(['pull', runId]), out, workspace, env())).rejects.toThrow(
      /already|exists/i,
    );
    // The local copy is untouched.
    expect(await readFile(join(workspace, '.orca', 'runs', runId, 'events.jsonl'), 'utf8')).toBe(
      '{"seq":1,"type":"run.start"}\n',
    );
  });
});
