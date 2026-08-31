/**
 * Turning a card into a raster, for the places SVG does not go.
 *
 * SVG renders in a GitHub issue and nowhere else that matters: X will not accept it as an upload,
 * and Slack and Discord give it no inline preview. So the card someone actually posts is a PNG,
 * and the one that animates is a GIF.
 *
 * Neither needs a dependency in `package.json`, and deliberately does not have one.
 * `docs/media/README.md` keeps `playwright-core`, `pngjs` and `gifenc` out so that everyone running
 * `npm ci` to work on orca does not pay for a browser download, and a picture command is not a
 * reason to reverse that. They are imported at the moment of use and their absence is an
 * actionable message naming the one line that fixes it — the same line the docs already give for
 * regenerating README art.
 *
 * `scripts/render-demo.mjs` established the encoding approach and the reason for it: the ffmpeg
 * that ships with Playwright is stripped to what Playwright needs and has neither a PNG decoder
 * nor a GIF muxer, so shelling out to it fails silently at both ends. The encoder is JavaScript
 * for that reason.
 */

/**
 * Import a package orca does not depend on.
 *
 * The specifier is a variable on purpose: a literal makes TypeScript resolve the module at build
 * time, and these are precisely the modules that are not there. Typing the result as `unknown`
 * keeps every call site honest about that.
 */
async function loadOptional(name: string): Promise<unknown> {
  return (await import(name)) as unknown;
}

/** Everything the raster path needs, in the order the install line should list them. */
export const RENDER_DEPS = ['playwright-core', 'pngjs', 'gifenc'] as const;

export type CardFormat = 'svg' | 'png' | 'gif';

export interface CardTarget {
  path: string;
  format: CardFormat;
}

/**
 * The path and format to write a card to, or a refusal naming what orca can write.
 *
 * Refusing beats succeeding falsely. Writing SVG bytes into a file called `.png` produced a file
 * no image viewer opens and a success line explaining nothing, and `.png` is precisely the request
 * people make, because it is the format that posts where SVG does not.
 */
export function cardTarget(name: string, flag: string): CardTarget {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  if (ext === 'svg' || ext === 'png' || ext === 'gif') return { path: name, format: ext };
  throw new Error(
    ext === undefined
      ? `${flag} needs a filename ending in .svg, .png or .gif — got ${JSON.stringify(name)}`
      : `${flag} cannot write .${ext}. Name it .svg, .png or .gif instead.`,
  );
}

export interface GifFrame {
  /** How many events of the chain this frame shows. */
  reveal: number;
  /** How long it is held, in milliseconds. */
  delayMs: number;
}

const FRAME_HOLD_MS = 520;
const FINAL_HOLD_MS = 2600;

/**
 * One frame per hop, with the hold carried in the frame rather than in a frame rate.
 *
 * The alternative — a frame every 40ms — is how 107 near-identical PNGs became a 5.5 MB GIF for
 * the README hero, when 22 self-timed frames said exactly the same thing. The last frame rests
 * long enough to read the finished card before the loop starts over.
 */
export function gifFrames(events: number): GifFrame[] {
  if (events <= 0) return [];
  return Array.from({ length: events }, (_, i) => ({
    reveal: i + 1,
    delayMs: i === events - 1 ? FINAL_HOLD_MS : FRAME_HOLD_MS,
  }));
}

/** Which of the optional packages are not installed. Empty means the raster path will work. */
export async function missingRenderDeps(): Promise<string[]> {
  const missing: string[] = [];
  for (const name of RENDER_DEPS) {
    try {
      await loadOptional(name);
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

/** The message shown when a raster was asked for and the toolchain is not here. */
export function installHint(missing: string[], format: CardFormat): string {
  return (
    `writing a .${format} needs ${missing.join(', ')}, which orca does not depend on: ` +
    'a browser download is not something everyone running `npm ci` should pay for.\n' +
    `  npm i --no-save ${RENDER_DEPS.join(' ')}\n` +
    '  …then run this again, or write a .svg, which never needs anything.'
  );
}

async function requireRenderDeps(format: CardFormat): Promise<void> {
  const missing = await missingRenderDeps();
  if (missing.length > 0) throw new Error(installHint(missing, format));
}

/** Load Playwright's Chromium, preferring an explicit executable when one is configured. */
async function launchChromium(): Promise<{
  shot: (svg: string) => Promise<Buffer>;
  close: () => Promise<void>;
}> {
  const { chromium } = (await loadOptional('playwright-core')) as {
    chromium: {
      launch: (o?: Record<string, unknown>) => Promise<{
        newPage: (o?: Record<string, unknown>) => Promise<{
          setContent: (html: string) => Promise<void>;
          locator: (sel: string) => { screenshot: (o: object) => Promise<Buffer> };
          close: () => Promise<void>;
        }>;
        close: () => Promise<void>;
      }>;
    };
  };
  const exe = process.env['ORCA_CHROMIUM'] ?? process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
  const browser = await chromium.launch(exe === undefined ? {} : { executablePath: exe });
  return {
    async shot(svg: string) {
      const page = await browser.newPage({ deviceScaleFactor: 2 });
      // A transparent body would composite the card onto whatever the viewer paints behind it.
      // The card draws its own ground, so the page only has to not add one of its own.
      await page.setContent(`<body style="margin:0">${svg}</body>`);
      const buffer = await page.locator('svg').screenshot({ omitBackground: true });
      await page.close();
      return buffer;
    },
    close: () => browser.close(),
  };
}

/** One SVG as a PNG, at 2× so it stays sharp when a client scales it down. */
export async function svgToPng(svg: string): Promise<Buffer> {
  await requireRenderDeps('png');
  const browser = await launchChromium();
  try {
    return await browser.shot(svg);
  } finally {
    await browser.close();
  }
}

/**
 * A sequence of SVGs as one animated GIF.
 *
 * The palette is quantised once from the final frame, which carries every colour the sequence
 * ever shows, so nothing shifts hue partway through — the failure mode of quantising per frame.
 */
export async function svgsToGif(svgs: string[], delays: number[]): Promise<Buffer> {
  await requireRenderDeps('gif');
  if (svgs.length === 0) throw new Error('nothing to animate: the chain has no events');

  const { PNG } = (await loadOptional('pngjs')) as {
    PNG: { sync: { read: (b: Buffer) => { width: number; height: number; data: Buffer } } };
  };
  const gifenc = (await loadOptional('gifenc')) as {
    default?: Record<string, unknown>;
    GIFEncoder?: unknown;
  };
  const mod = (gifenc.GIFEncoder ? gifenc : (gifenc.default ?? gifenc)) as {
    GIFEncoder: () => {
      writeFrame: (i: Uint8Array, w: number, h: number, o: object) => void;
      finish: () => void;
      bytes: () => Uint8Array;
    };
    quantize: (d: Uint8ClampedArray, n: number, o: object) => unknown;
    applyPalette: (d: Uint8ClampedArray, p: unknown, f: string) => Uint8Array;
  };

  const browser = await launchChromium();
  try {
    const frames: Array<{ width: number; height: number; data: Buffer }> = [];
    for (const svg of svgs) frames.push(PNG.sync.read(await browser.shot(svg)));

    const enc = mod.GIFEncoder();
    const last = frames[frames.length - 1]!;
    const palette = mod.quantize(new Uint8ClampedArray(last.data), 32, { format: 'rgb565' });
    for (const [i, frame] of frames.entries()) {
      const indexed = mod.applyPalette(new Uint8ClampedArray(frame.data), palette, 'rgb565');
      enc.writeFrame(indexed, frame.width, frame.height, {
        palette: i === 0 ? palette : undefined,
        delay: delays[i] ?? FRAME_HOLD_MS,
        repeat: 0,
      });
    }
    enc.finish();
    return Buffer.from(enc.bytes());
  } finally {
    await browser.close();
  }
}
