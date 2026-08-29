import type { Manifest, TraceEvent } from '@orcareplay/schema';

let seq = 0;

/** Reset the seq counter so each test builds a dense, spec-conformant order. */
export function resetSeq(): void {
  seq = 0;
}

/** Build one event with spec-required envelope fields filled in. */
export function ev(partial: Partial<TraceEvent> & Pick<TraceEvent, 'type'>): TraceEvent {
  const n = partial.seq ?? seq++;
  return {
    seq: n,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    mono_us: n * 1_000_000,
    turn: partial.turn ?? 0,
    actor: partial.actor ?? 'orca',
    ...partial,
    type: partial.type,
  } as TraceEvent;
}

export function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    schema_version: '0.1.0',
    run_id: 'run_abc123',
    created_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-01T00:04:51.000Z',
    orca_version: '0.1.0',
    adapter: { id: 'claude-code', version: '1.4.0' },
    argv: ['orca', 'record', '--', 'claude'],
    cwd: '/work',
    ...over,
  };
}

/** A snapshot event for turn `turn` carrying tree id `tree`. */
export function snap(turn: number, tree: string): TraceEvent {
  return ev({ type: 'fs.snapshot', turn, actor: 'orca', attrs: { tree } });
}

/** Write a spec §1 run directory: manifest.json, events.jsonl, blobs/<ab>/<digest>. */
export async function writeRun(
  dir: string,
  run: { manifest?: Manifest; events?: TraceEvent[]; blobs?: Record<string, string | Uint8Array> },
): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(run.manifest ?? manifest()));
  const lines = (run.events ?? []).map((e) => JSON.stringify(e)).join('\n');
  await fs.writeFile(path.join(dir, 'events.jsonl'), lines === '' ? '' : `${lines}\n`);
  for (const [digest, body] of Object.entries(run.blobs ?? {})) {
    const hex = digest.replace(/^sha256:/, '');
    const shard = path.join(dir, 'blobs', hex.slice(0, 2));
    await fs.mkdir(shard, { recursive: true });
    await fs.writeFile(path.join(shard, hex), body);
  }
  return dir;
}

/** A unique scratch directory under the OS temp dir. */
export async function tempRunDir(label: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  return fs.mkdtemp(path.join(os.tmpdir(), `orca-viewer-${label}-`));
}
