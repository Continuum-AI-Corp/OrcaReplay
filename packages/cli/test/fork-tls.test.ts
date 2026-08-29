import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader, listRuns } from '@orcareplay/core';
import { RunCa } from '@orcareplay/proxy';
import { validateEvent } from '@orcareplay/schema';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { replayCommand } from '../src/commands/replay.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, 'fixtures', 'fake-agent.mjs');

/**
 * `--tls-intercept` on a fork.
 *
 * The parser accepted this flag on every command and only `orca record` did anything with it, so
 * `orca replay --model`, `orca fork` and `orca compare` — the three that also launch a real agent —
 * took it and threw it away. A flag that is accepted and ignored is the worst kind: the operator
 * believes they captured the traffic, and the absence of `net.*` events reads as "the agent made no
 * other calls" rather than as "orca was not looking".
 */
describe('orca replay --model --tls-intercept', () => {
  let workspace: string;
  let originDir: string;
  let scratch: string;
  let originCa: RunCa;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let bank: { port: number; close: () => Promise<void> };
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-forktls-'));
    originDir = await mkdtemp(join(tmpdir(), 'orca-forktlsorigin-'));
    scratch = await mkdtemp(join(tmpdir(), 'orca-forktlsscratch-'));
    originCa = await RunCa.create({ runDir: originDir });

    model = await startFakeModel();
    bank = await startOrigin();

    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    process.env.ORCA_TLS_UPSTREAM_CA = originCa.certPath;
    process.env.ORCA_TEST_ORIGIN_CA = originCa.certPath;

    // A git repo, so the shadow index can snapshot — a fork needs a checkpoint, and a checkpoint
    // needs a filesystem snapshot.
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
  });

  afterEach(async () => {
    for (const key of ['ORCA_TLS_UPSTREAM_CA', 'ORCA_TEST_ORIGIN_CA', 'ORCA_TEST_TARGETS']) {
      delete process.env[key];
    }
    await model.close();
    await bank.close();
    await originCa.dispose();
    for (const dir of [workspace, originDir, scratch]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function startOrigin(): Promise<{ port: number; close: () => Promise<void> }> {
    const issued = originCa.issue('127.0.0.1');
    const server = createHttpsServer({ key: issued.keyPem, cert: issued.certPem }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ balance: 'BANK-BODY-MARKER' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: (server.address() as AddressInfo).port,
      close: () => new Promise<void>((resolve) => void server.close(() => resolve())),
    };
  }

  async function record(): Promise<void> {
    await recordCommand(
      parseArgs([
        'record',
        'generic-openai',
        '--upstream-anthropic',
        model.url,
        '--no-shell',
        '--',
        'node',
        FAKE_AGENT,
      ]),
      out,
      workspace,
    );
  }

  it('mints a CA, decrypts the allowlisted host and writes net.* into the fork trace', async () => {
    await record();
    process.env.ORCA_TEST_TARGETS = JSON.stringify([
      { host: '127.0.0.1', port: bank.port, path: '/accounts' },
    ]);

    const result = await replayCommand(
      parseArgs([
        'replay',
        'last',
        '--model',
        'claude-haiku-4-5',
        '--tls-intercept',
        '--tls-hosts',
        `127.0.0.1:${bank.port}`,
        '--upstream-anthropic',
        model.url,
      ]),
      out,
      workspace,
    );

    expect(lines.join(''), 'a fork must announce interception the way a recording does').toContain(
      'tls.intercepting',
    );

    const forkDir = (await listRuns(workspace)).find((r) => r.runId === result.forkRunId)?.dir;
    expect(forkDir, 'the fork wrote a run of its own').toBeDefined();
    const events = await (await TraceReader.open(forkDir!)).events();
    const net = events.filter((e) => e.type === 'net.request' || e.type === 'net.response');
    expect(net.length, `no net.* in the fork trace:\n${lines.join('\n')}`).toBeGreaterThanOrEqual(
      2,
    );
    for (const event of net) expect(validateEvent(event).valid).toBe(true);
    expect(net.some((e) => e.attrs?.intercepted === true)).toBe(true);
    expect(JSON.stringify(net)).toContain(String(bank.port));
  });

  it('takes the private key off disk when the fork ends', async () => {
    await record();
    const result = await replayCommand(
      parseArgs([
        'replay',
        'last',
        '--model',
        'claude-haiku-4-5',
        '--tls-intercept',
        '--tls-hosts',
        `127.0.0.1:${bank.port}`,
        '--upstream-anthropic',
        model.url,
      ]),
      out,
      workspace,
    );

    const forkDir = (await listRuns(workspace)).find((r) => r.runId === result.forkRunId)!.dir;

    // A CA really was minted — otherwise "the key is gone" is true of a run that never had one,
    // which is precisely the bug this file exists to catch.
    const events = await (await TraceReader.open(forkDir)).events();
    const note = events.find((e) => e.type === 'note' && e.attrs?.rule === 'tls_intercept');
    expect(note, 'the fork must record which CA it used, as a recording does').toBeDefined();
    expect(String(note?.attrs?.ca_sha256)).toMatch(/^[0-9A-F:]{50,}$/);

    await expect(stat(join(forkDir, 'tls'))).rejects.toThrow();
    for (const path of await walk(forkDir)) {
      expect(await readFile(path, 'utf8').catch(() => '')).not.toContain('PRIVATE KEY');
    }
  });
});

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else found.push(full);
  }
  return found;
}
