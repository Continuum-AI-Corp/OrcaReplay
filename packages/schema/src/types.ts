import type { ACTORS, DIVERGENCE_LEVELS, EVENT_TYPES } from './constants.js';

export type EventType = (typeof EVENT_TYPES)[number];
export type Actor = (typeof ACTORS)[number];
export type DivergenceLevel = (typeof DIVERGENCE_LEVELS)[number];

/** A reference to a content-addressed payload. Spec §2.2. */
export interface BlobRef {
  $blob: string;
  bytes: number;
  media_type?: string;
}

export type Payload = BlobRef | Record<string, unknown> | unknown[] | string | number | boolean;

/** One line of events.jsonl. Spec §2.1. */
export interface TraceEvent {
  seq: number;
  ts: string;
  mono_us: number;
  turn: number;
  type: EventType;
  actor: Actor;
  causes?: number[];
  attrs?: Record<string, unknown>;
  payload?: Payload;
  redacted?: string[];
}

export interface AdapterInfo {
  id: string;
  version?: string;
  harness_version?: string;
}

export interface GitInfo {
  head?: string;
  branch?: string;
  dirty?: boolean;
}

export interface Manifest {
  schema_version: string;
  run_id: string;
  created_at: string;
  ended_at?: string;
  orca_version: string;
  adapter: AdapterInfo;
  argv: string[];
  cwd: string;
  env_allowlisted?: Record<string, string>;
  git?: GitInfo;
  platform?: { os: string; arch: string; node: string };
  counts?: { events: number; blobs: number };
  redaction?: { policy_version: number; rules_fired?: Record<string, number> };
  /** Set on forked runs. */
  parent_run?: string;
  fork_point?: number;
  fork_model?: string;
  exit_code?: number;
  integrity?: { events_sha256: string; blob_count: number };
}

export interface RedactionRecord {
  rule: string;
  identifier: string;
  placeholder: string;
  count: number;
}

export interface RedactionsFile {
  policy_version: number;
  records: RedactionRecord[];
}

export function isBlobRef(value: unknown): value is BlobRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BlobRef).$blob === 'string' &&
    typeof (value as BlobRef).bytes === 'number'
  );
}
