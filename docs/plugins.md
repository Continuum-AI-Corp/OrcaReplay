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
single fact decides whether an adapter is an afternoon or a week — or whether one can be written at
all. Base-URL injection is the only capture mechanism there is; there is no CA mode to fall back on
(see [SECURITY.md](../SECURITY.md)), so a harness that reads no base-URL variable cannot be
recorded today. If it reads an unusual one, the generic OpenAI adapter probably already covers you:
it sets `OPENAI_BASE_URL`, `OPENAI_API_BASE` and `ANTHROPIC_BASE_URL` at once and takes the command
from argv.

## The adapter contract

Adapters rot. A harness renames the variable it reads for its API origin, the adapter keeps setting
the old one, and nothing looks wrong: the agent answers, the exit code is zero, and the trace is
empty. `checkAdapterContract` is the guard against that, and it runs against any adapter — ours or
yours:

```ts
import { checkAdapterContract, formatContractResult } from '@orcareplay/adapters';
import { myAgent } from './my-agent.js';

const result = await checkAdapterContract(myAgent);
console.log(formatContractResult(result)); // "my-agent: ok (9 checks)"
if (!result.ok) process.exitCode = 1;
```

It never throws and it runs every check even after one fails, so one pass gives you the whole list.
Pass `{ ctx: { userArgs: ['my-agent'] } }` if your adapter takes its command from argv.

Nine checks are registered, and the count in that line is how many actually **ran**: a check that
does not apply is skipped rather than counted as a pass. Only one skips today —
`harness-versions`, when an adapter declares no range — so an adapter without a
`harnessVersions` field prints `ok (8 checks)` and one with a range prints `ok (9 checks)`. The
adapter above declares `>=1.2.0 <2`, so it gets nine.

Each check is here because breaking it fails *silently*:

- **`id-format`** — lowercase kebab-case. The id is what a user types after `orca record` and what
  the trace records; mixed case and underscores turn into support questions.
- **`detect-resolves`** — `detect()` must resolve, for a real directory and for a path that does not
  exist. The registry reads a throwing detector as "no", so yours would silently never match, and
  any caller that does not guard loses detection for every other adapter too.
- **`prepare-shape`** — a non-empty `command` and an `args` array of strings. argv is a list, never
  a pre-joined command line.
- **`redirects-model-traffic`** — the env must set at least one of `ANTHROPIC_BASE_URL`,
  `OPENAI_BASE_URL`, `OPENAI_API_BASE`, and *every* base-url variable it sets must point at
  `ctx.proxyUrl`. This is the check that catches rot: point a variable the harness no longer reads
  and capture returns nothing while everything still appears to work.
- **`no-invented-keys`** — never fabricate a credential the incoming `ctx.env` did not have. Use
  `passKey()` where the harness refuses to start without one — it substitutes an obviously-fake
  placeholder — and `passThrough()` for a second provider. Harnesses pick a provider from the
  credentials they can see, so an invented key can change which model the run calls.
- **`no-ctx-mutation`** — `orca record` hands you `process.env` itself as `ctx.env` and the parsed
  argv as `ctx.userArgs`. Mutating them edits the recorder's own environment and the argv written
  into the manifest. Copy: `args: [...ctx.userArgs]`.
- **`deterministic`** — two `prepare()` calls on the same context must agree. Replay prepares that
  context again, so anything random or time-based reads as a divergence.
- **`no-foreign-paths`** — no absolute path from outside `ctx.runDir` or `ctx.cwd` in the launch
  env. Write scratch config under `ctx.runDir`, or your home directory ends up in a shared trace.
- **`harness-versions`** — if you declare a range it has to be a semver range. `latest` says
  nothing about what you tested.

`packages/adapters/test/contract.test.ts` runs every adapter in `defaultAdapters()` through this,
so a newly registered adapter is covered without opting in — and runs deliberately broken adapters
through it too, so every check is proven to bite.

### Start from the scaffold

`scaffoldAdapter('my-agent')` returns the contents of a working adapter and its test — correct
imports, a `detect` built on `hasBinary`, a `prepare` that redirects to `ctx.proxyUrl`, and one
`TODO`: confirm which variable your harness actually reads. It returns data rather than writing
files, so the generated adapter is itself run through `checkAdapterContract` in the test suite.

### A PR adding an adapter includes its harness fixture

`fixtures/harness/<id>.json` records the exact env-var names your adapter sets, the path each base
url gets, the harness version range you verified against, and the date you verified it.
`test/harness-versions.test.ts` compares that record to what `prepare()` produces now.

**When a harness changes and you update an adapter, update the fixture in the same PR.** That is
the whole point: the fixture diff is where a reviewer sees "this adapter now sets a different
variable", and `verified_at` is the cue to ask whether you ran the harness or guessed. A fixture
nobody has to touch only records what the adapter used to do.

## Provider — a published interface with no caller yet

**Read this first.** `Provider` is exported from `@orcareplay/plugin-api` and nothing in OrcaReplay
calls it. When a replay cursor goes live the proxy forwards the agent's own request bytes to a
configured upstream, translating only where a fork changed the model — routing that through a
`Provider` would mean re-serialising a request orca already holds verbatim, which loses fidelity for
no gain. To point orca at a different model API today, use `orca setup`, or `--upstream-anthropic` /
`--upstream-openai` per run.

So implement this to be *ready* for a future live path, or to reuse the shape in your own tooling —
not because registering one changes what `orca replay --model` does. It does not, yet.


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
