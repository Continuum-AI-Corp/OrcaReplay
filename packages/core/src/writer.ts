import { randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import type {
  Actor,
  AdapterInfo,
  EventType,
  Manifest,
  Payload,
  TraceEvent,
} from '@orcareplay/schema';
import {
  INLINE_PAYLOAD_LIMIT,
  RUN_ID_PATTERN,
  SCHEMA_VERSION,
  assertEvent,
  assertManifest,
} from '@orcareplay/schema';
import { BlobStore, sha256File } from './blobs.js';
import { REDACTION_POLICY_VERSION, Redactor } from './redaction.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface TraceWriterInit {
  /** Defaults to a fresh `run_<12 hex>`. */
  runId?: string;
  adapter: AdapterInfo;
  argv: string[];
  cwd: string;
  orcaVersion: string;
  envAllowlist?: string[];
}

/** The parts of an event a caller supplies; the writer stamps the rest. */
export interface EventInit {
  type: EventType;
  actor: Actor;
  turn?: number;
  causes?: number[];
  attrs?: Record<string, unknown>;
  payload?: Payload;
}

/**
 * Append-only writer for one run (spec §2).
 *
 * Every event takes the same path to disk — spill, redact, validate, append — because a redactor
 * that can be bypassed by one caller is not a redactor. Serialized bytes are scrubbed rather than
 * individual fields, so a secret hiding in a key, a nested string, or an attrs value is caught
 * regardless of shape.
 */
export class TraceWriter {
  readonly #runDir: string;
  readonly #runId: string;
  readonly #eventsPath: string;
  readonly #blobs: BlobStore;
  readonly #redactor: Redactor;
  readonly #handle: FileHandle;
  readonly #base: Manifest;
  readonly #started = process.hrtime.bigint();
  #seq = 0;
  #turn = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #sealed: Manifest | undefined;

  private constructor(
    runId: string,
    runDir: string,
    base: Manifest,
    redactor: Redactor,
    handle: FileHandle,
  ) {
    this.#runId = runId;
    this.#runDir = runDir;
    this.#eventsPath = join(runDir, 'events.jsonl');
    this.#blobs = new BlobStore(join(runDir, 'blobs'));
    this.#redactor = redactor;
    this.#handle = handle;
    this.#base = base;
  }

  static async create(runsDir: string, init: TraceWriterInit): Promise<TraceWriter> {
    const runId = init.runId ?? `run_${randomBytes(6).toString('hex')}`;
    if (!RUN_ID_PATTERN.test(runId))
      throw new Error(`not a valid run id: ${JSON.stringify(runId)}`);
    const runDir = join(runsDir, runId);
    await mkdir(runDir, { recursive: true, mode: DIR_MODE });

    // One redactor for the whole run: the salt stays constant, so a secret seen in the environment
    // and again in a payload gets the same placeholder, and every removal lands in redactions.json.
    const redactor = new Redactor(
      init.envAllowlist === undefined ? {} : { envAllowlist: init.envAllowlist },
    );
    const base: Manifest = {
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      created_at: new Date().toISOString(),
      orca_version: init.orcaVersion,
      adapter: init.adapter,
      argv: init.argv,
      cwd: init.cwd,
      env_allowlisted: redactor.redactEnv(process.env),
      platform: { os: platform(), arch: arch(), node: process.version },
    };
    assertManifest(base);
    await writeFile(join(runDir, 'manifest.json'), `${JSON.stringify(base, null, 2)}\n`, {
      mode: FILE_MODE,
    });

    const handle = await open(join(runDir, 'events.jsonl'), 'a', FILE_MODE);
    return new TraceWriter(runId, runDir, base, redactor, handle);
  }

  get runDir(): string {
    return this.#runDir;
  }

  get runId(): string {
    return this.#runId;
  }

  /** The seq the next event will be given, which is also the number written so far. */
  get seq(): number {
    return this.#seq;
  }

  async append(init: EventInit): Promise<TraceEvent> {
    if (this.#sealed) throw new Error(`run ${this.#runId} is closed`);
    // Clocks are read at call time so they describe the event, not the queue drain; seq is
    // assigned inside the queue so a rejected event leaves no hole in the dense order.
    const ts = new Date().toISOString();
    const mono_us = Number((process.hrtime.bigint() - this.#started) / 1000n);
    const turn = init.turn ?? this.#turn;
    this.#turn = turn;
    const written = this.#tail.then(() => this.#write(ts, mono_us, turn, init));
    this.#tail = written.catch(() => undefined);
    return written;
  }

  async close(exitCode?: number): Promise<Manifest> {
    if (this.#sealed) return this.#sealed;
    await this.#tail;
    await this.#handle.sync();
    await this.#handle.close();

    const blobs = await this.#blobs.count();
    const manifest: Manifest = {
      ...this.#base,
      ended_at: new Date().toISOString(),
      counts: { events: this.#seq, blobs },
      redaction: {
        policy_version: REDACTION_POLICY_VERSION,
        rules_fired: this.#redactor.rulesFired(),
      },
      integrity: { events_sha256: await sha256File(this.#eventsPath), blob_count: blobs },
    };
    if (exitCode !== undefined) manifest.exit_code = exitCode;
    assertManifest(manifest);

    const redactions = {
      policy_version: REDACTION_POLICY_VERSION,
      records: this.#redactor.records(),
    };
    await writeFile(
      join(this.#runDir, 'redactions.json'),
      `${JSON.stringify(redactions, null, 2)}\n`,
      {
        mode: FILE_MODE,
      },
    );
    await writeFile(join(this.#runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: FILE_MODE,
    });
    this.#sealed = manifest;
    return manifest;
  }

  async #write(ts: string, mono_us: number, turn: number, init: EventInit): Promise<TraceEvent> {
    const seq = this.#seq;
    const removed: string[] = [];
    let payload = init.payload;
    if (payload !== undefined) {
      const json = JSON.stringify(payload);
      if (Buffer.byteLength(json) > INLINE_PAYLOAD_LIMIT) {
        const scrubbed = this.#redactor.redactString(json, `event:${seq}:payload`);
        removed.push(...scrubbed.hits.map((h) => h.identifier));
        payload = await this.#blobs.put(scrubbed.value, 'application/json');
      }
    }

    const event: TraceEvent = { seq, ts, mono_us, turn, type: init.type, actor: init.actor };
    if (init.causes !== undefined) event.causes = init.causes;
    if (init.attrs !== undefined) event.attrs = init.attrs;
    if (payload !== undefined) event.payload = payload;

    // Placeholders contain no quote or backslash, so scrubbing the serialized line cannot make it
    // unparseable — and if it ever did, the parse throws and the event is never written.
    const scrubbed = this.#redactor.redactString(JSON.stringify(event), `event:${seq}`);
    removed.push(...scrubbed.hits.map((h) => h.identifier));
    const out = JSON.parse(scrubbed.value) as TraceEvent;
    if (removed.length > 0) out.redacted = [...new Set(removed)];

    assertEvent(out);
    await this.#handle.write(`${JSON.stringify(out)}\n`);
    this.#seq = seq + 1;
    return out;
  }
}
