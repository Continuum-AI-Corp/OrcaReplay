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
  /**
   * Fork provenance (spec §1). Set on a run produced by forking another. The manifest is what
   * every out-of-process reader sees first — `orca gc` deciding whether a run may be deleted, a
   * third-party tool, the Python SDK — so recording this only as an event leaves those readers
   * looking at an orphan.
   */
  parentRun?: string;
  forkPoint?: number;
  forkModel?: string;
}

/** The parts of an event a caller supplies; the writer stamps the rest. */
export interface EventInit {
  type: EventType;
  actor: Actor;
  turn?: number;
  causes?: number[];
  attrs?: Record<string, unknown>;
  payload?: Payload;
  /**
   * When the event actually happened, for anything captured out of band.
   *
   * Shell and MCP frames are drained from disk after the agent exits, so stamping them at write
   * time puts every one of them at the end of the run — `ts` and `mono_us` describing the drain
   * rather than the event, which spec §2.1 makes authoritative for duration. Supplying the real
   * moment is what lets them interleave with the model turns they happened between.
   */
  occurredAt?: Date;
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
  readonly #startedAtMs = Date.now();
  #seq = 0;
  #turn = 0;
  #git: Manifest['git'];
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
      // Spread conditionally: the schema forbids unknown keys and a plain recording must carry no
      // provenance at all, rather than three nulls that readers would have to special-case.
      ...(init.parentRun === undefined ? {} : { parent_run: init.parentRun }),
      ...(init.forkPoint === undefined ? {} : { fork_point: init.forkPoint }),
      ...(init.forkModel === undefined ? {} : { fork_model: init.forkModel }),
    };
    assertManifest(base);
    await writeFile(join(runDir, 'manifest.json'), `${JSON.stringify(base, null, 2)}\n`, {
      mode: FILE_MODE,
    });

    const handle = await open(join(runDir, 'events.jsonl'), 'a', FILE_MODE);
    return new TraceWriter(runId, runDir, base, redactor, handle);
  }

  /**
   * Record the repository state the run started from (spec §1).
   *
   * A setter rather than a constructor argument because the honest answer needs the run directory
   * to exist: the dirty check has to exclude orca's own files, or every run in a clean checkout
   * reports dirty. So the caller reads it once the capture layer is up and hands it back, and it
   * lands in the manifest at close alongside the counts.
   */
  setGit(info: Manifest['git']): void {
    this.#git = info;
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
    const when = init.occurredAt ?? new Date();
    const ts = when.toISOString();
    // Monotonic for events stamped now; derived from the wall clock for one that happened earlier,
    // since there is no hrtime reading to recover. Clamped at zero rather than going negative for a
    // frame whose clock ran slightly behind the run's start.
    const mono_us = init.occurredAt
      ? Math.max(0, (when.getTime() - this.#startedAtMs) * 1000)
      : Number((process.hrtime.bigint() - this.#started) / 1000n);
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
      // Conditional for the same reason the fork keys are: the schema forbids unknown keys, and a
      // run outside a repository should carry no git block rather than three empty fields.
      ...(this.#git === undefined || Object.keys(this.#git).length === 0 ? {} : { git: this.#git }),
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
