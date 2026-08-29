import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEvent } from '@orcareplay/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../src/blobs.js';

let dir: string;
let store: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-blobs-'));
  store = new BlobStore(join(dir, 'blobs'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every file under the blob root, relative to it. */
async function allFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const shards = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    for (const f of await readdir(join(root, shard.name))) out.push(`${shard.name}/${f}`);
  }
  return out.sort();
}

describe('BlobStore.put', () => {
  it('returns a spec-shaped ref with the sha256 of the content', async () => {
    const ref = await store.put('hello');
    // sha256('hello')
    expect(ref.$blob).toBe(
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(ref.bytes).toBe(5);
    expect(ref.media_type).toBeUndefined();
  });

  it('produces a ref the event schema accepts as a payload', async () => {
    const ref = await store.put('hello', 'text/plain');
    const r = validateEvent({
      seq: 0,
      ts: '2026-08-29T10:00:00.000Z',
      mono_us: 0,
      turn: 0,
      type: 'note',
      actor: 'orca',
      payload: ref,
    });
    expect(r.valid, r.errors.join(',')).toBe(true);
  });

  it('shards by the first two hex chars of the digest (spec §2.2)', async () => {
    const ref = await store.put('hello');
    const hex = ref.$blob.slice('sha256:'.length);
    const files = await allFiles(join(dir, 'blobs'));
    expect(files).toEqual([`${hex.slice(0, 2)}/${hex}`]);
  });

  it('stores identical content once — this is what keeps a trace O(n), not O(n²)', async () => {
    const a = await store.put('the whole conversation, resent every turn');
    const b = await store.put('the whole conversation, resent every turn');
    expect(b.$blob).toBe(a.$blob);
    expect(await store.count()).toBe(1);
    expect(await allFiles(join(dir, 'blobs'))).toHaveLength(1);
  });

  it('does not rewrite a blob that already exists', async () => {
    const ref = await store.put('immutable');
    const hex = ref.$blob.slice('sha256:'.length);
    const path = join(dir, 'blobs', hex.slice(0, 2), hex);
    const before = await stat(path);
    await new Promise((r) => setTimeout(r, 12));
    await store.put('immutable');
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it('keeps distinct content in distinct files', async () => {
    const a = await store.put('one');
    const b = await store.put('two');
    expect(a.$blob).not.toBe(b.$blob);
    expect(await store.count()).toBe(2);
  });

  it('counts bytes, not characters, for multi-byte strings', async () => {
    const ref = await store.put('héllo 🐳');
    expect(ref.bytes).toBe(Buffer.byteLength('héllo 🐳', 'utf8'));
  });

  it('records the media type when given', async () => {
    const ref = await store.put(new Uint8Array([1, 2, 3]), 'application/octet-stream');
    expect(ref.media_type).toBe('application/octet-stream');
    expect(ref.bytes).toBe(3);
  });

  it('writes blobs unreadable by other users — a trace is sensitive material', async () => {
    const ref = await store.put('secret-ish');
    const hex = ref.$blob.slice('sha256:'.length);
    const s = await stat(join(dir, 'blobs', hex.slice(0, 2), hex));
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('stores an empty blob', async () => {
    const ref = await store.put('');
    expect(ref.bytes).toBe(0);
    expect(await store.count()).toBe(1);
    expect(await store.get(ref)).toEqual(new Uint8Array());
  });
});

describe('BlobStore.get', () => {
  it('round-trips binary content exactly', async () => {
    const data = new Uint8Array([0, 1, 254, 255, 10, 13]);
    const ref = await store.put(data);
    expect(await store.get(ref)).toEqual(data);
  });

  it('round-trips utf-8 text', async () => {
    const ref = await store.put('héllo 🐳');
    expect(Buffer.from(await store.get(ref)).toString('utf8')).toBe('héllo 🐳');
  });

  it('accepts a prefixed digest string as well as a ref', async () => {
    const ref = await store.put('by digest');
    expect(await store.get(ref.$blob)).toEqual(await store.get(ref));
  });

  it('accepts a bare hex digest', async () => {
    const ref = await store.put('bare hex');
    expect(await store.get(ref.$blob.slice('sha256:'.length))).toEqual(await store.get(ref));
  });

  it('throws an error naming the digest when the blob is missing', async () => {
    const missing = `sha256:${'a'.repeat(64)}`;
    await expect(store.get(missing)).rejects.toThrow(/a{64}/);
  });

  it('rejects a malformed digest rather than reading an arbitrary path', async () => {
    await expect(store.get('sha256:../../etc/passwd')).rejects.toThrow(/digest/i);
  });
});

describe('BlobStore.has / count', () => {
  it('reports presence by digest, with or without the prefix', async () => {
    const ref = await store.put('present');
    expect(await store.has(ref.$blob)).toBe(true);
    expect(await store.has(ref.$blob.slice('sha256:'.length))).toBe(true);
    expect(await store.has(`sha256:${'b'.repeat(64)}`)).toBe(false);
  });

  it('counts zero for a store that has never been written to', async () => {
    expect(await store.count()).toBe(0);
    expect(await store.has(`sha256:${'c'.repeat(64)}`)).toBe(false);
  });

  it('counts blobs across shards', async () => {
    for (let i = 0; i < 25; i++) await store.put(`content ${i}`);
    expect(await store.count()).toBe(25);
  });
});
