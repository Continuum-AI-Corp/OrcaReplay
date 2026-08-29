import { createHash } from 'node:crypto';
import type { CanonicalContent, CanonicalRequest } from '@orcareplay/plugin-api';

/**
 * The replay matching ladder (spec §4).
 *
 * Agent harnesses are not deterministic — timestamps, generated ids, working directories, context
 * compaction firing at a different point. A recorded request will frequently not be byte-identical
 * to the one the agent makes on replay, so matching degrades through four rungs.
 *
 * The rule that matters more than the algorithm: **replay never silently approximates**. Anything
 * below rung 1 produces a divergence the caller must record. A debugger that quietly guesses is
 * worse than no debugger, because you will believe it.
 */

export type MatchRung = 1 | 2 | 3 | 4;
export type DivergenceLevel = 'minor' | 'major';

export interface Divergence {
  level: DivergenceLevel;
  rung: MatchRung;
  detail: string;
  distance: number;
}

export interface MatchResult {
  matched: boolean;
  rung: MatchRung;
  index: number;
  divergence?: Divergence;
  reason?: string;
}

/** Fields that change every run and say nothing about what was asked. */
const VOLATILE_METADATA = new Set([
  'request_id',
  'user_id',
  'session',
  'session_id',
  'trace_id',
  'idempotency_key',
  'timestamp',
]);

/** Rung 2 accepts differences up to this share of the request's total size. */
const MINOR_DISTANCE_RATIO = 0.15;

/**
 * Reduce a request to what actually determines the model's answer: same model, same conversation,
 * same tools, same sampling. Tool order is not meaningful, so it is sorted; metadata that changes
 * per invocation is dropped.
 */
export function normalizeRequest(req: CanonicalRequest): Record<string, unknown> {
  const metadata = req.metadata
    ? Object.fromEntries(
        Object.entries(req.metadata)
          .filter(([k]) => !VOLATILE_METADATA.has(k))
          .sort(([a], [b]) => a.localeCompare(b)),
      )
    : undefined;

  return sortKeys({
    model: req.model,
    system: req.system ?? null,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: m.content.map(normalizeContent),
    })),
    tools: (req.tools ?? [])
      .map((t) => ({
        name: t.name,
        description: t.description ?? null,
        input_schema: t.input_schema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    max_tokens: req.max_tokens ?? null,
    temperature: req.temperature ?? null,
    top_p: req.top_p ?? null,
    stop: req.stop ?? null,
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : null,
  });
}

function normalizeContent(c: CanonicalContent): Record<string, unknown> {
  // A tool_use id is generated per call and never affects the answer, so it is excluded from the
  // identity of the request while the name and input — which do — are kept.
  switch (c.type) {
    case 'tool_use':
      return { type: c.type, name: c.name, input: c.input };
    case 'tool_result':
      return { type: c.type, content: c.content, is_error: c.is_error ?? false };
    case 'image':
      return { type: c.type, media_type: c.media_type, data: c.data };
    default:
      return { type: c.type, text: c.text };
  }
}

function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

export function canonicalHash(req: CanonicalRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeRequest(req)))
    .digest('hex');
}

/** Character-level difference between the normalized forms, as a rough structural distance. */
export function structuralDistance(a: CanonicalRequest, b: CanonicalRequest): number {
  const sa = JSON.stringify(normalizeRequest(a));
  const sb = JSON.stringify(normalizeRequest(b));
  if (sa === sb) return 0;

  // Common prefix and suffix, which is enough to separate "one field edited" from "rewritten".
  let prefix = 0;
  const max = Math.min(sa.length, sb.length);
  while (prefix < max && sa[prefix] === sb[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix && sa[sa.length - 1 - suffix] === sb[sb.length - 1 - suffix]) {
    suffix += 1;
  }
  return Math.max(sa.length, sb.length) - prefix - suffix;
}

function trailingMessageKey(req: CanonicalRequest): string {
  const last = req.messages[req.messages.length - 1];
  return last
    ? JSON.stringify({ role: last.role, content: last.content.map(normalizeContent) })
    : '';
}

/**
 * Walks the recorded requests in order, consuming one per match. Recorded order is meaningful:
 * a conversation replays forwards, so a match behind the cursor would mean the agent went
 * backwards, which is a divergence rather than a match.
 */
export class RequestMatcher {
  readonly #recorded: CanonicalRequest[];
  readonly #hashes: string[];
  #cursor = 0;

  constructor(recorded: CanonicalRequest[]) {
    this.#recorded = recorded;
    this.#hashes = recorded.map(canonicalHash);
  }

  remaining(): number {
    return this.#recorded.length - this.#cursor;
  }

  get cursor(): number {
    return this.#cursor;
  }

  match(incoming: CanonicalRequest): MatchResult {
    if (this.#cursor >= this.#recorded.length) {
      return {
        matched: false,
        rung: 4,
        index: -1,
        reason: `recording exhausted after ${this.#recorded.length} model requests`,
      };
    }

    const index = this.#cursor;
    const candidate = this.#recorded[index]!;

    // Rung 1 — canonical hash.
    if (canonicalHash(incoming) === this.#hashes[index]) {
      this.#cursor += 1;
      return { matched: true, rung: 1, index };
    }

    const distance = structuralDistance(incoming, candidate);
    const size = JSON.stringify(normalizeRequest(candidate)).length;

    // Rung 2 — same position and shape, small difference.
    if (
      incoming.messages.length === candidate.messages.length &&
      distance <= Math.max(64, size * MINOR_DISTANCE_RATIO)
    ) {
      this.#cursor += 1;
      return {
        matched: true,
        rung: 2,
        index,
        divergence: {
          level: 'minor',
          rung: 2,
          distance,
          detail: `request ${index} differs by ${distance} chars with an identical message count`,
        },
      };
    }

    // Rung 3 — the ask is the same, the history is not. Typical after context compaction.
    if (trailingMessageKey(incoming) === trailingMessageKey(candidate)) {
      this.#cursor += 1;
      return {
        matched: true,
        rung: 3,
        index,
        divergence: {
          level: 'major',
          rung: 3,
          distance,
          detail:
            `request ${index} has an identical trailing message but a different prefix ` +
            `(${candidate.messages.length} recorded vs ${incoming.messages.length} replayed)`,
        },
      };
    }

    // Rung 4 — no match. Halt and report; the caller decides whether --loose continues live.
    return {
      matched: false,
      rung: 4,
      index,
      reason:
        `request ${index} does not match the recording ` +
        `(distance ${distance}, ${candidate.messages.length} recorded vs ` +
        `${incoming.messages.length} replayed messages)`,
    };
  }
}
