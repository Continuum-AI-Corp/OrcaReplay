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
