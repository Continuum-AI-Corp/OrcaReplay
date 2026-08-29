import { describe, expect, it } from 'vitest';
import { PLAYBACK_SPEEDS, playbackDelays } from '../src/render.js';

const row = (seq: number, monoUs: number) => ({ seq, monoUs });

/**
 * Playback timing. The point of playing a trace back is to feel the shape of the run — where it
 * stalled, where it looped — so the recorded gaps have to survive, compressed rather than
 * flattened. A uniform tick would throw away the only information playback adds.
 */
describe('playbackDelays', () => {
  it('returns one delay per row', () => {
    expect(playbackDelays([row(0, 0), row(1, 1_000_000), row(2, 2_000_000)], 1)).toHaveLength(3);
  });

  it('preserves the relative shape of the recorded gaps', () => {
    // 0.2s then 2s: the second gap must read as longer, or playback says nothing.
    const [, short, long] = playbackDelays([row(0, 0), row(1, 200_000), row(2, 2_200_000)], 1);
    expect(long).toBeGreaterThan(short!);
  });

  it('compresses long stalls instead of hanging on them', () => {
    // A 10-minute wait must not become a 10-minute animation.
    const delays = playbackDelays([row(0, 0), row(1, 600_000_000)], 1);
    expect(delays[1]).toBeLessThanOrEqual(1000);
  });

  it('keeps near-simultaneous events visible rather than flashing past', () => {
    const delays = playbackDelays([row(0, 0), row(1, 1), row(2, 2)], 1);
    for (const d of delays.slice(1)) expect(d).toBeGreaterThanOrEqual(60);
  });

  it('scales with speed', () => {
    const one = playbackDelays([row(0, 0), row(1, 4_000_000)], 1);
    const four = playbackDelays([row(0, 0), row(1, 4_000_000)], 4);
    expect(four[1]).toBeLessThan(one[1]!);
  });

  it('tolerates a monotonic clock that went backwards', () => {
    // mono_us should never decrease, but a trace is external input.
    const delays = playbackDelays([row(0, 5_000_000), row(1, 1_000_000)], 1);
    expect(delays.every((d) => d >= 0 && Number.isFinite(d))).toBe(true);
  });

  it('handles a single row and an empty trace', () => {
    expect(playbackDelays([row(0, 0)], 1)).toEqual([0]);
    expect(playbackDelays([], 1)).toEqual([]);
  });

  it('offers speeds that start at real time', () => {
    expect(PLAYBACK_SPEEDS[0]).toBe(1);
    expect(PLAYBACK_SPEEDS.length).toBeGreaterThan(1);
  });
});
