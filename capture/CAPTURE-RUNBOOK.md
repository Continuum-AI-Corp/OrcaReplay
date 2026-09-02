# Capturing an agent's system prompt

How to read the system prompt a coding agent assembled on your own machine, using OrcaReplay's
proxy as the vantage point. Nothing here talks to a service about anything but the agent's own
model call: the prompt is captured from the request the harness sent, on the way out.

`node capture/capture.mjs <claude|codex|opencode>` does all of this in one command. This document
is the manual procedure behind it, for porting the approach to a harness the script does not cover
or to a platform it does not run on.

Measured against Claude Code 2.1.258, Codex 0.149.0 and OpenCode 1.18.26 on Windows 10, node
22.23.2, OrcaReplay 0.1.2.

## What you get

| piece | where it lives |
|---|---|
| the prompt on its own | `prompt/<HARNESS>/<model>-system-prompt.md` |
| the same text with block boundaries | `capture/<name>/<name>-prompt-annotated.txt` |
| the whole request body | `capture/<name>/<name>-request.json` |
| tool definitions | `capture/<name>/<name>-tools.json` |
| run id, sizes, token counts | `capture/<name>/<name>-meta.json` |
| the raw orca run | `capture/<name>/trace/` |

Everything but `trace/` is scrubbed.

## Prerequisites

| | |
|---|---|
| node | 20.19+ or 22.12+ |
| orcareplay | `npm i -g orcareplay` |
| the agent | installed, signed in, and able to reach the model it names |
| terminal | PowerShell is needed for step 4 on Windows |

On Linux and macOS steps 3 to 5 collapse into a single `orca record`: a pipe there still sits
behind a pty, so the harness assembles its interactive prompt anyway. Windows is the case that
needs the extra work, for the reason in the pitfalls below.

## Steps

### 1. Find out where orca will forward

If `orca setup` has configured a gateway, `resolveUpstream()` (`packages/cli/src/config.ts:132`)
sends every Anthropic call there, and a third-party router usually does not serve the model.

```console
$ cat ~/.config/orca/config.json
{ "gateway": { "url": "http://<your-gateway>:8317", "api_key": "<key>" },
  "models": [ "gpt-5.6-sol" ] }
```

If that file names a gateway, add `--upstream-anthropic https://api.anthropic.com` to every orca
command below. Codex is the opposite case: its own `config.toml` already points at that gateway, so
leaving the upstream alone is what makes its model resolve.

### 2. Capture the non-interactive prompt first

Optional, but cheap, and it confirms the proxy, the credential and the model id in one go.

```console
$ orca record claude --no-fs --no-shell \
    --upstream-anthropic https://api.anthropic.com \
    -- -p "reply with just: ok" --model claude-fable-5-1
info recording run=run_8e6d567d4ca4 adapter=claude-code proxy=:58642
ok
info recorded run=run_8e6d567d4ca4 events=7 blobs=3 exit=0
```

`exit=0` means the path works. Note this is the `-p` prompt, tagged `cc_entrypoint=sdk-cli`, not the
interactive one.

### 3. Hold a proxy open

`orca attach` does not launch the agent. It holds the proxy and prints the variable to export.
`--port` is not in `--help` but it exists, and a fixed port saves parsing the output.

```console
$ orca attach --for claude --port 46001 \
    --upstream-anthropic https://api.anthropic.com
info attached run=run_bc749535e248 proxy=http://127.0.0.1:46001 for=claude-code

  # in the sandbox, before starting your agent:
  export ANTHROPIC_BASE_URL='http://127.0.0.1:46001'
  # your agent's own credential is unchanged - orca forwards it upstream

  Recording. Press ctrl-C when the agent is done.
```

This command stays up. Use a second window for the next step.

### 4. Start the agent in a console of its own

`Start-Process` without `-NoNewWindow` is the whole trick: Windows hands a console application a
real console, so `process.stdin.isTTY` is true and the harness assembles its interactive prompt.

```powershell
$claude = "$env:APPDATA\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
foreach ($n in @('CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID','CLAUDE_EFFORT','CLAUDE_CODE_EXECPATH','AI_AGENT')) {
  if (Test-Path "Env:\$n") { Remove-Item "Env:\$n" }
}
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:46001'
Start-Process -FilePath $claude -WindowStyle Minimized -PassThru `
  -WorkingDirectory 'D:\your\repo' `
  -ArgumentList @('--model','claude-fable-5-1','"say only the word ok"')
```

Wrap the prompt in embedded quotes so it arrives as a **single** argument. Choose a working
directory the agent already trusts, or it stops on the trust dialog with nobody to answer it.

### 5. Wait for the request that carries tools

The first `model.request` is the title generator, `tools=0`, and it is not the one you want. Wait
for the one where `tools` is greater than zero.

```console
$ until grep -q '"tools":3' .orca/runs/*/events.jsonl; do sleep 2; done
seq 4  model.request   claude-fable-5-1  tools=35  blob=175255
seq 5  model.response  200  end_turn  cache_read=59811
```

### 6. Clean up

Both processes have to stop. Killing the shell that started `orca attach` does not reach the node
process behind it, and the port stays bound.

```powershell
Stop-Process -Id 18544 -Force
Get-NetTCPConnection -LocalPort 46001 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### 7. Read the request body out of the trace

Events hold the blob's sha256, sharded by its first two characters. Take the **first** request with
tools, not the largest: later turns load deferred tools, so the tool count climbs from 35 to 37 and
the biggest request describes a state the first turn was never in.

```js
const evs = readFileSync(dir + '/events.jsonl', 'utf8')
  .split('\n').filter(Boolean).map(JSON.parse);
const r = evs.filter(e => e.type === 'model.request' && e.attrs.tools > 0)[0];
const sha = r.payload.$blob.replace('sha256:', '');
let body = JSON.parse(readFileSync(`${dir}/blobs/${sha.slice(0,2)}/${sha}`, 'utf8'));
if (typeof body === 'string') body = JSON.parse(body);   // blobs are double-encoded
```

### 8. Assemble the prompt and scrub it

Where the prompt lives depends on the dialect.

**Claude Code**, Anthropic messages: the `system` array, then the injected `role: "system"` message
that carries agent types, the skill list and a paragraph about the permission mode.

```js
const prompt = body.system.map(s => s.text).join('\n\n')
  + '\n\n' + body.messages.find(m => m.role === 'system').content[0].text;
```

```
  [0]     70 chars  cache=none    billing header
  [1]     57 chars  cache=1h      identity
  [2]    907 chars  cache=none    reporting outcomes
  [3]  13919 chars  cache=1h      the body
  role:system  11478 chars
```

**Codex**, OpenAI responses: no `instructions` field and no top-level `tools`. The prompt arrives as
`developer`-role messages inside `input`, and the tools hang off a custom `additional_tools` item as
a namespace tree, which is why the recorded event reads `tools: 0`.

**OpenCode**, OpenAI chat completions: a single `system` message, tools in the standard `tools`
array.

Then replace the machine-specific values with placeholders. Derive them from the machine rather
than hard-coding them: home directory, username, git name and email, the gateway host from
`~/.config/orca/config.json`, the Claude Code project slug, the OS build, plus generic rules for
emails, uuids and hex runs of 32 or more. Order matters, because the memory directory sits inside
the home directory. Re-scan afterwards and refuse to write the file if anything survives.

## How much the mode changes

| | print (`sdk-cli`) | interactive (`cli`) |
|---|---|---|
| `system[]` | 13,641 chars | 14,953 chars |
| `role:system` | 7,585 chars | 11,529 chars |
| tools | 29 | 35 |
| request | 104,492 bytes | 168,303 bytes |
| tokens | 37,831 | 59,811 |

Interactive adds the `! <command>` hint, the whole Scratchpad Directory section, a `gitStatus` block
when the working directory is a repository, and `Artifact`, `AskUserQuestion`, `EnterPlanMode` and
`ExitPlanMode`.

The identity line changes too:

- print — `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
- interactive — `You are Claude Code, Anthropic's official CLI for Claude.`

## Pitfalls

**A gateway rewrites the upstream silently.** `400 unknown provider for model claude-fable-5-1`
comes from the gateway you configured, not from Anthropic, and has nothing to do with whether the
agent is installed. The agent works on its own because it talks to the official endpoint directly.

**Credentials are forwarded upstream.** `SECRET_REQUEST_HEADERS` in
`packages/proxy/src/server.ts` forwards auth headers, though it never writes them to a trace. With
the upstream pointed at a third-party gateway that sends an OAuth token there along with the whole
prompt, and over plain HTTP if that is what the gateway speaks.

**`orca record claude` cannot reach the interactive prompt.** It launches through a pipe, `isTTY` is
false, and the harness takes the non-interactive path. The adapter also hard-codes `command:
'claude'`, so there is no room to slip a pty shim in front of it.

**winpty will not start without a console.** It asserts `cols > 0 && rows > 0` at
`winpty.cc:924`, because it cannot learn the window size from a pipe and the command line has no
`--cols`. Letting `Start-Process` allocate a console is less work than building a pty. Node's own
`detached` is no help either: on Windows it means `DETACHED_PROCESS`, so no console at all.

**PowerShell splits an argument containing spaces.** Passing `'reply with just: ok'` in
`-ArgumentList` delivers only `reply`, and the agent then goes looking through git and pull requests
for context. The system prompt is unaffected, but the tokens are wasted.

**A nested session inherits `CLAUDE_*`.** Starting the agent from inside another Claude Code session
passes down `CLAUDECODE=1` and `CLAUDE_CODE_CHILD_SESSION=1`, which changes the prompt. That is what
the `Remove-Item` loop in step 4 is for.

**The working directory is part of the prompt.** Capturing in a temporary non-repository loses the
whole `gitStatus` block: 4,271 characters on a measured Opus 5 run. Capture where you actually work.

**A failed turn still produces a prompt.** A wrong `--model` and a transient `overloaded_error` fail
the same way, and in both cases the request was already recorded. Check the response before filing
the capture, or a typo creates a folder for a model that does not exist.

**OpenCode keeps its origin in a config file.** `OPENAI_BASE_URL` alone leaves the run talking
straight to the gateway and the trace empty. A project-level `opencode.json` in the working
directory redirects it, and the block has to be cloned whole from the user's own config: dropping
`npm` or `models` unregisters the provider.

## Proving a capture is genuine

Run it twice and diff `system[3]`. Everything but the values below should be byte for byte
identical.

| difference | why |
|---|---|
| scratchpad path | one uuid per session |
| memory directory | derived from the working directory |
| `gitStatus` block | tracks the repository state |
| `cc_version` suffix | a hash over the assembled prompt, so the above change it |

There is a second, sharper check. Compare a run the gateway rejected with a run that returned 200:
`system[3]` differs only in the working directory and the memory hash, while the tool definitions
and the `role:system` turn are identical. **What the upstream returns does not affect the request
already recorded** — the prompt is assembled locally and written to disk before it is forwarded.

## Reference runs

| run | harness | mode | result |
|---|---|---|---|
| `run_bc749535e248` | claude | interactive | 200 |
| `run_8e6d567d4ca4` | claude | print | 200 |
| `run_7a02fa0c8266` | claude | print | rejected by the gateway; request body still complete |
| `run_31102b8bde19` | codex | exec | 200 |
| `run_6e92b193d46d` | opencode | run | 200 |
