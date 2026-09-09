# OpenCode API capture

`orca record opencode` captures HTTP model calls to the API bases in the
[OpenCode model catalog](https://models.opencode.ai/api.json), plus ChatGPT subscription calls,
through a plugin written into the run directory. It does not modify the user's OpenCode
configuration files or credentials.

## Catalog coverage

The plugin collects both `provider.api` and `provider.models[model].provider.api`. It refreshes
the public catalog once when loaded, with a three-second timeout. Network errors, bad JSON or
an empty catalog produce a warning and retain the bundled API list. The bundled snapshot
contains 196 distinct API templates from the catalog retrieved on 2026-09-08.

- Match POST requests on an API base or beneath it, comparing the scheme, host, port and path
  boundary. This covers versioned paths, trailing slashes, model-specific origins, HTTP local
  services and nonstandard ports. Discovery GETs are passed through unchanged.
- Expand `${VARIABLE}` placeholders using the child process's environment. Unresolved variables
  and invalid URLs are ignored; they never become wildcard hosts.
- Learn additional model and custom provider bases from OpenCode's `chat.params` hook, using
  `model.api.url` and `provider.options.baseURL` without changing those values.
- Preserve the final destination, path, query, request body and authentication when forwarding
  through Orca. Configuring an Orca gateway does not override an explicitly captured destination.
- OpenAI-compatible completions, Responses and Anthropic messages (including prefixed paths
  such as `/anthropic/v1/messages`) produce `model.request` / `model.response` events. Other POST
  formats produce `net.request` / `net.response` with the raw exchange. Capturing an API does
  **not** imply translation, token accounting, model substitution or offline replay support for
  its wire format; opaque exchanges cannot be replayed.

`OPENCODE_DISABLE_MODELS_FETCH=1` (or `true`) skips the catalog refresh. `orca replay` sets it
automatically for OpenCode. The bundled list and the model hook remain active. Update the bundled
list with:

```sh
node scripts/update-opencode-api-bases.mjs
# Or regenerate reproducibly from a downloaded catalog:
node scripts/update-opencode-api-bases.mjs /path/to/api.json
```

## Cause

In [OpenCode 1.18.29's ChatGPT auth plugin](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/plugin/openai/codex.ts),
the OAuth fetch replaces the SDK's Responses URL with
`https://chatgpt.com/backend-api/codex/responses` immediately before sending it. This bypasses
Orca's `OPENAI_BASE_URL`. PR #36's provider overlay targets `opencode` and `opencode-go`, so it
does not fix this later rewrite. The ordinary API-key path was captured in the harness test.

The compiled OpenCode executable also ignored a `BUN_OPTIONS=--preload ...` probe. The adapter
therefore uses OpenCode's own plugin loader instead of a runtime preload.

## Capture behavior

- Append a local plugin URL to `OPENCODE_CONFIG_CONTENT`, preserving existing settings and plugins.
- Wrap the final `fetch` for catalog API bases, the ChatGPT Codex Responses endpoint and the
  public OpenAI `/v1/responses` and `/v1/chat/completions` endpoints.
- Forward the original origin through Orca's `/forward/` route, retaining the request body,
  auth headers, abort signal and fetch options. A default Orca gateway does not receive the
  ChatGPT subscription token.
- Use the existing Responses/Codex translators and event writer to emit `model.request` and
  `model.response`, including streamed responses. Authentication headers are redacted by the
  existing proxy capture path.
- Leave OpenAI login, token refresh and other ChatGPT endpoints untouched.
  A failed redirected request is not retried directly outside Orca.

## Verification

```sh
npm run build
npx vitest run packages/adapters packages/proxy packages/cli/test/opencode-capture.test.ts packages/cli/test/opencode-catalog-capture.test.ts
ORCA_TEST_OPENCODE="$(command -v opencode)" npx vitest run packages/cli/test/opencode-capture.test.ts
```

The opt-in harness test uses the installed executable, an isolated home and Git repository,
fake OAuth/API-key credentials, and a local upstream stub. It checks the OAuth bypass without
the plugin, captures both authentication paths with it, and inspects `events.jsonl`.
Separate child-process tests verify streamed capture and exact offline replay.
No live ChatGPT/OpenAI account is used in these tests.

Catalog tests exercise every bundled URL template with synthetic environment values. The
catalog integration test loads the emitted plugin in a child process, checks original upstream
destinations and credential redaction, records both model and opaque events, and replays the
supported formats without network access. Its catalog refresh is also stubbed: it needs no
provider account or live catalog service.

## Claude model verification

OpenCode's Anthropic SDK appends `/messages` to `ANTHROPIC_BASE_URL`; Claude Code appends
`/v1/messages`. Giving both adapters the same bare origin sent OpenCode requests to `/messages`,
which returned 404 and was recorded as opaque network traffic rather than model events.
The OpenCode adapter now sets this variable to `<proxy>/v1`. Claude Code keeps the bare origin.

The built `orca record` CLI was also checked with Claude Code 2.1.220 using API-key, Bearer,
and OAuth-token fixtures, and with OpenCode 1.18.29 using an Anthropic API-key fixture.
All use isolated settings, fake credentials, and a local upstream. The tests check model events,
streaming replies, credential redaction, and preservation of the Claude Code OAuth beta header.
OpenCode third-party Anthropic OAuth plugins and live subscription authentication are not covered.

```sh
npm run build
ORCA_TEST_CLAUDE="$(command -v claude)" ORCA_TEST_OPENCODE="$(command -v opencode)" \
  npx vitest run packages/cli/test/claude-capture.test.ts
```

## Limits

The plugin must be enabled: OpenCode's `--pure` / `OPENCODE_PURE` disables external plugins.
This hook handles HTTP fetch/SSE, not OpenCode's experimental WebSocket transport. Providers with
no catalog `api` whose SDK resolves an origin absent from the model hook, and custom auth plugins
using another transport or an unlisted final origin, still need additional capture support.
Provider substitutions resolved exclusively inside an SDK, rather than the environment or a
concrete hook base URL, are not inferred. Invalid inline config
is passed through for OpenCode to diagnose; unreadable file configuration still disables the
existing provider overlay. No guarantee is made for those uncaptured paths.
