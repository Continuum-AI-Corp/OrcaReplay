import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobRef, TraceEvent } from '@orcareplay/schema';
import { INLINE_PAYLOAD_LIMIT } from '@orcareplay/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../src/blobs.js';
import { TraceReader } from '../src/reader.js';
import { TraceWriter } from '../src/writer.js';

let root: string;
let runs: string;

const INIT = {
  adapter: { id: 'claude-code' },
  argv: ['claude'],
  cwd: '/workspace',
  orcaVersion: '0.1.0',
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-reader-'));
  runs = join(root, 'runs');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function line(over: Partial<TraceEvent> & { seq: number }): string {
  return JSON.stringify({
    ts: '2026-08-29T10:00:00.000Z',
    mono_us: over.seq * 1000,
    turn: 0,
    type: 'note',
    actor: 'orca',
    ...over,
  });
}

/** A run directory written by hand, so corruption can be staged precisely. */
async function seedRun(runId: string, body: string): Promise<string> {
  const dir = join(runs, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema_version: '0.1.0',
      run_id: runId,
      created_at: '2026-08-29T10:00:00.000Z',
      orca_version: '0.1.0',
      adapter: { id: 'claude-code' },
      argv: ['claude'],
      cwd: '/workspace',
    }),
  );
  await writeFile(join(dir, 'events.jsonl'), body);
  return dir;
}

describe('TraceReader.open', () => {
  it('exposes the manifest', async () => {
    const dir = await seedRun('run_abc123', '');
    const r = await TraceReader.open(dir);
    expect(r.manifest().run_id).toBe('run_abc123');
    expect(r.manifest().adapter.id).toBe('claude-code');
  });

  it('names the file it could not find', async () => {
    await expect(TraceReader.open(join(runs, 'run_nope00'))).rejects.toThrow(/manifest\.json/);
  });

  it('reports an invalid manifest instead of guessing', async () => {
    const dir = join(runs, 'run_bad000');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ run_id: 'nope' }));
    await expect(TraceReader.open(dir)).rejects.toThrow(/invalid manifest/);
  });

  it('opens a run that crashed before it was closed', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'run.start', actor: 'orca' });
    const r = await TraceReader.open(w.runDir);
    expect(r.manifest().ended_at).toBeUndefined();
    expect(await r.events()).toHaveLength(1);
    await w.close();
  });
});

describe('reading events', () => {
  it('returns every event in order', async () => {
    const dir = await seedRun(
      'run_abc123',
      `${[0, 1, 2].map((seq) => line({ seq })).join('\n')}\n`,
    );
    const r = await TraceReader.open(dir);
    expect((await r.events()).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('streams the same events lazily', async () => {
    const dir = await seedRun(
      'run_abc123',
      `${[0, 1, 2].map((seq) => line({ seq })).join('\n')}\n`,
    );
    const r = await TraceReader.open(dir);
    const seen: number[] = [];
    for await (const e of r.stream()) seen.push(e.seq);
    expect(seen).toEqual([0, 1, 2]);
  });

  it('reads an empty log as no events', async () => {
    const r = await TraceReader.open(await seedRun('run_abc123', ''));
    expect(await r.events()).toEqual([]);
  });

  it('tolerates a truncated final line (spec §2)', async () => {
    const dir = await seedRun(
      'run_abc123',
      `${line({ seq: 0 })}\n${line({ seq: 1 })}\n${line({ seq: 2 }).slice(0, 40)}`,
    );
    const r = await TraceReader.open(dir);
    const events = await r.events();
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(r.problems()).toHaveLength(1);
    expect(r.problems()[0]?.line).toBe(3);
  });

  it('skips an unknown event type rather than failing (spec §2)', async () => {
    const dir = await seedRun(
      'run_abc123',
      [
        line({ seq: 0 }),
        JSON.stringify({
          seq: 1,
          ts: '2026-08-29T10:00:00.000Z',
          mono_us: 1,
          turn: 0,
          type: 'model.telepathy',
          actor: 'model',
        }),
        line({ seq: 2 }),
        '',
      ].join('\n'),
    );
    const r = await TraceReader.open(dir);
    const events = await r.events();
    expect(events.map((e) => e.seq)).toEqual([0, 2]);
    expect(r.problems()[0]?.reason).toMatch(/model\.telepathy/);
  });

  it('skips blank lines without complaint', async () => {
    const dir = await seedRun('run_abc123', `${line({ seq: 0 })}\n\n${line({ seq: 1 })}\n`);
    const r = await TraceReader.open(dir);
    expect((await r.events()).map((e) => e.seq)).toEqual([0, 1]);
    expect(r.problems()).toEqual([]);
  });

  it('reports a corrupt line in the middle without losing the rest', async () => {
    const dir = await seedRun(
      'run_abc123',
      `${line({ seq: 0 })}\n{"seq":1,"type":\n${line({ seq: 2 })}\n`,
    );
    const r = await TraceReader.open(dir);
    expect((await r.events()).map((e) => e.seq)).toEqual([0, 2]);
    expect(r.problems()).toHaveLength(1);
  });

  it('resets its problem list per pass', async () => {
    const dir = await seedRun('run_abc123', `${line({ seq: 0 })}\n{"broken"\n`);
    const r = await TraceReader.open(dir);
    await r.events();
    await r.events();
    expect(r.problems()).toHaveLength(1);
  });
});

describe('payloads and blobs', () => {
  it('returns an inline payload unchanged', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({ type: 'note', actor: 'orca', payload: { small: true } });
    await w.close();
    const r = await TraceReader.open(w.runDir);
    expect(await r.resolvePayload(e)).toEqual({ small: true });
  });

  it('returns undefined when there is no payload', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({ type: 'note', actor: 'orca' });
    await w.close();
    const r = await TraceReader.open(w.runDir);
    expect(await r.resolvePayload(e)).toBeUndefined();
  });

  it('round-trips a spilled payload through the blob store', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const big = { messages: Array.from({ length: 200 }, (_, i) => ({ role: 'user', i })) };
    const e = await w.append({ type: 'model.request', actor: 'gateway', payload: big });
    await w.close();
    const r = await TraceReader.open(w.runDir);
    expect((e.payload as BlobRef).$blob).toBeTruthy();
    expect(await r.resolvePayload(e)).toEqual(big);
    expect(JSON.stringify(big).length).toBeGreaterThan(INLINE_PAYLOAD_LIMIT);
  });

  it('hands back raw blob bytes on request', async () => {
    const w = await TraceWriter.create(runs, INIT);
    const e = await w.append({
      type: 'model.request',
      actor: 'gateway',
      payload: { pad: 'q'.repeat(INLINE_PAYLOAD_LIMIT + 1) },
    });
    await w.close();
    const r = await TraceReader.open(w.runDir);
    const bytes = await r.blob(e.payload as BlobRef);
    expect(JSON.parse(Buffer.from(bytes).toString('utf8'))).toEqual({
      pad: 'q'.repeat(INLINE_PAYLOAD_LIMIT + 1),
    });
  });

  it('returns text for a blob that is not JSON', async () => {
    const dir = await seedRun('run_abc123', '');
    const ref = await new BlobStore(join(dir, 'blobs')).put('raw sse bytes', 'text/plain');
    const r = await TraceReader.open(dir);
    const e = JSON.parse(line({ seq: 0, payload: ref })) as TraceEvent;
    expect(await r.resolvePayload(e)).toBe('raw sse bytes');
  });

  it('names the digest when a blob is missing', async () => {
    const dir = await seedRun('run_abc123', '');
    const r = await TraceReader.open(dir);
    await expect(r.blob(`sha256:${'e'.repeat(64)}`)).rejects.toThrow(/e{64}/);
  });
});

describe('verifyIntegrity', () => {
  it('accepts an untouched run (spec §6)', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'orca', payload: { a: 1 } });
    await w.close(0);
    const r = await TraceReader.open(w.runDir);
    const v = await r.verifyIntegrity();
    expect(v.ok).toBe(true);
    expect(v.actual).toBe(v.expected);
  });

  it('reports tampering rather than repairing it', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'orca' });
    const m = await w.close(0);
    await appendFile(join(w.runDir, 'events.jsonl'), `${line({ seq: 99 })}\n`);
    const v = await TraceReader.open(w.runDir).then((r) => r.verifyIntegrity());
    expect(v.ok).toBe(false);
    expect(v.expected).toBe(m.integrity?.events_sha256);
    expect(v.actual).not.toBe(v.expected);
  });

  it('cannot verify a run that was never sealed', async () => {
    const w = await TraceWriter.create(runs, INIT);
    await w.append({ type: 'note', actor: 'orca' });
    const v = await TraceReader.open(w.runDir).then((r) => r.verifyIntegrity());
    expect(v.ok).toBe(false);
    expect(v.expected).toBeUndefined();
    expect(v.actual).toMatch(/^[0-9a-f]{64}$/);
    await w.close();
  });
});
