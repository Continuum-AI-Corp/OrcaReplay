import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent } from './detect.js';
import { passKey, passThrough, proxyBase, readEnv } from './env.js';

/**
 * goose — Block's agent, and the one harness so far that reads a *different* set of variables
 * than every other OpenAI-shaped client.
 *
 * Three facts decided this adapter, each measured against goose 1.49.0 rather than inferred, by
 * pointing it at a sink server and reading back the request line:
 *
 * 1. **`OPENAI_HOST` outranks `OPENAI_BASE_URL`.** `openai_def.rs` resolves the origin in priority
 *    order — `OPENAI_HOST` from the environment first, `OPENAI_BASE_URL` second — so a user who
 *    has `OPENAI_HOST` set for some other tool keeps it, and the run goes to their origin while
 *    orca reports a successful recording with an empty trace. Setting only `OPENAI_BASE_URL` is
 *    the `capture.empty` shape the adapter contract exists to prevent, so this adapter sets both.
 *    Pointed at the same proxy they agree, and neither a stale value nor the priority order can
 *    route around it.
 *
 * 2. **goose does not read `ANTHROPIC_BASE_URL`.** Its Anthropic provider reads `ANTHROPIC_HOST`
 *    (`anthropic_def.rs`), and a sink pointed at by `ANTHROPIC_BASE_URL` alone receives nothing at
 *    all. This is precisely why `generic-openai` is not good enough for goose: it sets the
 *    variable the rest of the ecosystem reads, which here is the one variable that does nothing.
 *
 * 3. **The traffic is the Responses API.** With either variable set, goose issues
 *    `POST /v1/responses`, not `/v1/chat/completions` — plus one `GET /v1/models` on start-up. The
 *    proxy's `openai-responses` dialect claims it (`matches: (p) => p.endsWith('/responses')`), so
 *    no path rewriting is needed; it is recorded here because "it happens to work" and "it is
 *    known to work" are different claims, and only the second survives an upstream refactor.
 *
 * `Config::get_param` reads the environment before the config file for every key it resolves
 * (`config/base.rs`), which is what makes per-process redirection possible at all — goose's
 * persisted `~/.config/goose/config.yaml` cannot win against the overlay orca sets.
 *
 * **What this adapter does not capture.** goose runs its shell without going through orca's PATH
 * shim, so a run full of `shell` tool calls still reports `shell.ineffective`: the commands appear
 * as tool calls with their output, but the real exit code, the real duration and the
 * stdout/stderr split are not in the trace. Record with `--no-shell` to claim nothing rather than
 * to claim that.
 */
export const gooseAdapter: Adapter = {
  id: 'goose',
  harnessVersions: '>=1.49.0',

  async detect(_cwd: string): Promise<boolean> {
    return detectAgent(['goose'], ['.config/goose']);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const env: Record<string, string> = {
      // Both, deliberately — see fact 1. `OPENAI_HOST` takes an origin and goose appends the
      // endpoint itself; `OPENAI_BASE_URL` takes the `/v1` form the rest of the ecosystem uses.
      OPENAI_HOST: proxyBase(ctx.proxyUrl),
      OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
      // Not `ANTHROPIC_BASE_URL`: goose reads neither that nor `ANTHROPIC_API_BASE`. See fact 2.
      ANTHROPIC_HOST: proxyBase(ctx.proxyUrl),
    };

    // Same credential rule as the other adapters. Which keys the harness can see decides which
    // provider it picks, so inventing one for a provider the user never configured can change
    // which model answers — and a recorded run that answers differently from the same command
    // uninstrumented is the worst kind of capture bug. A placeholder stands in only when there is
    // nothing to disturb.
    const hasAny =
      readEnv(ctx.env, 'OPENAI_API_KEY') !== undefined ||
      readEnv(ctx.env, 'ANTHROPIC_API_KEY') !== undefined;
    if (hasAny) {
      passThrough(env, ctx.env, 'OPENAI_API_KEY');
      passThrough(env, ctx.env, 'ANTHROPIC_API_KEY');
    } else {
      passKey(env, ctx.env, 'OPENAI_API_KEY');
    }

    // Passed on, never invented: goose has no default provider or model for a custom endpoint, and
    // which one the recording is meant to exercise is the operator's to say. Inventing either
    // would make `orca record goose` launch a different agent than `goose` does.
    passThrough(env, ctx.env, 'GOOSE_PROVIDER');
    passThrough(env, ctx.env, 'GOOSE_MODEL');
    // `OPENAI_BASE_PATH` is read from the environment ahead of the config file whenever the host
    // came from `OPENAI_BASE_URL`, so a value left over from a Docker Model Runner setup would
    // move the path orca serves. Passing it through keeps the recording faithful to the command
    // the user actually ran; the proxy matches `/chat/completions` with or without a `/v1`.
    passThrough(env, ctx.env, 'OPENAI_BASE_PATH');

    return { command: 'goose', args: [...ctx.userArgs], env };
  },
};
