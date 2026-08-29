import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlobRef } from '@orcareplay/schema';

/** Traces are sensitive material (design §7), so nothing is group- or world-readable. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const HEX64 = /^[0-9a-f]{64}$/;
const PREFIX = 'sha256:';

/** Accepts `sha256:<hex>` or a bare hex digest and returns the bare hex. */
function bareDigest(ref: BlobRef | string): string {
  const raw = typeof ref === 'string' ? ref : ref.$blob;
  const hex = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;
  if (!HEX64.test(hex)) throw new Error(`invalid blob digest: ${JSON.stringify(raw)}`);
  return hex;
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'utf8')) : data;
}

/**
 * Content-addressed blob store, laid out as `<dir>/<first two hex>/<full hex>` (spec §2.2).
 *
 * Every model turn resends the whole conversation, so identical content arrives over and over.
 * Addressing by digest is what keeps a trace O(n) in new content instead of O(n²) in turns —
 * hence `put` of existing content must not touch the file at all.
 */
export class BlobStore {
  readonly #dir: string;

  /** @param dir The blob root, conventionally `<runDir>/blobs`. */
  constructor(dir: string) {
    this.#dir = dir;
  }

  get dir(): string {
    return this.#dir;
  }

  async put(data: Uint8Array | string, mediaType?: string): Promise<BlobRef> {
    const bytes = toBytes(data);
    const hex = createHash('sha256').update(bytes).digest('hex');
    const ref: BlobRef = { $blob: `${PREFIX}${hex}`, bytes: bytes.byteLength };
    if (mediaType !== undefined) ref.media_type = mediaType;

    const shard = join(this.#dir, hex.slice(0, 2));
    const path = join(shard, hex);
    if (await exists(path)) return ref;

    await mkdir(shard, { recursive: true, mode: DIR_MODE });
    // Write then rename so a reader never sees a half-written blob under its final digest.
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, bytes, { mode: FILE_MODE });
    await rename(tmp, path);
    return ref;
  }

  async get(ref: BlobRef | string): Promise<Uint8Array> {
    const hex = bareDigest(ref);
    const path = join(this.#dir, hex.slice(0, 2), hex);
    let buf: Buffer;
    try {
      buf = await readFile(path);
    } catch {
      throw new Error(`blob not found: ${PREFIX}${hex} (looked in ${path})`);
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async has(digest: BlobRef | string): Promise<boolean> {
    const hex = bareDigest(digest);
    return exists(join(this.#dir, hex.slice(0, 2), hex));
  }

  async count(): Promise<number> {
    let n = 0;
    for (const shard of await readdir(this.#dir, { withFileTypes: true }).catch(() => [])) {
      if (!shard.isDirectory()) continue;
      const files = await readdir(join(this.#dir, shard.name)).catch(() => []);
      n += files.filter((f) => HEX64.test(f)).length;
    }
    return n;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
