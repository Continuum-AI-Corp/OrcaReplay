import { describe, expect, it } from 'vitest';
import { betasForModelChange } from '../src/server.js';

/**
 * `anthropic-beta` is a header, so substituting a model in the request body leaves it behind. A
 * fork of a run made on a 1M-context model onto one without that entitlement came back
 * `400 The long context beta is not yet available for this subscription` — a failure that names
 * the subscription rather than the flag, and so reads as an account problem rather than as orca
 * carrying over something it should have dropped.
 */
describe('betasForModelChange', () => {
  it('drops a context-window entitlement, which belongs to the recorded model', () => {
    expect(betasForModelChange('context-1m-2025-08-07')).toBeUndefined();
    expect(betasForModelChange('context-200m-2026-01-01')).toBeUndefined();
  });

  // The rest of the header is how the harness speaks its own protocol. Dropping tool shapes or
  // output formats would break the fork in a way far harder to see than a 400.
  it('keeps protocol flags, which belong to the harness', () => {
    const value = 'tools-2024-05-16,prompt-caching-2024-07-31';
    expect(betasForModelChange(value)).toBe(value);
  });

  it('keeps the protocol flags alongside an entitlement it removes', () => {
    expect(betasForModelChange('context-1m-2025-08-07,tools-2024-05-16')).toBe('tools-2024-05-16');
    expect(betasForModelChange('tools-2024-05-16, context-1m-2025-08-07')).toBe('tools-2024-05-16');
  });

  it('is undefined rather than empty, so the header is removed and not sent blank', () => {
    expect(betasForModelChange('')).toBeUndefined();
    expect(betasForModelChange(' , ')).toBeUndefined();
  });

  // Substring, not prefix: a flag that merely mentions context is not an entitlement.
  it('does not drop a flag that only looks like one', () => {
    const value = 'extended-context-cache-2026-01-01';
    expect(betasForModelChange(value)).toBe(value);
  });
});
