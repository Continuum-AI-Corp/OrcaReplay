/**
 * Runtime constants mirroring the normative JSON Schema in `schema/`.
 *
 * The TypeScript types in `types.ts` are derived from these arrays, and
 * `test/schema-parity.test.ts` proves the arrays equal the schema enums. That gives the
 * same drift protection as codegen without a build step that can silently break.
 */

export const SCHEMA_VERSION = '0.1.0';

export const EVENT_TYPES = [
  'run.start',
  'run.end',
  'model.request',
  'model.response',
  'tool.call',
  'tool.result',
  'mcp.request',
  'mcp.response',
  'shell.exec',
  'shell.result',
  'fs.snapshot',
  'fs.change',
  'net.request',
  'net.response',
  'error',
  'divergence',
  'checkpoint',
  'fork',
  'route.decision',
  'note',
] as const;

export const ACTORS = ['agent', 'harness', 'model', 'orca', 'gateway', 'tool', 'user'] as const;

export const DIVERGENCE_LEVELS = ['minor', 'major'] as const;

/** Match rungs from spec §4. Rung 1 is an exact canonical-hash match. */
export const MATCH_RUNGS = [1, 2, 3, 4] as const;

/** Payloads larger than this (serialized bytes) MUST spill to a blob. Spec §2.2. */
export const INLINE_PAYLOAD_LIMIT = 4096;

export const RUN_ID_PATTERN = /^run_[0-9a-f]{6,32}$/;
export const BLOB_REF_PATTERN = /^sha256:[0-9a-f]{64}$/;
