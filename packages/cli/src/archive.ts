import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * The zip subset a trace archive needs, written by hand.
 *
 * The CLI takes no new runtime dependencies (CONTRIBUTING, "Rules of the road"), and a debugger
 * people install to diagnose a broken environment is the worst possible place to drag one in. zlib
 * is a node builtin, and what remains — a local header, a central directory and a trailer — is
 * about a hundred lines. `archive.test.ts` is what makes that defensible rather than merely brief.
 *
 * ONE PROPERTY GOVERNS EVERYTHING HERE: entry bytes round-trip EXACTLY. The gateway recomputes the
 * integrity root over `events.jsonl` and refuses a push whose root does not match the manifest, so
 * an archiver that re-serialised JSON, normalised a newline or reordered keys would produce a file
 * that looks equivalent and is rejected on arrival. Nothing in this file parses an entry's content.
 */
export interface ArchiveEntry {
  /** Path inside the archive, `<run_id>/manifest.json` and friends. */
  name: string;
  bytes: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD_LEN = 22;
/** Zip64 puts this in a 32-bit field it cannot hold, and the real value in an extra record. */
const ZIP32_SENTINEL = 0xffffffff;

/**
 * CRC-32 (IEEE), computed here rather than taken from `zlib.crc32`.
 *
 * That builtin landed in node 20.15, and the published CLI supports node 20.0 — so using it would
 * break the floor `package.json` advertises, on a patch release nobody would think to test.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Reject a name that would write outside the run directory when `orca pull` unpacks it.
 *
 * Checked where the name is PARSED rather than where it is used: pull is not the only future
 * caller, and a check in the caller is one a later caller forgets. A trace names its entries
 * `<run_id>/manifest.json` and `<run_id>/blobs/<ab>/<sha>`, so anything absolute, anything with a
 * `..` segment and anything carrying a backslash is either a bug upstream or an attack.
 */
function assertSafeName(name: string): void {
  if (name === '' || name.length > 512) throw new Error(`unsafe archive entry name: ${name}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\')) {
    throw new Error(`unsafe archive entry name: ${name}`);
  }
  if (name.split('/').some((seg) => seg === '..')) {
    throw new Error(`unsafe archive entry name: ${name}`);
  }
}

/** Serialise entries as a zip. Deflated, unless deflating made the entry bigger. */
export async function writeArchive(entries: ArchiveEntry[]): Promise<Uint8Array> {
  /**
   * REFUSE WHAT THE FORMAT CANNOT EXPRESS, RATHER THAN TRUNCATING IT.
   *
   * The trailer counts entries in 16 bits and records sizes and offsets in 32.
   * Writing a larger value silently keeps its low bits, and the damage is
   * graded — worst in the middle:
   *
   *   65535 entries  -> the count IS the zip64 sentinel, and readArchive
   *                     refuses the file outright
   *   65536          -> wraps to 0, and readArchive returns nothing
   *   70000          -> wraps to 4464, and readArchive SUCCEEDS with 4464 of
   *                     them
   *
   * That last band is the one that matters: `orca push` sends a structurally
   * corrupt archive, and `orca pull` installs a fraction of the run and
   * reports success. Silent partial loss is exactly what this file's governing
   * property — entry bytes round-trip EXACTLY — exists to rule out, and a run
   * directory holds one file per unique content-addressed blob, so a long
   * session with heavy tool output reaches these counts without trying.
   *
   * Refusing rather than emitting zip64: readArchive refuses zip64 too, so
   * writing it would produce archives this CLI cannot read back — trading a
   * silent truncation for a confident file nothing here can open. A bound that
   * says so is the honest answer until both halves learn the format.
   */
  const MAX_ENTRIES = 0xfffe; // 0xffff is the reader's zip64 sentinel
  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `archive has too many entries: ${entries.length}, and a zip trailer counts at most ${MAX_ENTRIES}`,
    );
  }

  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.bytes);
    const deflated = entry.bytes.length === 0 ? new Uint8Array(0) : deflateRawSync(entry.bytes);
    // An already-compressed blob (an image, a zip) inflates under deflate. Storing it then costs
    // less than compressing it, and the reader handles both.
    const stored = entry.bytes.length === 0 || deflated.length >= entry.bytes.length;
    const payload = stored ? entry.bytes : deflated;
    const method = stored ? 0 : 8;

    // The same refusal for the 32-bit size and offset fields. Each is checked
    // where it is about to be written rather than once at the end, so the
    // message names the entry that overflows instead of the total.
    if (payload.length >= ZIP32_SENTINEL || entry.bytes.length >= ZIP32_SENTINEL) {
      throw new Error(`archive entry is too large for a 32-bit zip field: ${entry.name}`);
    }
    if (offset >= ZIP32_SENTINEL) {
      throw new Error(`archive is too large for a 32-bit zip offset at entry: ${entry.name}`);
    }

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, method, true);
    // A FIXED timestamp, so the same run produces the same bytes twice. A wall clock here would
    // make every push a different archive and every digest comparison meaningless.
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true); // 1980-01-01, the DOS epoch
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, entry.bytes.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const head = new Uint8Array(46 + name.length);
    const cv = new DataView(head.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, entry.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    head.set(name, 46);

    chunks.push(local, payload);
    central.push(head);
    offset += local.length + payload.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  if (centralSize >= ZIP32_SENTINEL || offset >= ZIP32_SENTINEL) {
    throw new Error('archive is too large for a 32-bit zip trailer');
  }
  const eocd = new Uint8Array(EOCD_LEN);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = [...chunks, ...central, eocd];
  const size = total.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of total) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Read a zip written by this file or by the gateway's Go writer. */
export async function readArchive(bytes: Uint8Array): Promise<ArchiveEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The trailer is last, but a zip may carry a comment after it, so scan back for the signature.
  let eocd = -1;
  for (let i = bytes.length - EOCD_LEN; i >= 0 && i >= bytes.length - EOCD_LEN - 0xffff; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record');

  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || centralSize === ZIP32_SENTINEL || centralOffset === ZIP32_SENTINEL) {
    throw new Error('zip64 archives are not supported');
  }

  /**
   * WHERE THE ENTRIES REALLY START.
   *
   * `centralOffset` is relative to the start of the archive, which is not necessarily the start of
   * the FILE: a zip appended to something else (a self-extracting stub, a concatenated download)
   * shifts every recorded offset by a constant. Recovering that constant from the trailer — whose
   * own position is known — is what makes such an archive readable, and it is zero for an ordinary
   * one, so the arithmetic costs nothing in the common case.
   */
  const base = eocd - centralSize - centralOffset;
  if (base < 0) throw new Error('malformed zip: central directory does not fit before its trailer');

  const out: ArchiveEntry[] = [];
  let at = base + centralOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_SIG) {
      throw new Error('malformed zip: central directory entry is not where the trailer says');
    }
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    if (compressed === ZIP32_SENTINEL || uncompressed === ZIP32_SENTINEL) {
      throw new Error('zip64 archives are not supported');
    }
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    assertSafeName(name);

    // The local header repeats the name and extra fields, and its lengths are the authority on
    // where the data begins — a central-directory extra length does not have to match it.
    const local = base + localOffset;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL_SIG) {
      throw new Error(`malformed zip: no local header for ${name}`);
    }
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localName + localExtra;
    if (start + compressed > bytes.length) {
      throw new Error(`malformed zip: ${name} runs past the end of the archive`);
    }
    const payload = bytes.subarray(start, start + compressed);
    const data = method === 0 ? new Uint8Array(payload) : new Uint8Array(inflateRawSync(payload));
    if (data.length !== uncompressed) {
      throw new Error(`malformed zip: ${name} is ${data.length} bytes, expected ${uncompressed}`);
    }
    if (crc32(data) !== view.getUint32(at + 16, true)) {
      throw new Error(`malformed zip: ${name} failed its checksum`);
    }
    out.push({ name, bytes: data });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
