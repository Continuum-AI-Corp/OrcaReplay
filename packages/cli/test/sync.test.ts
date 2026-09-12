import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { Output, type LogEntry } from '../src/out.js';
import {
  breakStaleRunLock,
  pullCommand,
  pushCommand,
  LOCK_HEARTBEAT_MS,
  releaseRunLock,
  revertStagedSwap,
  withRunLockForTest,
} from '../src/commands/sync.js';
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
  /**
   * A PULLED RUN IS AS SENSITIVE AS A RECORDED ONE, AND THE STORE SAYS SO IN TWO WAYS.
   *
   * `ensureRunsDir` is what record, attach and replay all go through, and it does two things this
   * command was silently skipping: it creates `.orca/runs` mode 0700, and it writes `.orca/.gitignore`
   * containing `*` — git's own idiom for a directory that excludes itself. Pull wrote into the store
   * with a bare recursive mkdir instead, so under a default umask the run landed 0755/0644 and the
   * whole store appeared in `git status`, one `git add -A` from being committed.
   *
   * Both consequences bite hardest in the case pull exists for: a fresh clone with no recording yet,
   * where pull is the command that CREATES the store. So the fixture below starts from an empty
   * workspace rather than seeding a run first.
   */
  it('creates the store with the modes and the .gitignore the rest of the CLI uses', async () => {
    reply = {
      status: 200,
      body: Buffer.from(
        await writeArchive([
          {
            name: `${runId}/manifest.json`,
            bytes: new TextEncoder().encode(`{"run_id":"${runId}"}\n`),
          },
          { name: `${runId}/events.jsonl`, bytes: new TextEncoder().encode('{"seq":1}\n') },
          { name: `${runId}/blobs/ab/abcdef`, bytes: new Uint8Array([9, 8, 7]) },
        ]),
      ),
    };

    await pullCommand(parseArgs(['pull', runId]), out, workspace, env());

    // The store excludes itself from git — the accident ensureRunsDir exists to prevent.
    expect(await readFile(join(workspace, '.orca', '.gitignore'), 'utf8')).toContain('*');

    // SECURITY.md: "Trace files and blobs are written mode 0600, run directories 0700."
    const mode = async (...p: string[]): Promise<number> =>
      (await stat(join(workspace, '.orca', 'runs', ...p))).mode & 0o777;
    expect(await mode(runId)).toBe(0o700);
    expect(await mode(runId, 'blobs')).toBe(0o700);
    expect(await mode(runId, 'manifest.json')).toBe(0o600);
    expect(await mode(runId, 'events.jsonl')).toBe(0o600);
    expect(await mode(runId, 'blobs', 'ab', 'abcdef')).toBe(0o600);
  });
  /**
   * `.replaced` IS THE EVIDENCE THAT `.incoming` IS COMPLETE — and the first version of the
   * recovery did not know that.
   *
   * A REPLACE writes staging to completion before it moves `dest` aside, so a crash between the two
   * renames always leaves BOTH siblings. A FIRST pull writes entries straight into `.incoming` and
   * renames once at the end, so a crash there leaves a PARTIAL `.incoming` and no `.replaced` at
   * all. Promoting that installed a truncated recording as the run — `show`, `scrub` and `push`
   * would treat it as whole — and the next pull, the one that would have fetched the good copy, was
   * refused with "already exists locally".
   */
  it('discards a partial .incoming from an interrupted FIRST pull instead of promoting it', async () => {
    const runs = join(workspace, '.orca', 'runs');
    const dir = join(runs, runId);
    // What a first pull killed mid-write leaves: some entries, no manifest, no .replaced.
    await mkdir(join(`${dir}.incoming`, 'blobs', 'ab'), { recursive: true });
    await writeFile(join(`${dir}.incoming`, 'blobs', 'ab', 'abcdef'), Buffer.from([1]));

    reply = {
      status: 200,
      body: Buffer.from(
        await writeArchive([
          {
            name: `${runId}/manifest.json`,
            bytes: new TextEncoder().encode(`{"run_id":"${runId}"}\n`),
          },
          { name: `${runId}/events.jsonl`, bytes: new TextEncoder().encode('{"seq":1}\n') },
        ]),
      ),
    };

    // No --force: the partial must NOT read as an existing run, or the good copy can never land.
    await pullCommand(parseArgs(['pull', runId]), out, workspace, env());

    expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe(`{"run_id":"${runId}"}\n`);
    expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).toBe('{"seq":1}\n');
    // The partial's stray blob did not survive into the run.
    await expect(readFile(join(dir, 'blobs', 'ab', 'abcdef'))).rejects.toThrow();
    expect(await readdir(runs)).toEqual([runId]);
  });

  /**
   * Two pulls of one run must not be able to destroy both copies.
   *
   * The deterministic scratch names that make a half-done swap recoverable also make it shared, and
   * a recovery's "dest present, so these siblings are litter" cleanup interleaved with another
   * pull's two renames could delete the staged new copy AND the retired old one — the disappearance
   * I had claimed the design ruled out. A lock is the fix; this pins that the lock is actually
   * taken, by holding it and watching a pull refuse rather than proceed into the critical section.
   */
  it('refuses to work on a run another pull is holding', async () => {
    await seedRun();
    const lock = join(workspace, '.orca', 'runs', `${runId}.lock`);
    await mkdir(join(workspace, '.orca', 'runs'), { recursive: true });
    await writeFile(lock, '99999\n');

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

    await expect(
      pullCommand(parseArgs(['pull', runId, '--force']), out, workspace, env()),
    ).rejects.toThrow(/another orca pull|held/i);

    // And the local copy is exactly as it was — the point of refusing.
    expect(await readFile(join(workspace, '.orca', 'runs', runId, 'events.jsonl'), 'utf8')).toBe(
      '{"seq":1,"type":"run.start"}\n',
    );
  }, 20000);
  /*
   * PUSH MUST NOT SHIP THE RUN'S INTERCEPTION CA.
   *
   * Every other thing that takes a run off disk enumerates the NAMED artifacts — `orca export`,
   * `gc`, `scrub` all read `manifest.json`, `events.jsonl` and the blobs events reference, and none
   * of them can pick up what else a run directory happens to hold. `runEntries` sweeps the whole
   * directory instead, so whatever is in there leaves the machine.
   *
   * `RunCa.create` mints the run's interception CA into `<run>/tls/` — `ca.key` at 0600 — and only
   * `dispose()` removes it. SECURITY.md states the CA is "deleted when the run ends, including when
   * the run fails, is interrupted", and record.ts does NOT guarantee that: it warns
   * `tls.ca_not_removed` and seals the trace normally, so the run looks finished with the private
   * key still inside it. SIGKILL leaves it too, with no handler at all.
   *
   * Pushing such a run POSTs the key to a gateway, which stores it and serves it to everyone who
   * pulls the run. The gateway's secret scan is the only thing left in the way — and `--force`
   * exists to bypass exactly that.
   */
  it('never packs the run’s TLS CA, whatever the sweep finds', async () => {
    await seedRun();
    const dir = join(workspace, '.orca', 'runs', runId);
    await mkdir(join(dir, 'tls'), { recursive: true });
    await writeFile(
      join(dir, 'tls', 'ca.key'),
      '-----BEGIN PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END PRIVATE KEY-----\n',
    );
    await writeFile(join(dir, 'tls', 'ca.crt'), '-----BEGIN CERTIFICATE-----\nMIIB\n');
    await writeFile(join(dir, 'tls', 'ca-bundle.crt'), '-----BEGIN CERTIFICATE-----\nMIIB\n');

    await pushCommand(parseArgs(['push', runId, '--gateway', url]), out, workspace, env());

    const sent = received.find((r) => r.method === 'POST');
    expect(sent, 'the push must have happened').toBeTruthy();
    const body = sent!.body.toString('latin1');
    // THE ENTRY NAME IS THE LOAD-BEARING ASSERTION. Zip names are stored uncompressed while the
    // payload is deflated, so scanning the archive for "PRIVATE KEY" can pass over a key that is
    // very much in there — it did, on the unfixed code, while the name assertion below caught it.
    // Both are kept: the name proves the file was excluded, the payload scan is the backstop for
    // anything that arrives by another route.
    expect(body).not.toContain(`${runId}/tls/`);
    expect(body).not.toContain('PRIVATE KEY');

    // And the archive really is the trace — this must not pass by having pushed nothing.
    expect(body).toContain(`${runId}/events.jsonl`);
    expect(body).toContain(`${runId}/manifest.json`);
  });

  /**
   * A PULL RELEASES ONLY THE LOCK IT IS HOLDING.
   *
   * The stale-break is what makes an unconditional release unsafe — not an oversight beside it, but
   * its direct consequence. A pull that overruns STALE_LOCK_MS has its lock broken by a second
   * pull, which acquires a FRESH lock; the first pull's `finally` then removed the PATH rather than
   * its own lock, deleting the second's. A third pull walks in beside the second, and the two of
   * them are exactly the concurrent recovery-and-swap this lock exists to prevent — the case where
   * both copies of the run can go.
   *
   * Driven against the release helper rather than through `pullCommand`: the release runs inside a
   * `finally`, and nothing a caller can reach interposes on that window. The pull's own happy path
   * is covered below — its lock does come off.
   */
  it('leaves a lock it no longer owns alone', async () => {
    const runs = join(workspace, '.orca', 'runs');
    await mkdir(runs, { recursive: true });
    const lock = join(runs, `${runId}.lock`);
    const mine = `${process.pid} mine\n`;
    const theirs = '424242 another-holder\n';

    // Someone else's lock sits at the path we were holding — what a stale-break leaves behind.
    await writeFile(lock, theirs);
    await releaseRunLock(lock, mine);
    expect(
      await readFile(lock, 'utf8'),
      'releasing deleted a lock another process holds, so a third pull can now run beside it',
    ).toBe(theirs);

    // Our own lock does come off, or the first pull would make the run permanently unpullable.
    await writeFile(lock, mine);
    await releaseRunLock(lock, mine);
    await expect(readFile(lock, 'utf8')).rejects.toThrow();

    // A lock already gone is not an error — the stale-break may have taken it.
    await releaseRunLock(lock, mine);
  });

  /**
   * …and the ordinary path still leaves nothing behind. A lock that is never released is a run
   * nobody can pull until it goes stale, which is the failure the ownership rule must not cause.
   */
  it('removes its own lock when the pull finishes', async () => {
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

    await pullCommand(parseArgs(['pull', runId, '--force']), out, workspace, env());
    await expect(
      readFile(join(workspace, '.orca', 'runs', `${runId}.lock`), 'utf8'),
    ).rejects.toThrow();
  });

  /**
   * AND THE SAME RULE FOR THE ENVIRONMENT KEY, which the first version of this gate exempted.
   *
   * I argued that an env key alongside `--gateway` was a deliberate pairing made in one
   * invocation. The README in this same PR says `read -rs ORCA_GATEWAY_KEY && export
   * ORCA_GATEWAY_KEY` — and an export persists for the shell session, so the pairing was an
   * assumption nothing enforced. A user who exported the key for their real gateway and later runs
   * `orca push --gateway <other-host>` was sending that key and the whole recording to the other
   * host, while the identical request with the key in config was refused. An asymmetry that turns
   * on where a credential is STORED rather than where it is GOING is not a boundary.
   */
  it('does not send an exported key to a gateway named on the command line', async () => {
    await seedRun();
    await expect(
      pushCommand(parseArgs(['push', runId, '--gateway', 'http://127.0.0.1:9']), out, workspace, {
        XDG_CONFIG_HOME: home,
        // Exported for the real gateway, some time ago.
        ORCA_GATEWAY_URL: url,
        ORCA_GATEWAY_KEY: 'sk-orca-exported-for-the-real-one',
      }),
    ).rejects.toThrow(/key/i);
    expect(received).toHaveLength(0);
    for (const entry of logs) {
      expect(JSON.stringify(entry)).not.toContain('sk-orca-exported-for-the-real-one');
    }
  });

  /**
   * The case the env key exists for, which the rule above must not break: a CI job that names the
   * destination on the command line and passes the key beside it. Nothing else names a URL, so
   * there is no earlier association for the flag to contradict.
   */
  it('still sends a key whose only destination is the one this invocation names', async () => {
    await seedRun();
    await pushCommand(parseArgs(['push', runId, '--gateway', url]), out, workspace, {
      XDG_CONFIG_HOME: home,
      ORCA_GATEWAY_KEY: 'sk-orca-ci',
    });
    expect(received[0]!.auth).toBe('Bearer sk-orca-ci');
  });

  /**
   * And an exported pair with no flag is the ordinary case — the destination IS the key's home.
   */
  it('sends an exported key to the gateway it was exported for', async () => {
    await seedRun();
    await pushCommand(parseArgs(['push', runId]), out, workspace, {
      XDG_CONFIG_HOME: home,
      ORCA_GATEWAY_URL: url,
      ORCA_GATEWAY_KEY: 'sk-orca-home',
    });
    expect(received[0]!.auth).toBe('Bearer sk-orca-home');
  });

  /**
   * PUSH SHIPS THE TRACE, NOT THE CAPTURE SCAFFOLDING.
   *
   * A run directory accumulates files that are not trace content, and `runEntries` is the only
   * thing that SWEEPS it — every other command (`export`, `gc`, `scrub`) enumerates named
   * artifacts and cannot pick up a neighbour. With a denylist, each of those files shipped until
   * somebody read a packed archive and noticed:
   *
   *   mcp-config.json      MCP server `env` blocks, kept verbatim by rewriteMcpConfig — which is
   *                        where an MCP server's API token lives.
   *   shell-frames.jsonl   raw argv of every command the agent ran.
   *   mcp-frames.jsonl     raw JSON-RPC bodies.
   *   shims/               generated launchers carrying this machine's paths.
   *
   * `orca scrub` is why a denylist cannot be finished: it rewrites manifest.json, events.jsonl and
   * blobs/ and NOTHING else, so a user who scrubbed a secret and pushed was shipping an unscrubbed
   * copy of it in the raw logs — scrub said it succeeded and the secret went out anyway.
   *
   * Asserted on ENTRY NAMES, exactly like the TLS test beside it and for the same reason: zip names
   * are stored uncompressed while payloads are deflated, so a body scan can pass over a file that
   * is very much in the archive.
   */
  it('packs only trace content, never the capture scaffolding beside it', async () => {
    await seedRun();
    const dir = join(workspace, '.orca', 'runs', runId);
    await writeFile(
      join(dir, 'mcp-config.json'),
      `${JSON.stringify({
        mcpServers: { gh: { command: 'x', env: { GITHUB_TOKEN: 'ghp_scaffolding_secret' } } },
      })}\n`,
    );
    await writeFile(
      join(dir, 'shell-frames.jsonl'),
      '{"name":"curl","argv":["-H","Authorization: Bearer shell_frame_secret"]}\n',
    );
    await writeFile(
      join(dir, 'mcp-frames.jsonl'),
      '{"jsonrpc":"2.0","result":"mcp_frame_secret"}\n',
    );
    await mkdir(join(dir, 'shims'), { recursive: true });
    await writeFile(join(dir, 'shims', 'curl'), '#!/bin/sh\nexec orca-shell-shim "$@"\n');
    // Kept: the scrub ledger says a run WAS scrubbed, by rule and count and never by value.
    await writeFile(join(dir, 'redactions.json'), '{"records":[{"rule":"scrub","count":2}]}\n');
    // WITHHELD unless --fs: the shadow store is the largest thing scrub cannot rewrite, and a
    // scrub that reports "objects still hold the material" must not be followed by a push that
    // ships them anyway. See FS_SNAPSHOT_DIR.
    await mkdir(join(dir, 'fs', 'objects'), { recursive: true });
    await writeFile(join(dir, 'fs', 'objects', 'aa'), 'workspace_snapshot_secret\n');
    await mkdir(join(dir, 'fs', 'shims'), { recursive: true });
    await writeFile(join(dir, 'fs', 'shims', 'recorded'), 'the user recorded this\n');

    await pushCommand(parseArgs(['push', runId, '--gateway', url]), out, workspace, env());

    const sent = received.find((r) => r.method === 'POST');
    expect(sent, 'the push must have happened').toBeTruthy();
    const start = sent!.body.indexOf('PK');
    const end = sent!.body.lastIndexOf('\r\n--');
    const names = (await readArchive(new Uint8Array(sent!.body.subarray(start, end))))
      .map((e) => e.name)
      .sort();
    expect(names).toEqual([
      `${runId}/blobs/ab/abcdef`,
      `${runId}/events.jsonl`,
      `${runId}/manifest.json`,
      `${runId}/redactions.json`,
    ]);

    // The payload backstop, for anything that arrives by another route.
    const body = sent!.body.toString('latin1');
    for (const secret of [
      'ghp_scaffolding_secret',
      'shell_frame_secret',
      'mcp_frame_secret',
      'workspace_snapshot_secret',
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  /*
  --fs IS THE OPT-IN, AND IT SAYS SO.

  The snapshots are still pushable for the case they exist for — a teammate who needs the tree to
  reproduce — but as a decision the pusher makes rather than a default they inherit, because
  `orca scrub` cannot rewrite the store and says as much itself.
  */
  it('ships the workspace snapshots only when --fs asks, and warns when it does', async () => {
    await seedRun();
    const dir = join(workspace, '.orca', 'runs', runId);
    await mkdir(join(dir, 'fs', 'objects'), { recursive: true });
    await writeFile(join(dir, 'fs', 'objects', 'aa'), 'snapshot\n');
    await mkdir(join(dir, 'fs', 'shims'), { recursive: true });
    await writeFile(join(dir, 'fs', 'shims', 'recorded'), 'the user recorded this\n');

    await pushCommand(parseArgs(['push', runId, '--gateway', url, '--fs']), out, workspace, env());

    const sent = received.find((r) => r.method === 'POST');
    const start = sent!.body.indexOf('PK');
    const end = sent!.body.lastIndexOf('\r\n--');
    const names = (await readArchive(new Uint8Array(sent!.body.subarray(start, end))))
      .map((e) => e.name)
      .sort();
    expect(names).toContain(`${runId}/fs/objects/aa`);
    // A NESTED copy of an excluded name is content, not scaffolding: the filter is top-level only.
    expect(names).toContain(`${runId}/fs/shims/recorded`);

    // The disclosure is stated rather than left to be discovered.
    const packed = logs.find((e) => e.event === 'push.packed');
    expect(packed?.fields?.fs).toBe('included');
    expect(
      logs.some((e) => e.event === 'push.fs_included'),
      'shipping the snapshots must say that scrub could not clean them',
    ).toBe(true);
  });

  /**
   * A STALE-BREAK MUST NOT REMOVE A LOCK THAT IS ALIVE.
   *
   * Two waiters can judge the same abandoned lock stale. The break then read the lock's bytes BY
   * PATH and asked `releaseRunLock` to remove "that" token — which read the same path again. Two
   * reads of one path are not evidence about each other:
   *
   *   W1 and W2 both stat the abandoned lock: stale.
   *   W1 breaks it and acquires — a FRESH lock now sits at that path.
   *   W2 reads the path, gets W1's fresh token, and removes it as though it were the stale one.
   *   W2 acquires beside W1 — two pulls doing recovery-and-swap on one run.
   *
   * Driven directly at the break, because the window is inside `withRunLock`'s retry loop and no
   * caller can interpose on it.
   */
  it('breaks the stale lock it claimed, never a live one that replaced it', async () => {
    const runs = join(workspace, '.orca', 'runs');
    await mkdir(runs, { recursive: true });
    const lock = join(runs, `${runId}.lock`);

    // W1's fresh lock, standing where W2 last saw a stale one. Written NOW, so it is not stale.
    const fresh = `${process.pid} w1-is-working\n`;
    await writeFile(lock, fresh);

    await breakStaleRunLock(lock);

    expect(
      await readFile(lock, 'utf8').catch(() => undefined),
      'a live holder’s lock was removed by another waiter’s stale-break',
    ).toBe(fresh);
    // And nothing is left lying about beside it.
    expect((await readdir(runs)).filter((n) => n.includes('.breaking.'))).toEqual([]);

    // The genuinely stale case still works, or the lock would never be reclaimable.
    const old = new Date(Date.now() - 30 * 60 * 1000);
    await writeFile(lock, '424242 abandoned\n');
    await utimes(lock, old, old);
    await breakStaleRunLock(lock);
    expect(await readFile(lock, 'utf8').catch(() => undefined)).toBeUndefined();
    expect((await readdir(runs)).filter((n) => n.includes('.breaking.'))).toEqual([]);
  });

  /*
  A RELEASE MUST NOT DELETE A LOCK IT NO LONGER OWNS, AND READ-THEN-UNLINK CANNOT PROMISE THAT.

  The old body compared the bytes at the path with its token and unlinked THE PATH two awaits
  later. Reachable whenever a stale-break has handed the path on: the read still returns our own
  token (taken before the break), the comparison passes, and the unlink removes the FRESH lock that
  replaced it. A third pull then walks in beside the second — the concurrent recovery-and-swap this
  lock exists to prevent.

  WHAT THIS TEST DOES AND DOES NOT PROVE, because the distinction matters. It pins the CONTRACT —
  a release never removes a lock whose bytes are not ours — and the old read-then-unlink body
  satisfies that for a file that is already someone else’s when the call starts. What it cannot
  stage without mocking fs is the interleaving itself: the swap landing between the read and the
  unlink. That window is closed structurally rather than by assertion, by deciding on a copy no
  other process can reach.

  It is not toothless: removing the claim’s restore-before-delete rule fails this test along with
  the two below it, because the released file then disappears instead of going back.
  */
  it('releases only the exact lock file it claimed, never the path', async () => {
    const runs = join(workspace, '.orca', 'runs');
    await mkdir(runs, { recursive: true });
    const lock = join(runs, `${runId}.lock`);
    const mine = `${process.pid} mine\n`;
    const theirs = '424242 a-newer-pull\n';

    // What a stale-break leaves behind: someone else's lock at the path we were holding.
    await writeFile(lock, theirs);
    await releaseRunLock(lock, mine);
    expect(
      await readFile(lock, 'utf8').catch(() => undefined),
      'a newer pull’s lock was deleted by the previous holder’s release',
    ).toBe(theirs);
    expect((await readdir(runs)).filter((n) => n.includes('.releasing.'))).toEqual([]);

    // And the ordinary case still works, or the lock would never come off.
    await writeFile(lock, mine);
    await releaseRunLock(lock, mine);
    expect(await readFile(lock, 'utf8').catch(() => undefined)).toBeUndefined();
    expect((await readdir(runs)).filter((n) => n.includes('.releasing.'))).toEqual([]);
  });

  /*
  A BREAK THAT CANNOT RETURN A LIVE LOCK MUST LEAVE IT, NOT DELETE IT.

  breakStaleRunLock claims the file before it judges the age, which is what makes the judgement
  sound — but the previous version then removed the aside UNCONDITIONALLY after a swallowed `link`
  failure. So when the path had been re-taken in that window, the live holder's only lock file was
  deleted by the very function whose contract is "without ever removing a LIVE one", and two pulls
  ran in the same critical section.

  Here the path is occupied by a third party before the restore, which is exactly that window.
  */
  it('leaves a live holder’s lock behind rather than deleting it when the path is taken', async () => {
    const runs = join(workspace, '.orca', 'runs');
    await mkdir(runs, { recursive: true });
    const lock = join(runs, `${runId}.lock`);
    await writeFile(lock, 'live-holder\n');

    // Occupy the path the instant the break claims the file, so `link` cannot put it back. Done by
    // racing a writer against the break rather than by mocking, so the EEXIST is the real one.
    const broke = breakStaleRunLock(lock);
    await writeFile(lock, 'a-third-pull\n', { flag: 'w' });
    await broke;

    // The third pull's lock is intact — the break did not clobber it …
    expect(await readFile(lock, 'utf8')).toBe('a-third-pull\n');
    // … and the live holder's token still exists somewhere rather than having been destroyed.
    const asides = (await readdir(runs)).filter((n) => n.includes('.breaking.'));
    const survived =
      asides.length > 0 && (await readFile(join(runs, asides[0]!), 'utf8')) === 'live-holder\n';
    expect(
      survived,
      'the break deleted a lock it could not return — the outcome it exists to prevent',
    ).toBe(true);
  });

  /*
  A LIVE HOLDER MUST NEVER LOOK STALE.

  The lock was written once and never touched again, so "stale" meant "created more than ten
  minutes ago", not "dead" — and the work under the lock is the staging write, one file per archive
  entry. A pull whose staging outruns STALE_LOCK_MS had its lock broken WHILE IT WAS WRITING.

  The heartbeat is asserted by observing the mtime advance under a held lock, with STALE_LOCK_MS
  left alone: a real timer on a real file, so it fails if the interval is never armed, is armed on
  the wrong path, or is cleared too early.
  */
  it('keeps a held lock’s mtime fresh while the critical section runs', async () => {
    const runs = join(workspace, '.orca', 'runs');
    await mkdir(runs, { recursive: true });
    const dest = join(runs, runId);
    const lock = `${dest}.lock`;

    // Fake timers so the real LOCK_HEARTBEAT_MS (a third of the ten-minute stale window) can be
    // crossed without the test waiting for it. The value comes from the source rather than being
    // re-derived here, so changing one does not silently stop exercising the other.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let aged = 0;
      let beaten = 0;
      await withRunLockForTest(dest, async () => {
        // Age the lock by hand: without a heartbeat nothing ever writes this file again, so the
        // mtime stays exactly where it was put and the break judges a working pull abandoned.
        const old = new Date(Date.now() - 60 * 60 * 1000);
        await utimes(lock, old, old);
        aged = (await stat(lock)).mtimeMs;
        await vi.advanceTimersByTimeAsync(LOCK_HEARTBEAT_MS + 50);
        beaten = (await stat(lock)).mtimeMs;
      });
      expect(
        beaten > aged,
        'the lock’s mtime never advanced while it was held, so a pull whose staging outruns ' +
          'STALE_LOCK_MS still has its lock broken underneath it',
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // …and the beat stops with the lock, rather than keeping the process alive or writing to a
    // path that no longer belongs to it.
    await writeFile(lock, 'someone-else\n');
    const settled = (await stat(lock)).mtimeMs;
    await new Promise((ok) => setTimeout(ok, 120));
    expect((await stat(lock)).mtimeMs).toBe(settled);
  });

  /*
  A PULL THAT LOST THE LOCK MUST NOT TIDY UP AFTER THE ONE THAT TOOK IT.

  The ownership re-check added before the swap stops an interrupted pull from resuming INTO the
  renames — but it aborts by throwing, and the catch that follows was written for the ordinary
  failure, where this pull is still the owner and the scratch paths are its own. Under the very
  interleaving the check exists to describe they are not:

    A holds the lock and is part-way through writing `<run>.incoming`; A is stopped.
    More than STALE_LOCK_MS later, B breaks the lock and stages into the SAME path — the scratch
      names are deterministic per destination, which is what makes a half-done swap recoverable.
    A resumes, its `stillHeld()` reports false, and A throws.
    A's catch then `rm -rf`s `<run>.incoming` — B's in-flight staging — and renames `<run>.replaced`
      back over the run B moved aside.

  So the check meant to prevent a destructive resume performed the destruction itself, on state that
  by then belonged to another process. B finishes by renaming a gutted staging into place and prints
  `pull.done`.

  The revert is lock-protected work like everything else in that critical section, so it is gated on
  ownership rather than on which error was thrown — an ENOENT raised BY B's own recovery reaches the
  same catch with no flag to distinguish it. Leaving the litter is safe and already designed for:
  `recoverInterruptedSwap` runs under the lock at the head of every pull and reclaims both siblings.
  */
  it('leaves the shared scratch alone when the swap aborts because the lock was taken', async () => {
    const runs = join(workspace, '.orca', 'runs');
    await mkdir(runs, { recursive: true });
    const dest = join(runs, runId);
    const staging = `${dest}.incoming`;
    const retired = `${dest}.replaced`;

    // What the new holder is part-way through writing, under the shared deterministic name …
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'events.jsonl'), 'the new holder\n');
    // … and the run it moved aside to make room for it.
    await mkdir(retired, { recursive: true });
    await writeFile(join(retired, 'events.jsonl'), 'the old run\n');

    await revertStagedSwap(async () => false, { dest, staging, retired, existing: true });

    expect(
      await readFile(join(staging, 'events.jsonl'), 'utf8').catch(() => undefined),
      'the aborting pull deleted the staging directory the lock’s new holder was writing into',
    ).toBe('the new holder\n');
    expect(
      await readFile(join(retired, 'events.jsonl'), 'utf8').catch(() => undefined),
      'the aborting pull moved back a run it no longer owns, out from under the new holder’s swap',
    ).toBe('the old run\n');

    // …and while the lock IS still ours the revert must still revert, or an ordinary failed pull
    // would report "the pull did not happen" with the run missing and the litter left in place.
    await revertStagedSwap(async () => true, { dest, staging, retired, existing: true });
    expect(await readFile(join(dest, 'events.jsonl'), 'utf8')).toBe('the old run\n');
    expect(await stat(staging).catch(() => undefined)).toBeUndefined();
  });

  /*
  A ZIP NAMES A DIRECTORY WITH A TRAILING SLASH, and pull wrote it as a file.

  Nothing this CLI produces emits such an entry (runEntries walks files), but pull reads archives
  from the gateway and from whatever wrote them before that, and every general-purpose zip writer
  emits them. The silent case is the one that matters: an archive whose directory entry has no file
  under it installed a run whose `blobs` was a zero-byte FILE, and the pull printed pull.done.
  */
  it('creates a directory for a trailing-slash zip entry instead of writing it as a file', async () => {
    const dirEntry = { name: `${runId}/blobs/`, bytes: new Uint8Array() };
    const manifest = {
      name: `${runId}/manifest.json`,
      bytes: new TextEncoder().encode(
        `${JSON.stringify({ run_id: runId, schema_version: '0.1.0' })}\n`,
      ),
    };
    const events = {
      name: `${runId}/events.jsonl`,
      bytes: new TextEncoder().encode('{"seq":1,"type":"run.start"}\n'),
    };
    // Directory entry FIRST is what `zip -r` emits, and is the ordering that used to fail the
    // whole pull with ENOTDIR on the next entry under it.
    reply = {
      status: 200,
      body: Buffer.from(
        await writeArchive([
          manifest,
          dirEntry,
          { name: `${runId}/blobs/ab/abcdef`, bytes: new Uint8Array([1, 2, 3]) },
          events,
        ]),
      ),
      headers: { 'content-type': 'application/zip' },
    };

    await pullCommand(parseArgs(['pull', runId, '--gateway', url]), out, workspace, env());

    const blobs = join(workspace, '.orca', 'runs', runId, 'blobs');
    expect((await stat(blobs)).isDirectory()).toBe(true);
    expect(await readFile(join(blobs, 'ab', 'abcdef'))).toEqual(Buffer.from([1, 2, 3]));
  });

  /*
  AN EXPORTED KEY IS HOMED AT ORCA_GATEWAY_URL, AND NOWHERE ELSE.

  `envHome` read `ORCA_GATEWAY_URL ?? configured`, which substituted a home the key had never been
  associated with — and the README’s own CI recipe exports the KEY ALONE, so the substitution fired
  on the common case. A key exported for host A then travelled to the configured host B, in place
  of B’s own stored key, because the stored branch is the env branch’s `else`.

  Both directions are asserted, since the fix must not simply withhold everything: the configured
  host still gets its OWN key, and the CI shape still works.
  */
  it('does not send an exported key to a host only the config named', async () => {
    await seedRun();
    await writeConfig(
      { gateway: { url, url_source: 'named', api_key: 'sk-stored-for-this-host' } },
      { XDG_CONFIG_HOME: home },
    );
    // The README’s CI recipe: the key is exported, no URL is.
    const keyOnly = {
      XDG_CONFIG_HOME: home,
      ORCA_GATEWAY_KEY: 'sk-exported-for-somewhere-else',
    };

    await pushCommand(parseArgs(['push', runId]), out, workspace, keyOnly);

    const req = received[0]!;
    expect(req.auth, 'a key with no home of its own was sent to a host only the config named').toBe(
      'Bearer sk-stored-for-this-host',
    );
    expect(req.body.toString('utf8')).not.toContain('sk-exported-for-somewhere-else');

    // The CI shape is untouched: nothing earlier associated the key with a host, and THIS
    // invocation names the destination.
    received.length = 0;
    await pushCommand(parseArgs(['push', runId, '--gateway', url]), out, workspace, {
      XDG_CONFIG_HOME: home,
      ORCA_GATEWAY_KEY: 'sk-ci',
    });
    expect(received[0]!.auth).toBe('Bearer sk-ci');
  });

  /**
   * PUSH HAS NO DEFAULT DESTINATION — and `orca setup`'s own default is not one either.
   *
   * README's "Never a default destination" says a run goes only where you NAMED, because a run
   * carries source, shell output and workspace snapshots. The code read `config.gateway.url`, and
   * `orca setup` writes ORCAROUTER_URL into that field when you press Enter — so plain
   * `orca setup` followed by `orca push last` sent all of it to a host the user never typed.
   */
  it('refuses to push to a gateway orca setup chose rather than the user', async () => {
    await seedRun();
    await writeConfig(
      { gateway: { url: 'https://api.orcarouter.ai', url_source: 'default', api_key: 'sk-x' } },
      { XDG_CONFIG_HOME: home },
    );
    const noEnv = { XDG_CONFIG_HOME: home };

    await expect(pushCommand(parseArgs(['push', runId]), out, workspace, noEnv)).rejects.toThrow(
      /not a destination you named/,
    );
    expect(received).toHaveLength(0);

    // The same URL, NAMED, is fine — the rule is about provenance, not about the host.
    await writeConfig(
      { gateway: { url, url_source: 'named', api_key: 'sk-x' } },
      { XDG_CONFIG_HOME: home },
    );
    await pushCommand(parseArgs(['push', runId]), out, workspace, noEnv);
    expect(received).toHaveLength(1);
  });

  /**
   * Configs written before `url_source` existed carry no provenance, so the URL decides. Setup
   * writes ORCAROUTER_URL and nothing else without being told, so any OTHER origin can only have
   * been named.
   */
  it('treats a pre-provenance config as named unless it is the CLI’s own default', async () => {
    await seedRun();
    const noEnv = { XDG_CONFIG_HOME: home };

    await writeConfig(
      { gateway: { url: 'https://api.orcarouter.ai', api_key: 'sk-x' } },
      { XDG_CONFIG_HOME: home },
    );
    await expect(pushCommand(parseArgs(['push', runId]), out, workspace, noEnv)).rejects.toThrow(
      /not a destination you named/,
    );
    expect(received).toHaveLength(0);

    await writeConfig({ gateway: { url, api_key: 'sk-x' } }, { XDG_CONFIG_HOME: home });
    await pushCommand(parseArgs(['push', runId]), out, workspace, noEnv);
    expect(received).toHaveLength(1);
  });
});
