import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { BlobRef, Manifest, TraceEvent } from '@orcareplay/schema';
import { EVENT_TYPES, assertManifest, isBlobRef, validateEvent } from '@orcareplay/schema';
import { BlobStore, sha256File } from './blobs.js';

/** A line the reader could not use. Reported, never repaired (spec §6). */
export interface ReadProblem {
  /** 1-based line number in events.jsonl; 0 for a problem with the file itself. */
  line: number;
  reason: string;
}

export interface IntegrityResult {
  /** True only for a sealed run whose events file still hashes to the digest it was sealed with. */
  ok: boolean;
  /**
   * Why `ok` is what it is. `unsealed` is not `mismatch`, and collapsing the two is how a run whose
   * recorder was killed gets reported as tampered: nothing changed under it, there was simply never
   * a digest to check it against. Callers that only care whether the bytes are trustworthy read
   * `ok`; callers that tell a person what happened have to tell those two apart.
   */
  state: 'verified' | 'unsealed' | 'mismatch';
  /** Absent when the run was never sealed, so there is nothing to check against. */
  expected?: string;
  actual?: string;
}

const KNOWN_TYPES = new Set<string>(EVENT_TYPES);

/**
 * Reader for one recorded run.
 *
 * Two tolerances are mandated by spec §2 and both are deliberate: a run that crashed mid-write
 * leaves a partial final line, and a trace written by a newer Orca may carry event types this
 * build has never heard of. Neither may take down the whole trace — but neither is hidden either,
 * so anything skipped shows up in {@link problems}.
 */
export class TraceReader {
  readonly #runDir: string;
  readonly #eventsPath: string;
  readonly #manifest: Manifest;
  readonly #blobs: BlobStore;
  #problems: ReadProblem[] = [];

  private constructor(runDir: string, manifest: Manifest) {
    this.#runDir = runDir;
    this.#eventsPath = join(runDir, 'events.jsonl');
    this.#manifest = manifest;
    this.#blobs = new BlobStore(join(runDir, 'blobs'));
  }

  static async open(runDir: string): Promise<TraceReader> {
    const path = join(runDir, 'manifest.json');
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      throw new Error(`not an orca run: cannot read ${path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`invalid manifest: ${path} is not JSON`);
    }
    assertManifest(parsed);
    return new TraceReader(runDir, parsed);
  }

  get runDir(): string {
    return this.#runDir;
  }

  manifest(): Manifest {
    return this.#manifest;
  }

  /** Lines skipped by the most recent read pass. */
  problems(): ReadProblem[] {
    return [...this.#problems];
  }

  async events(): Promise<TraceEvent[]> {
    const out: TraceEvent[] = [];
    for await (const e of this.stream()) out.push(e);
    return out;
  }

  async *stream(): AsyncIterableIterator<TraceEvent> {
    this.#problems = [];
    if (!(await stat(this.#eventsPath).catch(() => null))) {
      this.#problems.push({ line: 0, reason: `${this.#eventsPath} is missing` });
      return;
    }
    const rl = createInterface({
      input: createReadStream(this.#eventsPath),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    // One line is held back so the last one can be told apart from the rest: only the last may
    // legitimately be half-written.
    let held: { line: number; text: string } | undefined;
    let n = 0;
    try {
      for await (const raw of rl) {
        n += 1;
        if (raw.trim().length === 0) continue;
        if (held) {
          const e = this.#parse(held, false);
          if (e) yield e;
        }
        held = { line: n, text: raw };
      }
      if (held) {
        const e = this.#parse(held, true);
        if (e) yield e;
      }
    } finally {
      rl.close();
    }
  }

  async blob(ref: BlobRef | string): Promise<Uint8Array> {
    return this.#blobs.get(ref);
  }

  /** The event's payload, reading it back from its blob when it was spilled (spec §2.2). */
  async resolvePayload(event: TraceEvent): Promise<unknown> {
    const payload = event.payload;
    if (!isBlobRef(payload)) return payload;
    const text = new TextDecoder().decode(await this.blob(payload));
    if (payload.media_type !== undefined && !payload.media_type.includes('json')) return text;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`blob ${payload.$blob} is not JSON; read it with blob() instead`);
    }
  }

  async verifyIntegrity(): Promise<IntegrityResult> {
    const expected = this.#manifest.integrity?.events_sha256;
    const actual = await sha256File(this.#eventsPath);
    if (expected === undefined) return { ok: false, state: 'unsealed', actual };
    return expected === actual
      ? { ok: true, state: 'verified', expected, actual }
      : { ok: false, state: 'mismatch', expected, actual };
  }

  #parse(held: { line: number; text: string }, isLast: boolean): TraceEvent | undefined {
    let value: unknown;
    try {
      value = JSON.parse(held.text);
    } catch {
      const reason = isLast ? 'truncated final line' : 'malformed JSON';
      this.#problems.push({ line: held.line, reason });
      return undefined;
    }
    const type = (value as { type?: unknown }).type;
    if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) {
      this.#problems.push({
        line: held.line,
        reason: `unknown event type ${JSON.stringify(type)}`,
      });
      return undefined;
    }
    const result = validateEvent(value);
    if (!result.valid) {
      this.#problems.push({ line: held.line, reason: result.errors.join('; ') });
      return undefined;
    }
    return value as TraceEvent;
  }
}
