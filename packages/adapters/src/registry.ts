import type { Adapter } from '@orcareplay/plugin-api';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { genericOpenAiAdapter } from './generic-openai.js';
import { nodeAdapter } from './node.js';
import { openCodeAdapter } from './opencode.js';

export class AdapterRegistry {
  readonly #adapters = new Map<string, Adapter>();
  /** Alias → canonical id. Kept apart from #adapters so `ids()` stays the canonical id space. */
  readonly #aliases = new Map<string, string>();

  register(adapter: Adapter): void {
    const existing = this.#adapters.get(adapter.id);
    if (existing && existing !== adapter) {
      throw new Error(
        `adapter id '${adapter.id}' is already registered; two adapters cannot share an id — ` +
          'rename one of them',
      );
    }
    for (const alias of adapter.aliases ?? []) {
      // An alias that shadows a real id, or one already claimed, would make `orca record <name>`
      // silently launch a different harness than the name says. Fail at registration instead.
      const clash = this.#adapters.get(alias) ?? this.#adapters.get(this.#aliases.get(alias) ?? '');
      if (clash && clash !== adapter) {
        throw new Error(
          `adapter '${adapter.id}' claims the alias '${alias}', which already resolves to ` +
            `'${clash.id}' — an alias cannot point at two harnesses`,
        );
      }
      this.#aliases.set(alias, adapter.id);
    }
    this.#adapters.set(adapter.id, adapter);
  }

  get(id: string): Adapter {
    const adapter = this.#adapters.get(id) ?? this.#adapters.get(this.#aliases.get(id) ?? '');
    if (!adapter) {
      throw new Error(
        `unknown adapter '${id}'. Known adapters: ${this.names().join(', ')}. ` +
          "If your agent is not listed, run it under 'generic-openai' and pass the command after " +
          '--, e.g. orca record generic-openai -- my-agent --task ...',
      );
    }
    return adapter;
  }

  /** Canonical ids. This is the id space a manifest is written in. */
  ids(): string[] {
    return [...this.#adapters.keys()];
  }

  /**
   * Everything a user may type, canonical ids with their aliases attached.
   *
   * Error messages and help text use this rather than `ids()`: someone who just typed `claude`
   * needs to see that `claude` is spelled `claude`, not be shown a list that omits it.
   */
  names(): string[] {
    return this.ids().map((id) => {
      const aliases = [...this.#aliases.entries()]
        .filter(([, target]) => target === id)
        .map(([alias]) => alias);
      return aliases.length === 0 ? id : `${id} (or ${aliases.join(', ')})`;
    });
  }

  /** First adapter that claims the workspace. A detector that throws is treated as "no". */
  async detect(cwd: string): Promise<Adapter | undefined> {
    for (const adapter of this.#adapters.values()) {
      try {
        if (await adapter.detect(cwd)) return adapter;
      } catch {
        continue;
      }
    }
    return undefined;
  }
}

export function defaultAdapters(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(claudeCodeAdapter);
  registry.register(codexAdapter);
  registry.register(openCodeAdapter);
  registry.register(nodeAdapter);
  registry.register(genericOpenAiAdapter);
  return registry;
}
