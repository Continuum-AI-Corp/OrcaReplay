/**
 * Runtime constants mirroring the normative JSON Schema in `schema/`.
 *
 * The TypeScript types in `types.ts` are derived from these arrays, and
 * `test/schema-parity.test.ts` proves the arrays equal the schema enums. That gives the
 * same drift protection as codegen without a build step that can silently break.
 */

export const SCHEMA_VERSION = '0.2.0';

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
  'agent.start',
  'agent.handoff',
  'agent.guardrail',
  'route.decision',
  'session.snapshot',
  'note',
] as const;

export const ACTORS = ['agent', 'harness', 'model', 'orca', 'gateway', 'tool', 'user'] as const;

export const DIVERGENCE_LEVELS = ['minor', 'major'] as const;

/** Match rungs from spec §4. Rung 1 is an exact canonical-hash match. */
export const MATCH_RUNGS = [1, 2, 3, 4] as const;

/** Payloads larger than this (serialized bytes) MUST spill to a blob. Spec §2.2. */
export const INLINE_PAYLOAD_LIMIT = 4096;

/**
 * The instants a `date-time` `ts` can write down: `0000-01-01T00:00:00.000Z` and
 * `9999-12-31T23:59:59.999Z`.
 *
 * `Date.parse` accepts far more than this — `+275760-09-13T00:00:00Z` parses, and
 * `toISOString` writes it back with a six-digit year, which the format rejects. Every reader that
 * hands the drain an instant off a file another process wrote has to bound it, because the throw
 * lands inside `TraceWriter.append`, where the trace is being sealed. Three of them do; this is
 * the copy they share, since what the bound describes is this schema rather than any one of them.
 */
export const EARLIEST_TS_MS = -62_167_219_200_000;
export const LATEST_TS_MS = 253_402_300_799_999;

export const RUN_ID_PATTERN = /^run_[0-9a-f]{6,32}$/;
export const BLOB_REF_PATTERN = /^sha256:[0-9a-f]{64}$/;
