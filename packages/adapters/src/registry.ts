import type { Adapter } from '@orcareplay/plugin-api';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { genericOpenAiAdapter } from './generic-openai.js';
import { openCodeAdapter } from './opencode.js';

export class AdapterRegistry {
  readonly #adapters = new Map<string, Adapter>();

  register(adapter: Adapter): void {
    const existing = this.#adapters.get(adapter.id);
    if (existing && existing !== adapter) {
      throw new Error(
        `adapter id '${adapter.id}' is already registered; two adapters cannot share an id — ` +
          'rename one of them',
      );
    }
    this.#adapters.set(adapter.id, adapter);
  }

  get(id: string): Adapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) {
      throw new Error(
        `unknown adapter '${id}'. Known adapters: ${this.ids().join(', ')}. ` +
          "If your agent is not listed, run it under 'generic-openai' and pass the command after " +
          '--, e.g. orca record generic-openai -- my-agent --task ...',
      );
    }
    return adapter;
  }

  ids(): string[] {
    return [...this.#adapters.keys()];
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
  registry.register(genericOpenAiAdapter);
  return registry;
}
