/**
 * Provider lookup by id.
 *
 * A published extension point with no in-tree consumer. It used to say this exists so
 * `orca fork --model X` can name a provider in config — which sends a contributor looking for the
 * wiring that reads it, and there is none: `--model` selects a dialect and a model name, and the
 * proxy forwards raw bytes to the upstream `orca setup` or `--upstream-*` configured. See the note
 * in `index.ts` for why the live path does not go through a `Provider` at all.
 *
 * What it is for is the other half of the original sentence, which is true: a user can register
 * their own without patching OrcaReplay, through the `Provider` interface in
 * `@orcareplay/plugin-api`.
 */

import type { Provider, ProviderFactory, ProviderOptions } from '@orcareplay/plugin-api';
import { AnthropicProvider } from './anthropic.js';
import { OPENAI_COMPATIBLE_ID, OpenAiCompatibleProvider } from './openai.js';
import type { ProviderRuntimeOptions } from './http.js';
import { omitUndefined } from './translate/util.js';

export interface ProviderCreateOptions extends ProviderRuntimeOptions {
  /** Ignored by the built-in factories, which impose the id they are registered under. */
  id?: string;
}

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  /** Register a factory. A later registration for the same id replaces the earlier one. */
  register(factory: ProviderFactory): void {
    this.factories.set(factory.id, factory);
  }

  create(id: string, options: ProviderCreateOptions = {}): Provider {
    const factory = this.factories.get(id);
    if (!factory) {
      const known = this.ids();
      throw new Error(
        `Unknown provider "${id}". Registered: ${known.length > 0 ? known.join(', ') : '(none)'}. ` +
          'Register one with registry.register({ id, create }); any OpenAI-shaped endpoint ' +
          "(OpenRouter, LiteLLM, vLLM, Ollama) works via openAiCompatibleFactory('<id>', { baseUrl }).",
      );
    }
    return factory.create(options);
  }

  ids(): string[] {
    return [...this.factories.keys()];
  }
}

export const anthropicFactory: ProviderFactory = {
  id: 'anthropic',
  create: (options: ProviderCreateOptions): Provider => new AnthropicProvider(options),
};

/** Build a factory for one OpenAI-shaped endpoint: its own id, its own default baseUrl. */
export function openAiCompatibleFactory(
  id: string = OPENAI_COMPATIBLE_ID,
  defaults: ProviderOptions = {},
): ProviderFactory {
  return {
    id,
    create: (options: ProviderCreateOptions): Provider =>
      new OpenAiCompatibleProvider({ ...defaults, ...omitUndefined(options), id }),
  };
}

/** A registry with the two built-in providers. Fresh each call, so callers cannot poison it. */
export function defaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(anthropicFactory);
  registry.register(openAiCompatibleFactory());
  return registry;
}
