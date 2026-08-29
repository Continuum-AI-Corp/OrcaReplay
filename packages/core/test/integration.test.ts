import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceEvent } from '@orcareplay/schema';
import { INLINE_PAYLOAD_LIMIT, isBlobRef } from '@orcareplay/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveCheckpoints, snapToCheckpoint, turnsOf } from '../src/graph.js';
import { listRuns, resolveRunSelector, runsDir } from '../src/paths.js';
import { TraceReader } from '../src/reader.js';
import { TraceWriter } from '../src/writer.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'orca-e2e-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const SECRET = 'sk-proj-Ab12Cd34Ef56Gh78Ij90KlMn';

/** A two-turn run with a snapshot per turn and one oversized, secret-bearing request. */
async function record(): Promise<string> {
  const w = await TraceWriter.create(runsDir(cwd), {
    adapter: { id: 'claude-code' },
    argv: ['claude'],
    cwd,
    orcaVersion: '0.1.0',
  });
  await w.append({ type: 'run.start', actor: 'orca' });
  await w.append({ type: 'fs.snapshot', actor: 'orca', attrs: { tree: 'tree-0' } });
  const req = await w.append({
    type: 'model.request',
    actor: 'gateway',
    payload: {
      system: 'be terse',
      auth: `Bearer ${SECRET}`,
      messages: Array.from({ length: 200 }, (_, i) => ({
        role: 'user',
        text: `line ${i} of a conversation that is resent in full on every turn`,
      })),
    },
  });
  await w.append({ type: 'model.response', actor: 'model', causes: [req.seq] });
  await w.append({ type: 'fs.snapshot', actor: 'orca', turn: 1, attrs: { tree: 'tree-1' } });
  await w.append({ type: 'shell.exec', actor: 'tool', turn: 1, attrs: { cmd: `echo ${SECRET}` } });
  await w.append({ type: 'run.end', actor: 'orca', turn: 1 });
  await w.close(0);
  return w.runId;
}

async function everyFile(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await everyFile(path)));
    else out.push(path);
  }
  return out;
}

describe('record, then read it back', () => {
  it('finds the run through the workspace selector', async () => {
    const runId = await record();
    const found = await resolveRunSelector(cwd, 'last');
    expect(found.runId).toBe(runId);
    expect((await listRuns(cwd)).map((r) => r.runId)).toEqual([runId]);
  });

  it('reads every event back, in order, with nothing skipped', async () => {
    await record();
    const reader = await TraceReader.open((await resolveRunSelector(cwd, 'last')).dir);
    const events = await reader.events();
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(reader.problems()).toEqual([]);
    expect(reader.manifest().counts?.events).toBe(7);
    expect(reader.manifest().exit_code).toBe(0);
  });

  it('verifies its own integrity root', async () => {
    await record();
    const reader = await TraceReader.open((await resolveRunSelector(cwd, 'last')).dir);
    expect(await reader.verifyIntegrity()).toMatchObject({ ok: true });
  });

  it('rebuilds the spilled request from its blob', async () => {
    await record();
    const reader = await TraceReader.open((await resolveRunSelector(cwd, 'last')).dir);
    const events = await reader.events();
    const request = events.find((e) => e.type === 'model.request') as TraceEvent;
    expect(isBlobRef(request.payload)).toBe(true);
    const payload = (await reader.resolvePayload(request)) as {
      system: string;
      auth: string;
      messages: unknown[];
    };
    expect(payload.system).toBe('be terse');
    expect(payload.messages).toHaveLength(200);
    expect(payload.auth).toMatch(/^Bearer <secret:openai_key:[0-9a-f]{8}>$/);
  });

  it('offers the fork points the trace actually supports', async () => {
    await record();
    const reader = await TraceReader.open((await resolveRunSelector(cwd, 'last')).dir);
    const events = await reader.events();
    const cps = deriveCheckpoints(events);
    expect(cps.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cps.find((c) => c.seq === 6)?.fsTree).toBe('tree-1');
    expect(turnsOf(events).map((t) => t.turn)).toEqual([0, 1]);

    // seq 0 precedes the first snapshot, so there is no state to fork from.
    expect(() => snapToCheckpoint(cps, 0)).toThrow(/no checkpoint/);
    expect(snapToCheckpoint(cps, 3)).toEqual({
      checkpoint: { seq: 3, turn: 0, fsTree: 'tree-0' },
      snapped: false,
    });
  });

  it('leaves the secret nowhere on disk — events, blobs, manifest or redactions', async () => {
    await record();
    const dir = (await resolveRunSelector(cwd, 'last')).dir;
    const files = await everyFile(dir);
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      expect(await readFile(file, 'utf8'), file).not.toContain('sk-proj-Ab12Cd34');
    }
    const redactions = JSON.parse(await readFile(join(dir, 'redactions.json'), 'utf8')) as {
      records: { rule: string; count: number }[];
    };
    // The same secret in a payload and in attrs, recorded under one rule.
    expect(redactions.records.filter((r) => r.rule === 'openai_key').length).toBeGreaterThan(0);
  });

  it('keeps the log small even though the request was not', async () => {
    await record();
    const dir = (await resolveRunSelector(cwd, 'last')).dir;
    const log = await readFile(join(dir, 'events.jsonl'), 'utf8');
    expect(log.length).toBeLessThan(INLINE_PAYLOAD_LIMIT);
    expect(log.split('\n').filter(Boolean)).toHaveLength(7);
  });
});
