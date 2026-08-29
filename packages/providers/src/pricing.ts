/**
 * Open pricing data, usable by OrcaReplay and by any gateway that wants the same numbers.
 *
 * Prices are USD per million tokens, as published by each vendor's pricing page (checked
 * 2026-08-29):
 *   Anthropic   https://www.anthropic.com/pricing
 *   OpenAI      https://openai.com/api/pricing
 *   Z.ai (GLM)  https://z.ai/pricing
 *   Alibaba     https://www.alibabacloud.com/help/en/model-studio/models
 *   DeepSeek    https://api-docs.deepseek.com/quick_start/pricing
 * They move; treat them as indicative and override them from config when the exact figure is
 * load-bearing. What must be right is the *resolution* below: a cost attached to the wrong model
 * is worse than no cost at all, so unknown ids return null rather than a nearby guess.
 */

import type { ModelInfo, Money, Usage } from '@orcareplay/plugin-api';

export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
  context_window?: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  'claude-opus-5': { input_per_mtok: 15, output_per_mtok: 75, context_window: 200_000 },
  'claude-sonnet-5': { input_per_mtok: 3, output_per_mtok: 15, context_window: 200_000 },
  'claude-haiku-4-5': { input_per_mtok: 1, output_per_mtok: 5, context_window: 200_000 },
  'gpt-5.2': { input_per_mtok: 1.25, output_per_mtok: 10, context_window: 400_000 },
  'gpt-5-mini': { input_per_mtok: 0.25, output_per_mtok: 2, context_window: 400_000 },
  'glm-5.3-flash': { input_per_mtok: 0.05, output_per_mtok: 0.15, context_window: 200_000 },
  'qwen3-coder': { input_per_mtok: 0.3, output_per_mtok: 1.2, context_window: 262_144 },
  'deepseek-v3': { input_per_mtok: 0.27, output_per_mtok: 1.1, context_window: 128_000 },
};

/**
 * Cache tiers, as multiples of the input price. Anthropic, OpenAI and DeepSeek all discount cache
 * reads by roughly an order of magnitude and Anthropic charges a premium to write the cache;
 * these are the two multipliers everyone converged on.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{6})$/;
const VERSION_SUFFIX = /-v\d+$/;
const ALIAS_SUFFIX = /-(latest|default)$/;
const REGION_PREFIX = /^[a-z]{2,3}\./;
const VENDOR_PREFIX =
  /^(anthropic|openai|google|meta|mistral|amazon|deepseek|qwen|alibaba|zhipuai|z-ai)\./;

/**
 * Map a wire model id onto a pricing key, or null when nothing is known about it.
 *
 * The same model reaches us as `claude-opus-5`, `anthropic/claude-opus-5`,
 * `claude-opus-5-20260101`, `openrouter/anthropic/claude-opus-5:beta` and
 * `us.anthropic.claude-opus-5-20260101-v1:0`. Candidates are tried most-specific first, so a key
 * that happens to look decorated (`deepseek-v3`) still wins over its own stripped form.
 */
export function resolveModelId(model: string): string | null {
  if (typeof model !== 'string') return null;
  let id = model.trim().toLowerCase();
  if (id === '') return null;

  const candidates: string[] = [];
  const push = (value: string): void => {
    if (value !== '' && !candidates.includes(value)) candidates.push(value);
  };

  push(id);
  id = id.slice(id.lastIndexOf('/') + 1);
  push(id);
  const colon = id.indexOf(':');
  if (colon !== -1) {
    id = id.slice(0, colon);
    push(id);
  }
  if (REGION_PREFIX.test(id) && VENDOR_PREFIX.test(id.replace(REGION_PREFIX, ''))) {
    id = id.replace(REGION_PREFIX, '');
    push(id);
  }
  if (VENDOR_PREFIX.test(id)) {
    id = id.replace(VENDOR_PREFIX, '');
    push(id);
  }
  for (let round = 0; round < 4; round += 1) {
    const before = id;
    for (const suffix of [VERSION_SUFFIX, ALIAS_SUFFIX, DATE_SUFFIX]) {
      if (suffix.test(id)) {
        id = id.replace(suffix, '');
        push(id);
      }
    }
    if (id === before) break;
  }

  for (const candidate of candidates) {
    if (Object.hasOwn(MODEL_PRICING, candidate)) return candidate;
  }
  return null;
}

/** Ids this table prices, for error messages and model pickers. */
export function knownModelIds(): string[] {
  return Object.keys(MODEL_PRICING);
}

/** Prices and context window for a model id, keeping the id the caller used. */
export function modelInfoFor(model: string): ModelInfo | null {
  const key = resolveModelId(model);
  const price = key === null ? undefined : MODEL_PRICING[key];
  if (!price) return null;
  const info: ModelInfo = {
    id: model,
    input_price_per_mtok: price.input_per_mtok,
    output_price_per_mtok: price.output_per_mtok,
  };
  if (price.context_window !== undefined) info.context_window = price.context_window;
  return info;
}

/** Cost of one exchange, or null when the model is unknown. Never guesses. */
export function priceFor(usage: Usage, model: string): Money | null {
  const key = resolveModelId(model);
  const price = key === null ? undefined : MODEL_PRICING[key];
  if (!price) return null;

  const u: Partial<Usage> = usage ?? {};
  const amount =
    (finite(u.input_tokens) * price.input_per_mtok +
      finite(u.output_tokens) * price.output_per_mtok +
      finite(u.cache_read_tokens) * price.input_per_mtok * CACHE_READ_MULTIPLIER +
      finite(u.cache_write_tokens) * price.input_per_mtok * CACHE_WRITE_MULTIPLIER) /
    1_000_000;

  // Ten decimal places is well under a millionth of a cent and keeps binary dust out of reports.
  return { amount: Math.round(amount * 1e10) / 1e10, currency: 'USD' };
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
