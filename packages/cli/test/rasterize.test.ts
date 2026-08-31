import { describe, expect, it } from 'vitest';
import { cardTarget, gifFrames, RENDER_DEPS, missingRenderDeps } from '../src/rasterize.js';

describe('cardTarget', () => {
  it('accepts the three formats orca can produce', () => {
    expect(cardTarget('a.svg', '--card').format).toBe('svg');
    expect(cardTarget('a.png', '--card').format).toBe('png');
    expect(cardTarget('a.gif', '--card').format).toBe('gif');
  });

  it('does not care about case, since filenames come from people', () => {
    expect(cardTarget('A.PNG', '--card').format).toBe('png');
  });

  it('refuses a format it cannot write, naming what it can', () => {
    expect(() => cardTarget('a.jpg', '--card')).toThrow(/\.svg.*\.png.*\.gif|svg, png/i);
  });

  it('refuses a name with no extension rather than guessing one', () => {
    expect(() => cardTarget('chain', '--card')).toThrow(/--card/);
  });
});

/**
 * The frame plan, kept pure so it can be tested without a browser. One frame per hop, the hold
 * carried in each frame's delay — the technique `scripts/render-demo.mjs` already proved, where
 * 107 near-identical PNGs made a 5.5 MB GIF and 22 self-timed frames said the same thing.
 */
describe('gifFrames', () => {
  it('reveals one more hop per frame, so the chain builds', () => {
    expect(gifFrames(4).map((f) => f.reveal)).toEqual([1, 2, 3, 4]);
  });

  it('holds the last frame longest, so the finished card is what the eye rests on', () => {
    const frames = gifFrames(4);
    const last = frames[frames.length - 1]!;
    expect(last.delayMs).toBeGreaterThan(frames[0]!.delayMs);
    expect(last.delayMs).toBeGreaterThanOrEqual(2000);
  });

  it('still produces a frame for a single-event chain', () => {
    expect(gifFrames(1)).toHaveLength(1);
  });

  it('produces nothing for an empty chain rather than one blank frame', () => {
    expect(gifFrames(0)).toEqual([]);
  });
});

describe('missingRenderDeps', () => {
  it('names every package the raster path needs', () => {
    expect(RENDER_DEPS).toEqual(['playwright-core', 'pngjs', 'gifenc']);
  });

  it('reports what is absent so the message can name it', async () => {
    const missing = await missingRenderDeps();
    expect(Array.isArray(missing)).toBe(true);
    for (const name of missing) expect(RENDER_DEPS).toContain(name);
  });
});

describe('orca doctor reports the raster toolchain', () => {
  it('says whether a card can be written as a PNG or GIF', async () => {
    const { doctorCommand } = await import('../src/commands/doctor.js');
    const { parseArgs } = await import('../src/args.js');
    const { Output, stripAnsi } = await import('../src/out.js');
    const lines: string[] = [];
    const out = new Output({ write: (l) => void lines.push(l), isTTY: false });
    const result = await doctorCommand(parseArgs(['doctor']), out, process.cwd());
    const names = result.checks.map((c) => c.name);
    expect(names).toContain('card rasteriser');
    expect(stripAnsi(lines.join('\n'))).toMatch(/svg|png/i);
  });

  // It is optional by design, so its absence must never be what makes doctor say a machine is
  // broken — recording, replaying and SVG cards all work without it.
  it('never fails the run over an optional toolchain', async () => {
    const { doctorCommand } = await import('../src/commands/doctor.js');
    const { parseArgs } = await import('../src/args.js');
    const { Output } = await import('../src/out.js');
    const out = new Output({ write: () => {}, isTTY: false });
    const result = await doctorCommand(parseArgs(['doctor']), out, process.cwd());
    const check = result.checks.find((c) => c.name === 'card rasteriser');
    expect(check?.status).not.toBe('fail');
  });
});
