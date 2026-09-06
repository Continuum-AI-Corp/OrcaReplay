import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { Output, type LogEntry } from '../src/out.js';
import { pullCommand, pushCommand } from '../src/commands/sync.js';
import { readArchive, writeArchive } from '../src/archive.js';
import { writeConfig } from '../src/config.js';

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
  /**
   * THE STORED KEY BELONGS TO THE STORED GATEWAY, AND TO NOTHING ELSE.
   *
   * `--gateway` swaps the destination but the config still holds `api_key`, so the obvious
   * implementation — merge the override URL into the configured gateway and ask for its headers —
   * hands the credential for the user's real gateway to whatever host was named on the command
   * line. `upstream.ts` already learned this for model traffic (see its unanimity note); push is
   * the same disclosure with a run attached.
   *
   * Refusing is the correct outcome, not a limitation: an unauthenticated push fails with a 401 the
   * user can read, while a leaked key fails silently and permanently.
   */
  it('does not send the configured key to a gateway named on the command line', async () => {
    await seedRun();
    // The configured gateway is somewhere else entirely, and holds a key.
    await writeConfig(
      { gateway: { url: 'https://gateway.example.internal', api_key: 'sk-stored-elsewhere' } },
      { XDG_CONFIG_HOME: home },
    );

    await expect(
      pushCommand(parseArgs(['push', runId, '--gateway', url]), out, workspace, {
        XDG_CONFIG_HOME: home,
      }),
    ).rejects.toThrow(/key/i);
    // Not "sent without the header" — not sent at all.
    expect(received).toHaveLength(0);
    for (const entry of logs) {
      expect(JSON.stringify(entry)).not.toContain('sk-stored-elsewhere');
    }
  });

  /**
   * The other half, so the rule above cannot be satisfied by refusing everything: pointing
   * `--gateway` at the gateway you already configured is not an override, and the stored key
   * applies.
   */
  it('still uses the stored key when the named gateway is the configured one', async () => {
    await seedRun();
    await writeConfig({ gateway: { url, api_key: 'sk-stored-here' } }, { XDG_CONFIG_HOME: home });

    await pushCommand(parseArgs(['push', runId, '--gateway', `${url}/`]), out, workspace, {
      XDG_CONFIG_HOME: home,
    });
    expect(received[0]!.auth).toBe('Bearer sk-stored-here');
  });

  /**
   * A FAILED REPLACE MUST NOT COST THE LOCAL COPY.
   *
   * `pull --force` deleted the existing run and then wrote the new one file by file, so anything
   * that failed in between — a full disk, a corrupt archive, ^C — left the run neither the old one
   * nor the new one. The recording is the artifact; it may be the only copy of a crash someone
   * spent a day reproducing.
   *
   * The failure injected here is an archive naming both `x` and `x/y`, which is what a corrupt or
   * hostile archive looks like from the write path: the second entry's mkdir hits ENOTDIR partway
   * through, after the first files have already landed.
   */
  it('keeps the existing run when a --force replace fails partway', async () => {
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
          { name: `${runId}/x`, bytes: new Uint8Array([1]) },
          { name: `${runId}/x/y`, bytes: new Uint8Array([2]) },
        ]),
      ),
    };

    await expect(
      pullCommand(parseArgs(['pull', runId, '--force']), out, workspace, env()),
    ).rejects.toThrow();

    // The run is exactly as it was.
    const dir = join(workspace, '.orca', 'runs', runId);
    expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).toBe(
      '{"seq":1,"type":"run.start"}\n',
    );
    expect(Array.from(await readFile(join(dir, 'blobs', 'ab', 'abcdef')))).toEqual([1, 2, 3]);
    // And no staging directory is left behind for `orca list` or the next pull to trip over.
    const siblings = await readdir(join(workspace, '.orca', 'runs'));
    expect(siblings).toEqual([runId]);
  });
  /**
   * A CRASH IS NOT AN EXCEPTION, and the first version of this fix only handled the latter.
   *
   * The swap is two renames with a gap in which `dest` does not exist. try/catch covers a thrown
   * error; SIGKILL, ^C and power loss all land in that gap. Because neither scratch name matches
   * RUN_ID_PATTERN, every command skips them — so the run does not merely fail to update, it
   * disappears from `list`, `show`, `gc` and `scrub`, with a possibly secret-bearing copy stranded
   * where scrub cannot reach it.
   *
   * These three tests stage the on-disk state a killed process leaves behind — which is the only
   * honest way to test it, since the failure is the absence of any further code running — and
   * assert the next pull reclaims it.
   */
  async function halfDoneSwap(
    which: 'incoming' | 'replaced' | 'both',
    newSeq: string,
  ): Promise<string> {
    const dir = join(workspace, '.orca', 'runs', runId);
    await seedRun();
    if (which === 'replaced' || which === 'both') {
      await mkdir(`${dir}.replaced`, { recursive: true });
      await writeFile(join(`${dir}.replaced`, 'events.jsonl'), '{"seq":1,"type":"run.start"}\n');
    }
    if (which === 'incoming' || which === 'both') {
      await mkdir(`${dir}.incoming`, { recursive: true });
      await writeFile(join(`${dir}.incoming`, 'events.jsonl'), newSeq);
    }
    // The process died mid-swap: the destination is gone.
    await rm(dir, { recursive: true, force: true });
    return dir;
  }

  it('finishes a swap that was killed after the new copy was written', async () => {
    const dir = await halfDoneSwap('both', '{"seq":42}\n');
    reply = {
      status: 200,
      body: Buffer.from(
        await writeArchive([
          {
            name: `${runId}/manifest.json`,
            bytes: new TextEncoder().encode(`{"run_id":"${runId}"}\n`),
          },
          { name: `${runId}/events.jsonl`, bytes: new TextEncoder().encode('{"seq":99}\n') },
        ]),
      ),
    };

    // No --force: the recovered run must be visible to the existence check, so this refuses
    // rather than silently replacing a run the user still has.
    await expect(pullCommand(parseArgs(['pull', runId]), out, workspace, env())).rejects.toThrow(
      /already|exists/i,
    );
    expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).toBe('{"seq":42}\n');
    expect(await readdir(join(workspace, '.orca', 'runs'))).toEqual([runId]);
  });

  it('rolls back a swap that was killed before the new copy landed', async () => {
    const dir = await halfDoneSwap('replaced', '');
    reply = { status: 200, body: Buffer.from(await writeArchive([])) };

    await expect(pullCommand(parseArgs(['pull', runId]), out, workspace, env())).rejects.toThrow();
    // The ORIGINAL is back, not lost.
    expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).toBe(
      '{"seq":1,"type":"run.start"}\n',
    );
    expect(await readdir(join(workspace, '.orca', 'runs'))).toEqual([runId]);
  });

  it('sweeps leftovers when the swap did complete', async () => {
    await seedRun();
    const dir = join(workspace, '.orca', 'runs', runId);
    await mkdir(`${dir}.replaced`, { recursive: true });
    await writeFile(join(`${dir}.replaced`, 'events.jsonl'), 'stale\n');

    reply = {
      status: 200,
      body: Buffer.from(
        await writeArchive([
          {
            name: `${runId}/manifest.json`,
            bytes: new TextEncoder().encode(`{"run_id":"${runId}"}\n`),
          },
          { name: `${runId}/events.jsonl`, bytes: new TextEncoder().encode('{"seq":7}\n') },
        ]),
      ),
    };
    await pullCommand(parseArgs(['pull', runId, '--force']), out, workspace, env());

    expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).toBe('{"seq":7}\n');
    // The stranded copy is gone rather than sitting out of scrub's reach forever.
    expect(await readdir(join(workspace, '.orca', 'runs'))).toEqual([runId]);
  });
});
