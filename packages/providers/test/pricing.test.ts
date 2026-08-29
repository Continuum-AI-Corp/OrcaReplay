import { describe, expect, it } from 'vitest';
import type { Usage } from '@orcareplay/plugin-api';
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  MODEL_PRICING,
  knownModelIds,
  modelInfoFor,
  priceFor,
  resolveModelId,
} from '../src/index.js';

const REQUIRED = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'gpt-5.2',
  'gpt-5-mini',
  'glm-5.3-flash',
  'qwen3-coder',
  'deepseek-v3',
];

describe('MODEL_PRICING', () => {
  it('covers the models OrcaReplay ships with', () => {
    for (const id of REQUIRED) expect(MODEL_PRICING[id], id).toBeDefined();
  });

  it('quotes both directions as positive numbers', () => {
    for (const [id, price] of Object.entries(MODEL_PRICING)) {
      expect(price.input_per_mtok, id).toBeGreaterThan(0);
      expect(price.output_per_mtok, id).toBeGreaterThan(0);
      expect(price.output_per_mtok, id).toBeGreaterThanOrEqual(price.input_per_mtok);
    }
  });

  it('lists its ids', () => {
    expect(knownModelIds()).toEqual(expect.arrayContaining(REQUIRED));
  });
});

describe('resolveModelId', () => {
  it('matches an exact id', () => {
    expect(resolveModelId('claude-opus-5')).toBe('claude-opus-5');
    expect(resolveModelId('gpt-5.2')).toBe('gpt-5.2');
  });

  it('is case and whitespace insensitive', () => {
    expect(resolveModelId('  Claude-Opus-5 ')).toBe('claude-opus-5');
  });

  it('strips provider prefixes', () => {
    expect(resolveModelId('anthropic/claude-opus-5')).toBe('claude-opus-5');
    expect(resolveModelId('openrouter/anthropic/claude-opus-5')).toBe('claude-opus-5');
    expect(resolveModelId('openai/gpt-5-mini')).toBe('gpt-5-mini');
    expect(resolveModelId('deepseek/deepseek-v3')).toBe('deepseek-v3');
  });

  it('strips date suffixes in every shape the vendors use', () => {
    expect(resolveModelId('claude-opus-5-20260101')).toBe('claude-opus-5');
    expect(resolveModelId('gpt-5.2-2026-01-15')).toBe('gpt-5.2');
    expect(resolveModelId('glm-5.3-flash-202601')).toBe('glm-5.3-flash');
  });

  it('strips openrouter variant and alias suffixes', () => {
    expect(resolveModelId('anthropic/claude-opus-5:beta')).toBe('claude-opus-5');
    expect(resolveModelId('qwen/qwen3-coder:free')).toBe('qwen3-coder');
    expect(resolveModelId('claude-sonnet-5-latest')).toBe('claude-sonnet-5');
  });

  it('handles bedrock style region, vendor and version decoration', () => {
    expect(resolveModelId('us.anthropic.claude-opus-5-20260101-v1:0')).toBe('claude-opus-5');
    expect(resolveModelId('eu.anthropic.claude-haiku-4-5-v1:0')).toBe('claude-haiku-4-5');
  });

  it('keeps a version-looking id that is really part of the name', () => {
    expect(resolveModelId('deepseek-v3')).toBe('deepseek-v3');
    expect(resolveModelId('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('returns null rather than guessing at a neighbour', () => {
    expect(resolveModelId('claude-opus-5-thinking')).toBeNull();
    expect(resolveModelId('gpt-5')).toBeNull();
    expect(resolveModelId('gpt-5.2-turbo-ultra')).toBeNull();
    expect(resolveModelId('llama-4-70b')).toBeNull();
    expect(resolveModelId('')).toBeNull();
    expect(resolveModelId('claude')).toBeNull();
  });

  it('does not let one family swallow another', () => {
    expect(resolveModelId('gpt-5-mini-2026-01-15')).toBe('gpt-5-mini');
    expect(resolveModelId('openai/gpt-5-mini')).not.toBe('gpt-5.2');
  });
});

describe('priceFor', () => {
  const mtok = (input: number, output: number): Usage => ({
    input_tokens: input,
    output_tokens: output,
  });

  it('computes a known cost exactly', () => {
    // claude-opus-5 is 15 in / 75 out per million tokens.
    expect(priceFor(mtok(1_000_000, 1_000_000), 'claude-opus-5')).toEqual({
      amount: 90,
      currency: 'USD',
    });
    expect(priceFor(mtok(2_000, 500), 'claude-opus-5')).toEqual({
      amount: 0.0675,
      currency: 'USD',
    });
  });

  it('prices a decorated model id the same as the bare one', () => {
    const usage = mtok(2_000, 500);
    expect(priceFor(usage, 'anthropic/claude-opus-5-20260101')).toEqual(
      priceFor(usage, 'claude-opus-5'),
    );
  });

  it('bills cache reads and writes at their tier', () => {
    const read = priceFor(
      { input_tokens: 400, output_tokens: 85, cache_read_tokens: 800 },
      'gpt-5.2',
    );
    // 400 * 1.25 + 85 * 10 + 800 * 1.25 * 0.1, all per million.
    expect(read?.amount).toBeCloseTo(0.00145, 10);
    const write = priceFor(
      { input_tokens: 0, output_tokens: 0, cache_write_tokens: 1_000_000 },
      'claude-opus-5',
    );
    expect(write?.amount).toBeCloseTo(15 * CACHE_WRITE_MULTIPLIER, 10);
    expect(CACHE_READ_MULTIPLIER).toBeLessThan(1);
    expect(CACHE_WRITE_MULTIPLIER).toBeGreaterThan(1);
  });

  it('is zero for an empty turn', () => {
    expect(priceFor(mtok(0, 0), 'claude-sonnet-5')).toEqual({ amount: 0, currency: 'USD' });
  });

  it('returns null for an unknown model instead of a wrong number', () => {
    expect(priceFor(mtok(1000, 1000), 'llama-4-70b')).toBeNull();
    expect(priceFor(mtok(1000, 1000), '')).toBeNull();
  });

  it('does not produce NaN from a malformed usage record', () => {
    const junk = { input_tokens: Number.NaN, output_tokens: undefined } as unknown as Usage;
    expect(priceFor(junk, 'claude-opus-5')).toEqual({ amount: 0, currency: 'USD' });
  });

  it('rounds away binary floating point dust', () => {
    const amount = priceFor(mtok(3, 7), 'deepseek-v3')?.amount ?? 0;
    expect(String(amount)).not.toMatch(/e-/);
    expect(String(amount).replace('0.', '').length).toBeLessThanOrEqual(10);
  });
});

describe('modelInfoFor', () => {
  it('reports the context window and both prices under the caller id', () => {
    expect(modelInfoFor('anthropic/claude-opus-5-20260101')).toEqual({
      id: 'anthropic/claude-opus-5-20260101',
      context_window: MODEL_PRICING['claude-opus-5']?.context_window,
      input_price_per_mtok: 15,
      output_price_per_mtok: 75,
    });
  });

  it('is null for an unknown model', () => {
    expect(modelInfoFor('llama-4-70b')).toBeNull();
  });
});
