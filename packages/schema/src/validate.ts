import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Manifest, TraceEvent } from './types.js';

const require = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-var-requires */
const eventSchema = require('../schema/event.schema.json') as Record<string, unknown>;
const manifestSchema = require('../schema/manifest.schema.json') as Record<string, unknown>;

export { eventSchema, manifestSchema };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv as never);

const validateEventFn = ajv.compile(eventSchema);
const validateManifestFn = ajv.compile(manifestSchema);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function toResult(ok: boolean, errors: unknown): ValidationResult {
  if (ok) return { valid: true, errors: [] };
  const list = (errors as { instancePath?: string; message?: string }[] | null) ?? [];
  return {
    valid: false,
    errors: list.map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`.trim()),
  };
}

export function validateEvent(value: unknown): ValidationResult {
  return toResult(validateEventFn(value) as boolean, validateEventFn.errors);
}

export function validateManifest(value: unknown): ValidationResult {
  return toResult(validateManifestFn(value) as boolean, validateManifestFn.errors);
}

export function assertEvent(value: unknown): asserts value is TraceEvent {
  const r = validateEvent(value);
  if (!r.valid) throw new Error(`invalid trace event: ${r.errors.join('; ')}`);
}

export function assertManifest(value: unknown): asserts value is Manifest {
  const r = validateManifest(value);
  if (!r.valid) throw new Error(`invalid manifest: ${r.errors.join('; ')}`);
}
