import { describe, expect, it } from 'vitest';
import {
  ACTORS,
  EVENT_TYPES,
  INLINE_PAYLOAD_LIMIT,
  SCHEMA_VERSION,
  eventSchema,
  manifestSchema,
  validateEvent,
  validateManifest,
} from '../src/index.js';

/**
 * The JSON Schema is normative (spec §1). These tests prove the runtime constants that the
 * TypeScript types are derived from cannot drift away from it.
 */
describe('schema parity', () => {
  it('EVENT_TYPES exactly matches the schema enum', () => {
    const props = (eventSchema as any).properties.type.enum as string[];
    expect([...EVENT_TYPES].sort()).toEqual([...props].sort());
  });

  it('ACTORS exactly matches the schema enum', () => {
    const props = (eventSchema as any).properties.actor.enum as string[];
    expect([...ACTORS].sort()).toEqual([...props].sort());
  });

  it('declares a schema version and an inline payload limit', () => {
    expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(INLINE_PAYLOAD_LIMIT).toBe(4096);
  });

  it('exposes both schemas with stable $ids', () => {
    expect((eventSchema as any).$id).toContain('event.schema.json');
    expect((manifestSchema as any).$id).toContain('manifest.schema.json');
  });
});

describe('validateEvent', () => {
  const base = { seq: 0, ts: '2026-08-29T10:00:00.000Z', mono_us: 0, turn: 0, actor: 'orca' };

  it('accepts a minimal well-formed event', () => {
    expect(validateEvent({ ...base, type: 'run.start' })).toEqual({ valid: true, errors: [] });
  });

  it('accepts every declared event type', () => {
    for (const type of EVENT_TYPES) {
      const r = validateEvent({ ...base, type });
      expect(r.valid, `${type}: ${r.errors.join(',')}`).toBe(true);
    }
  });

  it('accepts a blob-ref payload', () => {
    const r = validateEvent({
      ...base,
      type: 'shell.result',
      actor: 'harness',
      payload: { $blob: `sha256:${'9'.repeat(64)}`, bytes: 12, media_type: 'text/plain' },
    });
    expect(r.valid, r.errors.join(',')).toBe(true);
  });

  it('rejects a malformed blob digest', () => {
    const r = validateEvent({ ...base, type: 'note', payload: { $blob: 'sha256:zz', bytes: 1 } });
    expect(r.valid).toBe(false);
  });

  it('rejects an unknown event type', () => {
    expect(validateEvent({ ...base, type: 'model.telepathy' }).valid).toBe(false);
  });

  it('rejects a negative sequence number', () => {
    expect(validateEvent({ ...base, seq: -1, type: 'note' }).valid).toBe(false);
  });

  it('rejects unknown envelope fields, so drift is caught early', () => {
    expect(validateEvent({ ...base, type: 'note', vendorExtra: 1 }).valid).toBe(false);
  });
});

describe('validateManifest', () => {
  const manifest = {
    schema_version: '0.1.0',
    run_id: 'run_9f2c14',
    created_at: '2026-08-29T10:00:00.000Z',
    orca_version: '0.1.0',
    adapter: { id: 'claude-code' },
    argv: ['claude'],
    cwd: '/w',
  };

  it('accepts a minimal manifest', () => {
    expect(validateManifest(manifest)).toEqual({ valid: true, errors: [] });
  });

  it('accepts fork provenance', () => {
    const r = validateManifest({ ...manifest, parent_run: 'run_abc123', fork_point: 17 });
    expect(r.valid, r.errors.join(',')).toBe(true);
  });

  it('rejects a run id that does not match the spec pattern', () => {
    expect(validateManifest({ ...manifest, run_id: 'RUN-9F' }).valid).toBe(false);
  });

  it('reports every error, not just the first', () => {
    const r = validateManifest({ schema_version: '0.1.0' });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(1);
  });
});
