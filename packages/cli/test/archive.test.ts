import { describe, expect, it } from 'vitest';
import { readArchive, writeArchive, type ArchiveEntry } from '../src/archive.js';

/**
 * The archive format `orca push` speaks.
 *
 * A run is pushed as a zip because that is what the gateway's importer reads, and it is read back
 * by `orca pull`. Both directions live here so the pair is tested against each other rather than
 * against a fixture that could drift from either.
 *
 * Written by hand rather than with a library because the CLI takes no new runtime dependencies
 * (CONTRIBUTING, "Rules of the road") — zlib is a node builtin, and the subset of zip a trace needs
 * is small. The tests below are what makes hand-rolling it defensible.
 */
describe('archive', () => {
  const entries: ArchiveEntry[] = [
    { name: 'run-1/manifest.json', bytes: new TextEncoder().encode('{"run_id":"run-1"}\n') },
    { name: 'run-1/events.jsonl', bytes: new TextEncoder().encode('{"seq":1}\n{"seq":2}\n') },
    { name: 'run-1/blobs/ab/abcd', bytes: new Uint8Array([0, 1, 2, 250, 255]) },
  ];

  it('round-trips every entry byte for byte', async () => {
    const back = await readArchive(await writeArchive(entries));
    expect(back.map((e) => e.name).sort()).toEqual(entries.map((e) => e.name).sort());
    for (const original of entries) {
      const found = back.find((e) => e.name === original.name);
      expect(found, original.name).toBeDefined();
      expect(Array.from(found!.bytes), original.name).toEqual(Array.from(original.bytes));
    }
  });

  /**
   * The one property the gateway actually enforces: it recomputes the integrity root over
   * events.jsonl and refuses the push if it does not match the manifest. So the bytes on disk must
   * survive the round trip EXACTLY — no re-serialising, no newline normalising, no re-ordering of
   * JSON keys. A zip that merely produces equivalent JSON would pass the test above if it were
   * written loosely, and be rejected by the server.
   */
  it('preserves bytes that a re-serialiser would change', async () => {
    const awkward = new TextEncoder().encode('{"b":1,"a":2}\r\n{"z":[ 1,2 ]}\n\n');
    const back = await readArchive(
      await writeArchive([{ name: 'r/events.jsonl', bytes: awkward }]),
    );
    expect(Array.from(back[0]!.bytes)).toEqual(Array.from(awkward));
  });

  it('handles an empty entry and a large one', async () => {
    const big = new Uint8Array(300_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
    const back = await readArchive(
      await writeArchive([
        { name: 'r/empty', bytes: new Uint8Array(0) },
        { name: 'r/big', bytes: big },
      ]),
    );
    expect(back.find((e) => e.name === 'r/empty')!.bytes.length).toBe(0);
    expect(Array.from(back.find((e) => e.name === 'r/big')!.bytes)).toEqual(Array.from(big));
  });

  it('refuses an archive whose central directory is not where the trailer says', async () => {
    const good = await writeArchive(entries);
    const corrupt = new Uint8Array(good);
    // Rewrite the central-directory offset in the end-of-central-directory record.
    const eocd = corrupt.length - 22;
    new DataView(corrupt.buffer, corrupt.byteOffset).setUint32(eocd + 16, 0xfffffff0, true);
    await expect(readArchive(corrupt)).rejects.toThrow(/central directory/i);
  });

  /**
   * A zip's recorded offsets are relative to the start of the ARCHIVE, which need not be the start
   * of the file — anything prepended shifts them all by a constant. Recovering that constant from
   * the trailer is what makes such a file readable.
   *
   * This test exists because the first version of it did not: a probe that hard-coded the base to
   * zero passed the whole suite, so the arithmetic was carrying no weight. Untested cleverness is
   * worse than none, because it reads as deliberate.
   */
  it('reads an archive with bytes prepended to it', async () => {
    const zip = await writeArchive(entries);
    const prefixed = new Uint8Array(64 + zip.length);
    prefixed.fill(0x5a, 0, 64);
    prefixed.set(zip, 64);
    const back = await readArchive(prefixed);
    expect(back.map((e) => e.name).sort()).toEqual(entries.map((e) => e.name).sort());
    const manifest = back.find((e) => e.name === 'run-1/manifest.json')!;
    expect(new TextDecoder().decode(manifest.bytes)).toBe('{"run_id":"run-1"}\n');
  });

  it('refuses bytes that are not a zip at all', async () => {
    await expect(readArchive(new TextEncoder().encode('not a zip'))).rejects.toThrow(/zip/i);
  });

  /**
   * A trace archive names blobs by digest under blobs/<ab>/<sha>, so an entry name containing `..`
   * or an absolute path is either a bug or an attack. `orca pull` writes what it reads to disk, so
   * the check belongs here, at the point the name is parsed, rather than in the caller.
   */
  it('refuses entry names that would escape the run directory', async () => {
    for (const name of ['../escape', '/abs/path', 'run/../../escape', 'a\\..\\b']) {
      const zip = await writeArchive([{ name, bytes: new Uint8Array([1]) }]);
      await expect(readArchive(zip), name).rejects.toThrow(/unsafe|name/i);
    }
  });

  /**
   * THE WRITER REFUSES WHAT ITS OWN FIELDS CANNOT HOLD.
   *
   * The EOCD carries the entry count in 16 bits, and writeArchive wrote
   * `entries.length` into it unchecked. The failure is graded and the middle
   * band is the dangerous one:
   *
   *   65535  -> the count IS the zip64 sentinel; readArchive refuses the file
   *   65536  -> wraps to 0; readArchive returns no entries
   *   70000  -> wraps to 4464; readArchive returns 4464 entries AND SUCCEEDS
   *
   * A run directory holds one file per unique content-addressed blob, so a
   * long session with heavy tool output reaches these counts on its own. In
   * that third band `orca push` sends a structurally corrupt archive and
   * `orca pull` installs a fraction of the run reporting success — silent
   * partial data loss, which is the one outcome this file's stated invariant
   * ("entry bytes round-trip EXACTLY") rules out.
   *
   * Refusing is the fix, not zip64: the reader refuses zip64 too, so writing
   * it would produce archives this CLI cannot read back.
   */
  it('refuses to write more entries than the trailer can count', async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `run-1/blobs/aa/${i}`,
        bytes: new Uint8Array(0),
      }));
    // The sentinel itself, which the reader treats as zip64.
    await expect(writeArchive(many(0xffff))).rejects.toThrow(/too many entries|65534/i);
    // And the band that wraps to a plausible number and reads back short.
    await expect(writeArchive(many(0x10000))).rejects.toThrow(/too many entries|65534/i);
    // One below the sentinel is the largest archive the format can express,
    // and must still be written — a bound that refuses valid input is a
    // different bug in the same place.
    const ok = await writeArchive(many(0xfffe));
    const back = await readArchive(ok);
    expect(back.length).toBe(0xfffe);
  });
});
