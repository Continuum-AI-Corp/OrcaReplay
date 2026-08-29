/**
 * @orcareplay/providers — all of OrcaReplay's wire-format knowledge in one place.
 *
 * Two layers, deliberately separable:
 *
 *   translate/  pure functions between provider wire bodies and the canonical IR. The recording
 *               proxy uses these on intercepted bytes; nothing here touches the network.
 *   providers   live clients (Anthropic, anything OpenAI-shaped) used when a replay cursor goes
 *               live, plus the registry that resolves a provider id from config.
 *
 * Two rules hold everywhere: translation never throws on an unfamiliar body, and anything the
 * canonical IR cannot hold is parked under a namespaced `metadata` key so the round trip back to
 * the wire is lossless. Raw bytes stay the source of truth for exact replay regardless.
 */

export * from './translate/util.js';
export * from './translate/sse.js';
export * from './translate/anthropic.js';
export * from './translate/openai.js';
export * from './pricing.js';
export * from './http.js';
export * from './anthropic.js';
export * from './openai.js';
export * from './registry.js';
