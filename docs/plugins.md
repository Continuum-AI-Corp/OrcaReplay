# Writing a plugin

There are exactly two extension points, and they are deliberately small. A surface you can widen
later beats one you must support forever.

## Adapter — how to launch and instrument one agent

```ts
import type { Adapter, RecordContext, Launch } from '@orcareplay/plugin-api';

export const myAgent: Adapter = {
  id: 'my-agent',
  harnessVersions: '>=1.2.0 <2',

  async detect(cwd) {
    // Cheap check: is this agent plausibly in use here?
    return existsSync(join(cwd, '.myagent'));
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    return {
      command: 'my-agent',
      args: ctx.userArgs,
      env: {
        // The whole trick: point the agent at the local recording proxy.
        OPENAI_BASE_URL: `${ctx.proxyUrl}/v1`,
      },
    };
  },
};
```

That is the entire required surface. `sessionState?()` is optional and only worth implementing if
your harness exposes internal state a fork would otherwise lose (context compaction state, todo
lists, memory files).

**Before you write one**, check whether the agent respects a base-URL environment variable. That
single fact decides whether an adapter is an afternoon or a week. If it does not, the generic
OpenAI adapter plus the opt-in CA mode may already cover it.

## Provider — how to reach a model when replay goes live

```ts
import type { Provider, CanonicalRequest, CanonicalChunk } from '@orcareplay/plugin-api';

export class MyProvider implements Provider {
  id = 'my-provider';
  async models() { return [{ id: 'my-model-1' }]; }
  async *invoke(req: CanonicalRequest): AsyncIterable<CanonicalChunk> {
    // translate req → your wire format, stream back, yield a final `done` chunk
  }
  price(usage, model) { return null; }  // null means unknown — never guess a cost
}
```

`price()` returning `null` for an unknown model is deliberate. A confidently wrong cost number is
worse than an absent one, because it ends up in a comparison table someone makes a decision from.

## The canonical IR, and why exchanges are recorded twice

Every model exchange is stored in **both** forms:

- the **raw provider bytes**, which is what makes exact replay exact;
- the **canonical form** — a normalized message list, tool schema and sampling params — which is
  what makes `--model glm-5.3-flash` possible on a run recorded against Claude.

Never discard the raw bytes to save space. Blob dedup already handles size, and a lossy trace
cannot be replayed exactly, which is the whole point of the tool.

## Neutrality

Plugins get no privileged API. A vendor plugin imports `@orcareplay/plugin-api` and nothing else,
and `scripts/check-neutrality.mjs` fails CI if that stops being true.

If your plugin needs a capability the interface lacks, propose it for the public interface — with a
second implementation showing it is not shaped around one vendor. That rule applies to the
maintainers' own OrcaRouter plugin exactly as it applies to yours.
