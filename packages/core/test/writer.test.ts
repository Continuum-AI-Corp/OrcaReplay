import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobRef, Manifest, TraceEvent } from '@orcareplay/schema';
import { INLINE_PAYLOAD_LIMIT, RUN_ID_PATTERN, validateManifest } from '@orcareplay/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../src/blobs.js';
import { TraceWriter } from '../src/writer.js';

let root: string;
let runs: string;

const INIT = {
  adapter: { id: 'claude-code', version: '0.1.0' },
  argv: ['claude', '--dangerously-skip-permissions'],
  cwd: '/workspace',
  orcaVersion: '0.1.0',
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-writer-'));
  runs = join(root, 'runs');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function lines(w: TraceWriter): Promise<TraceEvent[]> {
  const raw = await readFile(join(w.runDir, 'events.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TraceEvent);
}

describe('events that happened before they were written', () => {
  /**
   * Shell and MCP frames are drained from disk after the agent exits, so stamping them at write
   * time put every one of them at the end of the run with the final turn number — `ts`, `mono_us`
   * and `turn` all wrong, no possible interleaving with the model events they sit between, and
   * `causes` unable to link a tool call to the command it produced. Spec §2.1 calls `mono_us`
   * authoritative for duration, which it cannot be if it records the drain.
   */
  it('uses the time an event happened, not the time it was written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-when-'));
    const writer = await TraceWriter.create(dir, {
      adapter: { id: 'claude-code', version: '0.0.0' },
      argv: ['claude-code'],
      cwd: dir,
      orcaVersion: '0.0.0',
    });
    const happened = new Date(Date.now() - 60_000);
    const event = await writer.append({
      type: 'shell.exec',
      actor: 'harness',
      turn: 2,
      occurredAt: happened,
      attrs: { argv: ['sh', '-c', 'true'] },
    });
    await writer.close(0);

    expect(event.ts).toBe(happened.toISOString());
    expect(event.mono_us).toBeGreaterThanOrEqual(0);
    await rm(dir, { recursive: true, force: true });
  });

  it('still stamps the clock itself when nothing is supplied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-when-'));
    const writer = await TraceWriter.create(dir, {
      adapter: { id: 'claude-code', version: '0.0.0' },
      argv: ['claude-code'],
      cwd: dir,
      orcaVersion: '0.0.0',
    });
    const before = Date.now();
    const event = await writer.append({ type: 'note', actor: 'orca', attrs: { rule: 'x' } });
    await writer.close(0);

    expect(Date.parse(event.ts)).toBeGreaterThanOrEqual(before - 1000);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('TraceWriter.create', () => {
  it('mints a run id matching the spec pattern', async () => {
    const w = await TraceWriter.create(runs, INIT);
    expect(w.runId).toMatch(RUN_ID_PATTERN);
    expect(w.runId).toMatch(/^run_[0-9a-f]{12}$/);
    await w.close();
  });

  it('mints a different id every time', async () => {
    const a = await TraceWriter.create(runs, INIT);
    const b = await TraceWriter.create(runs, INIT);
    expect(a.runId).not.toBe(b.runId);
    await a.close();
    await b.close();
  });

  it('honours a caller-supplied run id and rejects a malformed one', async () => {
    const w = await TraceWriter.create(runs, { ...INIT, runId: 'run_abc123' });
    expect(w.runId).toBe('run_abc123');
    expect(w.runDir).toBe(join(runs, 'run_abc123'));
    await w.close();
    await expect(TraceWriter.create(runs, { ...INIT, runId: 'nope' })).rejects.toThrow(/run id/i);
  });

  it('writes a manifest immediately, so a run that crashes is still readable', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const m = JSON.parse(await readFile(join(w.runDir, 'manifest.json'), 'utf8')) as Manifest;
    expect(validateManifest(m).errors).toEqual([]);
    expect(m.run_id).toBe(w.runId);
    expect(m.adapter.id).toBe('claude-code');
    expect(m.ended_at).toBeUndefined();
    await w.close();
  });

  it('captures the environment by allowlist only', async () => {
    process.env['ORCA_TEST_SECRET'] = 'sk-abcdefghijklmnop0123';
    process.env['ORCA_TEST_OK'] = 'yes';
    try {
      const w = await TraceWriter.create(runs, { ...INIT, envAllowlist: ['ORCA_TEST_OK'] });
      const m = await w.close();
      expect(m.env_allowlisted).toEqual({ ORCA_TEST_OK: 'yes' });
      expect(JSON.stringify(m)).not.toContain('sk-abcdef');
    } finally {
      delete process.env['ORCA_TEST_SECRET'];
      delete process.env['ORCA_TEST_OK'];
    }
  });

  it('starts the sequence at zero', async () => {
    const w = await TraceWriter.create(runs, INIT);
    expect(w.seq).toBe(0);
    await w.close();
  });
});

describe('TraceWriter.append', () => {
  it('assigns a dense sequence from zero', async () => {
    const w = await TraceWriter.create(runs, INIT);
    for (let i = 0; i < 5; i++) await w.append({ type: 'note', actor: 'orca' });
    expect((await lines(w)).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(w.seq).toBe(5);
    await w.close();
  });

  it('stamps a wall clock and a monotonic clock', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const first = await w.append({ type: 'run.start', actor: 'orca' });
    await new Promise((r) => setTimeout(r, 8));
    const second = await w.append({ type: 'note', actor: 'orca' });
    expect(Date.parse(first.ts)).not.toBeNaN();
    expect(first.mono_us).toBeGreaterThanOrEqual(0);
    expect(second.mono_us).toBeGreaterThan(first.mono_us);
    expect(Number.isInteger(second.mono_us)).toBe(true);
    await w.close();
  });

  it('writes exactly one newline-terminated line per event', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'orca' });
    await w.append({ type: 'note', actor: 'orca' });
    const raw = await readFile(join(w.runDir, 'events.jsonl'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trimEnd().split('\n')).toHaveLength(2);
    await w.close();
  });

  it('carries turn, causes and attrs through', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'model.request', actor: 'gateway', turn: 3, attrs: { model: 'opus' } });
    const e = await w.append({ type: 'model.response', actor: 'model', turn: 3, causes: [0] });
    expect(e.causes).toEqual([0]);
    const written = await lines(w);
    expect(written[0]?.attrs).toEqual({ model: 'opus' });
    expect(written[0]?.turn).toBe(3);
    await w.close();
  });

  it('defaults the turn to the last one used', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'orca' });
    await w.append({ type: 'note', actor: 'orca', turn: 2 });
    const e = await w.append({ type: 'note', actor: 'orca' });
    expect(e.turn).toBe(2);
    expect((await lines(w)).map((x) => x.turn)).toEqual([0, 2, 2]);
    await w.close();
  });

  it('validates before writing — an invalid event never reaches disk', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'orca' });
    await expect(w.append({ type: 'model.telepathy' as 'note', actor: 'orca' })).rejects.toThrow(
      /invalid trace event/,
    );
    await expect(w.append({ type: 'note', actor: 'wizard' as 'orca' })).rejects.toThrow(
      /invalid trace event/,
    );
    expect(await lines(w)).toHaveLength(1);
    await w.close();
  });

  it('keeps a small payload inline', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({ type: 'note', actor: 'orca', payload: { hello: 'world' } });
    expect(e.payload).toEqual({ hello: 'world' });
    expect(await new BlobStore(join(w.runDir, 'blobs')).count()).toBe(0);
    await w.close();
  });

  it('spills an oversized payload to a blob (spec §2.2)', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const big = { text: 'x'.repeat(INLINE_PAYLOAD_LIMIT + 1) };
    const e = await w.append({ type: 'model.request', actor: 'gateway', payload: big });
    const ref = e.payload as BlobRef;
    expect(ref.$blob).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ref.media_type).toBe('application/json');
    const store = new BlobStore(join(w.runDir, 'blobs'));
    expect(JSON.parse(Buffer.from(await store.get(ref)).toString('utf8'))).toEqual(big);
    const raw = await readFile(join(w.runDir, 'events.jsonl'), 'utf8');
    expect(raw.length).toBeLessThan(INLINE_PAYLOAD_LIMIT);
    await w.close();
  });

  it('stores one blob for a payload resent across turns', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const big = { conversation: 'y'.repeat(INLINE_PAYLOAD_LIMIT + 1) };
    const a = await w.append({ type: 'model.request', actor: 'gateway', turn: 0, payload: big });
    const b = await w.append({ type: 'model.request', actor: 'gateway', turn: 1, payload: big });
    expect((a.payload as BlobRef).$blob).toBe((b.payload as BlobRef).$blob);
    const m = await w.close();
    expect(m.counts?.blobs).toBe(1);
    expect(m.integrity?.blob_count).toBe(1);
  });

  it('refuses to append after close', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.close();
    await expect(w.append({ type: 'note', actor: 'orca' })).rejects.toThrow(/closed/i);
  });

  it('keeps concurrent appends dense and unmangled', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => w.append({ type: 'note', actor: 'orca', attrs: { i } })),
    );
    const written = await lines(w);
    expect(written.map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(new Set(written.map((e) => e.attrs?.['i'])).size).toBe(40);
    await w.close();
  });
});

describe('redaction is on the write path', () => {
  it('never writes a secret found in a payload', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({
      type: 'model.request',
      actor: 'gateway',
      payload: { headers: { authorization: 'Bearer sk-abcdefghijklmnop0123456789' } },
    });
    const raw = await readFile(join(w.runDir, 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('sk-abcdefghijklmnop');
    expect(raw).toMatch(/<secret:openai_key:[0-9a-f]{8}>/);
    expect(JSON.stringify(e)).not.toContain('sk-abcdefghijklmnop');
    await w.close();
  });

  it('never writes a secret found in attrs', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({
      type: 'shell.exec',
      actor: 'tool',
      attrs: { cmd: 'curl -H "x: AKIAIOSFODNN7EXAMPLE"' },
    });
    const raw = await readFile(join(w.runDir, 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('AKIAIOSFODNN7EXAMPLE');
    await w.close();
  });

  it('never writes a secret into a spilled blob either', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({
      type: 'model.request',
      actor: 'gateway',
      payload: { pad: 'z'.repeat(INLINE_PAYLOAD_LIMIT), key: 'sk-abcdefghijklmnop0123456789' },
    });
    const store = new BlobStore(join(w.runDir, 'blobs'));
    const body = Buffer.from(await store.get(e.payload as BlobRef)).toString('utf8');
    expect(body).not.toContain('sk-abcdefghijklmnop');
    expect(body).toMatch(/<secret:openai_key:[0-9a-f]{8}>/);
    await w.close();
  });

  it('lists identifiers of what it removed, never the material', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({
      type: 'note',
      actor: 'orca',
      payload: { key: 'sk-abcdefghijklmnop0123456789' },
    });
    expect(e.redacted?.length).toBeGreaterThan(0);
    expect(JSON.stringify(e.redacted)).not.toContain('abcdefghij');
    await w.close();
  });

  it('leaves clean events without a redacted field', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({ type: 'note', actor: 'orca', payload: { ok: 'nothing secret' } });
    expect(e.redacted).toBeUndefined();
    await w.close();
  });

  it('gives one secret one placeholder across the whole run', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const a = await w.append({ type: 'note', actor: 'orca', payload: 'sk-abcdefghijklmnop0123' });
    const b = await w.append({ type: 'note', actor: 'orca', payload: 'sk-abcdefghijklmnop0123' });
    expect(a.payload).toBe(b.payload);
    await w.close();
  });
});

describe('TraceWriter.close', () => {
  it('seals the manifest with counts, integrity and exit code', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'run.start', actor: 'orca' });
    await w.append({ type: 'run.end', actor: 'orca' });
    const m = await w.close(3);
    expect(validateManifest(m).errors).toEqual([]);
    expect(m.ended_at).toBeTruthy();
    expect(m.exit_code).toBe(3);
    expect(m.counts).toEqual({ events: 2, blobs: 0 });
    expect(m.integrity?.blob_count).toBe(0);
    expect(m.schema_version).toBe('0.1.0');
    expect(m.platform?.node).toBe(process.version);
  });

  it('records the sha256 of events.jsonl exactly (spec §6)', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'orca', payload: { a: 1 } });
    const m = await w.close();
    const raw = await readFile(join(w.runDir, 'events.jsonl'));
    expect(m.integrity?.events_sha256).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('persists the manifest it returns', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const m = await w.close(0);
    const onDisk = JSON.parse(await readFile(join(w.runDir, 'manifest.json'), 'utf8')) as Manifest;
    expect(onDisk).toEqual(m);
  });

  it('writes redactions.json by rule and identifier, never by value', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'orca', payload: { k: 'sk-abcdefghijklmnop0123' } });
    const m = await w.close();
    const raw = await readFile(join(w.runDir, 'redactions.json'), 'utf8');
    expect(raw).not.toContain('abcdefghij');
    const file = JSON.parse(raw) as { policy_version: number; records: { rule: string }[] };
    expect(file.policy_version).toBeGreaterThanOrEqual(1);
    expect(file.records.map((r) => r.rule)).toContain('openai_key');
    expect(m.redaction?.rules_fired?.['openai_key']).toBe(1);
  });

  it('is idempotent', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'orca' });
    const first = await w.close(0);
    expect(await w.close(0)).toEqual(first);
  });

  it('keeps every file it writes owner-only', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'orca' });
    await w.close();
    for (const f of ['events.jsonl', 'manifest.json', 'redactions.json']) {
      const s = await stat(join(w.runDir, f));
      expect(s.mode & 0o777, f).toBe(0o600);
    }
  });
});
