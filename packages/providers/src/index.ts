/**
 * @orcareplay/providers — all of OrcaReplay's wire-format knowledge in one place.
 *
 * Two layers, deliberately separable:
 *
 *   translate/  pure functions between provider wire bodies and the canonical IR. The recording
 *               proxy uses these on intercepted bytes; nothing here touches the network.
 *   pricing     what a recorded exchange cost, or null when the model is unknown.
 *
 * Two rules hold everywhere: translation never throws on an unfamiliar body, and anything the
 * canonical IR cannot hold is parked under a namespaced `metadata` key so the round trip back to
 * the wire is lossless. Raw bytes stay the source of truth for exact replay regardless.
 *
 * This package used to carry a third layer — live `Provider` clients for Anthropic and anything
 * OpenAI-shaped, plus a registry to resolve one by id — and nothing ever called it. Roughly 400
 * lines of production code and 570 of tests, kept because the docstring claimed the live path went
 * through it. It never did: when a replay cursor goes live the proxy forwards the agent's own bytes
 * to a configured upstream and translates only where a fork changed the model. Routing that through
 * a `Provider` would mean re-serialising a request orca already holds verbatim, which loses
 * fidelity for nothing, so the layer was not one push away from being used — it was the wrong shape
 * for the only job it could have had.
 *
 * The `Provider` interface itself is still published, in `@orcareplay/plugin-api`, for an
 * out-of-tree implementation and for a future live path that wants one. What is gone is the pile of
 * unused code behind it. To point orca at a different model API today: `orca setup`, or
 * `--upstream-anthropic` / `--upstream-openai`.
 */

export * from './translate/util.js';
export * from './translate/sse.js';
export * from './translate/anthropic.js';
export * from './translate/openai.js';
export * from './pricing.js';
export * from './translate/openai-responses.js';
