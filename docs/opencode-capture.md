# OpenCode ChatGPT capture

`orca record opencode` captures ChatGPT subscription model calls through a plugin written into
the run directory. It does not modify the user's OpenCode configuration files or credentials.

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
- Wrap the final `fetch` for exactly the ChatGPT Codex Responses endpoint and the public OpenAI
  `/v1/responses` and `/v1/chat/completions` endpoints.
- Forward the original origin through Orca's `/forward/` route, retaining the request body,
  auth headers, abort signal and fetch options. A default Orca gateway does not receive the
  ChatGPT subscription token.
- Use the existing Responses/Codex translators and event writer to emit `model.request` and
  `model.response`, including streamed responses. Authentication headers are redacted by the
  existing proxy capture path.
- Leave login, token refresh, other ChatGPT endpoints and custom provider origins untouched.
  A failed redirected request is not retried directly outside Orca.

## Verification

```sh
npm run build
npx vitest run packages/adapters packages/proxy packages/cli/test/opencode-capture.test.ts
ORCA_TEST_OPENCODE="$(command -v opencode)" npx vitest run packages/cli/test/opencode-capture.test.ts
```

The opt-in harness test uses the installed executable, an isolated home and Git repository,
fake OAuth/API-key credentials, and a local upstream stub. It checks the OAuth bypass without
the plugin, captures both authentication paths with it, and inspects `events.jsonl`.
Separate child-process tests verify streamed capture and exact offline replay.
No live ChatGPT/OpenAI account is used in these tests.

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
This hook handles HTTP fetch/SSE, not OpenCode's experimental WebSocket transport. Custom auth
plugins using another transport or origin need their own capture support. Invalid inline config
is passed through for OpenCode to diagnose; unreadable file configuration still disables the
existing provider overlay. No guarantee is made for those uncaptured paths.
