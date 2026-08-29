/**
 * @orcareplay/providers — all of OrcaReplay's wire-format knowledge in one place.
 *
 * Two layers, deliberately separable:
 *
 *   translate/  pure functions between provider wire bodies and the canonical IR. The recording
 *               proxy uses these on intercepted bytes; nothing here touches the network. This is
 *               the layer everything in the tool actually runs on.
 *   providers   live clients (Anthropic, anything OpenAI-shaped) and the registry that resolves a
 *               provider id — a published extension point with no in-tree consumer. Nothing in
 *               OrcaReplay calls it today; see the note below before building on it.
 *
 * Two rules hold everywhere: translation never throws on an unfamiliar body, and anything the
 * canonical IR cannot hold is parked under a namespaced `metadata` key so the round trip back to
 * the wire is lossless. Raw bytes stay the source of truth for exact replay regardless.
 *
 * Which is exactly why the `Provider` layer is not on the live path, and this docstring used to
 * claim it was. When a replay cursor goes live the proxy forwards the agent's own bytes to a
 * configured upstream and translates only where a fork changed the model — going through a
 * `Provider` would mean re-serialising a request orca already holds verbatim, which is a fidelity
 * loss for no gain. To point orca at a different model API today, use `orca setup` or
 * `--upstream-anthropic` / `--upstream-openai`. The layer stays because `Provider` is a published
 * interface in `@orcareplay/plugin-api` and an out-of-tree plugin may implement it; a contributor
 * should know it has no caller here rather than discover it after writing one.
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
