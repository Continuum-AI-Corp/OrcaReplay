#!/usr/bin/env node
/**
 * One command to capture an agent harness's system prompt.
 *
 *   node capture/capture.mjs claude                    # interactive, model from settings
 *   node capture/capture.mjs claude --model claude-fable-5-1
 *   node capture/capture.mjs claude --print            # the cheaper -p variant
 *   node capture/capture.mjs codex --model gpt-5.6-sol
 *   node capture/capture.mjs --index                   # rebuild capture/index.json only
 *
 * The prompt lands in `prompt/<model>-system-prompt.md`; the request body, tool definitions,
 * metadata and raw run land in `capture/<model>/`.
 *
 * Why this is not just `orca record`: the interactive prompt is a different, larger prompt than
 * the non-interactive one, and a harness only assembles it when stdin is a real console. A pipe is
 * not, so `orca record claude` always captures the -p variant. Interactive mode here holds a proxy
 * open with `orca attach`, then has PowerShell launch the agent in a console of its own.
 *
 * Everything written except capture/<model>/trace/ is scrubbed: paths, usernames, emails,
 * uuids, long hex runs and the configured gateway host become {{PLACEHOLDERS}}, and the run aborts
 * if anything identifying survives the pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Two roots on purpose. `prompt/` is the browsable collection and holds exactly one file per
// capture, the prompt itself; `capture/` holds the machinery and the evidence. The prompt text is
// written once, in `prompt/`, so the two directories cannot drift apart.
const CAPTURE_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = join(dirname(CAPTURE_DIR), 'prompt');
const BS = String.fromCharCode(92); // one literal backslash, spelled out so it survives editing
const SEP_CLASS = `[${BS}${BS}/]`; // regex source matching either path separator
const WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------- process plumbing

/** Escape a regex metacharacter run. */
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, (m) => BS + m);

/**
 * A regex matching one filesystem path with either separator, case-insensitively, because Windows
 * paths are case-insensitive and some harnesses lowercase them before printing.
 */
function pathRe(p, flags = 'gi') {
  // Split on separators first, then escape each segment. Escaping the whole path and swapping the
  // separators afterwards does not work: the character class inserted for the first separator
  // itself contains a backslash-slash pair, so the next pass splits the class it just wrote.
  return new RegExp(p.split(/[\\/]/).map(reEscape).join(SEP_CLASS), flags);
}

/** cmd.exe quoting. Node does not quote for you when `shell` is set, which splits any argument
 *  containing a space — the throwaway prompt, every time. */
const cmdQuote = (a) => (/[\s"^&|<>()%!]/.test(a) ? `"${a.replace(/"/g, `${BS}"`)}"` : a);

/** Run a real executable. `powershell.exe` is one, so no shell is involved and no quoting applies. */
function runExe(exe, args, opts = {}) {
  const r = spawnSync(exe, args, { encoding: 'utf8', ...opts });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\r/g, '') };
}

/**
 * How to invoke orca.
 *
 * `ORCA_BIN` pointing at a built `cli.js` runs a local checkout instead of whatever is on PATH,
 * which is what a capture needs while a fix is still in the working tree: the h2 interception the
 * Cursor profile depends on does not exist in a published build.
 */
function orcaCommand(args) {
  const bin = process.env.ORCA_BIN;
  if (bin === undefined) return { name: 'orca', args };
  return { name: process.execPath, args: [bin, ...args] };
}

/** Run a shim such as `orca.cmd`, which node cannot spawn without a shell. */
function runShim(name, args, opts = {}) {
  if (!WIN) return runExe(name, args, opts);
  const line = [name, ...args.map(cmdQuote)].join(' ');
  const r = spawnSync(process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', line], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    ...opts,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\r/g, '') };
}

function spawnShim(name, args, opts = {}) {
  if (!WIN) return spawn(name, args, opts);
  const line = [name, ...args.map(cmdQuote)].join(' ');
  return spawn(process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', line], {
    windowsVerbatimArguments: true,
    ...opts,
  });
}

const powershell = (script) =>
  runExe('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);

// ---------------------------------------------------------------------------- args

function parseArgs(argv) {
  const flags = {};
  let harness;
  const valued = new Set([
    'model',
    'upstream',
    'port',
    'cwd',
    'prompt',
    'timeout',
    'from-run',
    'dir',
    'retries',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      harness ??= a;
      continue;
    }
    const key = a.slice(2);
    flags[key] = valued.has(key) ? argv[++i] : true;
  }
  return { harness, flags };
}

const { harness, flags } = parseArgs(process.argv.slice(2));

const USAGE = `usage: node capture/capture.mjs <claude|codex|opencode|qwen|cursor> [options]

  --model <id>       model to capture. default: the harness's own default
  --print            claude only: capture the -p prompt instead of the interactive one
  --interactive      codex only: capture the TUI prompt instead of the exec one
  --upstream <url>   override where the proxy forwards. default: api.anthropic.com for
                     claude when an orca gateway is configured, otherwise untouched
  --port <n>         proxy port for interactive capture. default 46011
  --cwd <path>       directory to run the agent in. default: the current directory.
                     interactive claude needs a directory it already trusts
  --prompt <text>    the throwaway user turn. default: a one-word reply
  --timeout <sec>    how long to wait for the request. default 180
  --no-trace         delete the raw orca run instead of keeping it under
                     capture/<model>/trace/
  --retries <n>      how many extra attempts after a transient failure. default 2
  --allow-failed     file the capture even when the turn came back an error. the prompt
                     is still genuine; refused by default so a wrong --model cannot
                     quietly create a folder for a model that does not exist
  --index            rebuild capture/index.json and exit
  --from-run <dir>   file an orca run that already exists instead of capturing a new
                     one. the run directory is read in place and left where it is
  --dir <name>       folder name under capture/, when two harnesses serve the same
                     model and would otherwise land in the same one`;

// ---------------------------------------------------------------------------- harness profiles

const npmPrefix = () => join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm');
const npmRoot = () => join(npmPrefix(), 'node_modules');

/**
 * Each profile knows how to pull the prompt out of one wire dialect. `blocks` is what lands in
 * system-prompt.md; `context` is harness-injected material that is not system-role, kept in the
 * annotated file only so the shareable prompt file stays what its name says.
 */
/**
 * Pull the prompt out of an OpenAI-shaped request, either dialect.
 *
 * A harness picks one per model: a chat-completions body with the prompt in `messages`, or a
 * responses body with it in `input`. OpenCode uses both — `mimo-v2.5-free` the first,
 * `muse-spark-1.2-contributor-free` the second — and reading only `messages` finds nothing at all
 * in the second, so the capture fails while the prompt sits in the trace.
 */
function extractOpenAiShaped(body) {
  const blocks = [];
  const context = [];
  for (const m of [...(body.messages ?? []), ...(body.input ?? [])]) {
    if (m.type !== undefined && m.type !== 'message') continue;
    const text =
      typeof m.content === 'string'
        ? m.content
        : (Array.isArray(m.content) ? m.content : []).map((c) => c.text ?? '').join('');
    if (text === '') continue;
    if (m.role === 'system' || m.role === 'developer') {
      blocks.push({ label: `${m.role}[${blocks.length}]`, text });
    } else if (/^\s*<[a-z_]+[\s>]/.test(text)) {
      context.push({ label: 'context', text });
    }
  }
  const tools = body.tools ?? [];
  return {
    blocks,
    context,
    tools,
    toolNames: tools.map((x) => x.function?.name ?? x.name).filter(Boolean),
    meta: {
      dialect: body.input ? 'openai-responses' : 'openai-chat',
      temperature: body.temperature,
      max_tokens: body.max_tokens ?? body.max_completion_tokens,
    },
  };
}

/** A recorded body, whichever of the two forms orca stored it in. */
const BINARY_BODY_PREFIX = 'orca-base64:';
const recordedBytes = (body) =>
  typeof body === 'string' && body.startsWith(BINARY_BODY_PREFIX)
    ? Buffer.from(body.slice(BINARY_BODY_PREFIX.length), 'base64')
    : Buffer.from(String(body ?? ''), 'utf8');

/**
 * Split a Connect-protocol body into its messages.
 *
 * Five bytes of framing per message: one flag byte where bit 0 means the payload is compressed,
 * then a big-endian length. Cursor gzips the frames that carry the conversation.
 */
function connectFrames(buf) {
  const out = [];
  for (let off = 0; off + 5 <= buf.length;) {
    const flags = buf[off];
    const len = buf.readUInt32BE(off + 1);
    let body = buf.subarray(off + 5, Math.min(off + 5 + len, buf.length));
    if (flags & 1) {
      try {
        body = gunzipSync(body);
      } catch {
        /* keep it compressed and move on */
      }
    }
    out.push(body);
    off += 5 + len;
  }
  return out;
}

/**
 * Every `{"role": ...}` object in a string, matched by brace counting.
 *
 * The protobuf carries the conversation as JSON strings, and reading them out needs no schema --
 * which is the only reason this is tractable without Cursor's `.proto` files.
 */
function roleObjects(text) {
  const found = [];
  for (let i = text.indexOf('{"role"'); i !== -1; i = text.indexOf('{"role"', i)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let j = i;
    for (; j < text.length; j += 1) {
      const c = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === '{') depth += 1;
      else if (c === '}' && --depth === 0) {
        j += 1;
        break;
      }
    }
    try {
      found.push(JSON.parse(text.slice(i, j)));
    } catch {
      /* a frame cut mid-object */
    }
    i = j;
  }
  return found;
}

/** The gateway credential from `orca setup`, for a harness that has no store of its own. */
function orcaGatewayKey() {
  const path = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'orca',
    'config.json',
  );
  try {
    const g = JSON.parse(readFileSync(path, 'utf8')).gateway ?? {};
    return g.api_key ?? (g.api_key_env ? process.env[g.api_key_env] : undefined);
  } catch {
    return undefined;
  }
}

const PROFILES = {
  claude: {
    id: 'claude',
    adapter: 'claude',
    promptDir: 'CLAUDECODE',
    exe: () => join(npmRoot(), '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    defaultInteractive: true,
    trustKeyed: true,
    recordArgs: (model, prompt) => ['--', '-p', prompt, ...(model ? ['--model', model] : [])],
    consoleArgs: (model, prompt) => [...(model ? ['--model', model] : []), `"${prompt}"`],
    forceAnthropicUpstream: true,
    extract(body) {
      const blocks = [];
      const context = [];
      for (const s of body.system ?? []) {
        if (typeof s.text === 'string') {
          blocks.push({
            label: `system[${blocks.length}]`,
            text: s.text,
            cache: s.cache_control?.ttl ?? 'none',
          });
        }
      }
      for (const m of body.messages ?? []) {
        const parts = Array.isArray(m.content) ? m.content : [{ text: m.content }];
        for (const p of parts) {
          if (typeof p.text !== 'string') continue;
          if (m.role === 'system') blocks.push({ label: 'role:system', text: p.text });
          else if (p.text.includes('<system-reminder>'))
            context.push({ label: 'system-reminder', text: p.text });
        }
      }
      const tools = body.tools ?? [];
      const header = body.system?.[0]?.text ?? '';
      return {
        blocks,
        context,
        tools,
        toolNames: tools.map((t) => t.name),
        meta: {
          entrypoint: /cc_entrypoint=([\w-]+)/.exec(header)?.[1],
          harness_version: /cc_version=([\w.]+)/.exec(header)?.[1],
          thinking: body.thinking,
          output_config: body.output_config,
          max_tokens: body.max_tokens,
        },
      };
    },
  },

  codex: {
    id: 'codex',
    adapter: 'codex',
    promptDir: 'CODEX',
    // Codex ships a JS entry point rather than a binary, so the console is opened on the npm
    // shim; Start-Process gives `codex.cmd` a console just as readily as an executable.
    exe: () => join(npmPrefix(), 'codex.cmd'),
    defaultInteractive: false,
    recordArgs: (model, prompt) => [
      '--',
      'exec',
      '--skip-git-repo-check',
      ...(model ? ['--model', model] : []),
      prompt,
    ],
    consoleArgs: (model, prompt) => [...(model ? ['--model', model] : []), `"${prompt}"`],
    forceAnthropicUpstream: false,
    extract(body) {
      const blocks = [];
      const context = [];
      let tools = [];
      for (const item of body.input ?? []) {
        if (item.type === 'additional_tools') {
          tools = item.tools ?? [];
          continue;
        }
        if (item.type !== 'message') continue;
        const parts = Array.isArray(item.content) ? item.content : [{ text: item.content }];
        for (const p of parts) {
          if (typeof p.text !== 'string') continue;
          if (item.role === 'developer')
            blocks.push({ label: `developer[${blocks.length}]`, text: p.text });
          else if (/^\s*<[a-z_]+[\s>]/.test(p.text))
            context.push({ label: 'context', text: p.text });
        }
      }
      // Codex nests tools in namespaces, so the leaves are the tools and the branches are not.
      const names = [];
      const walk = (t) => {
        if (t.name && t.type !== 'namespace') names.push(t.name);
        (t.tools ?? []).forEach(walk);
      };
      tools.forEach(walk);
      return {
        blocks,
        context,
        tools,
        toolNames: names,
        meta: { reasoning: body.reasoning, text: body.text, store: body.store },
      };
    },
  },
  opencode: {
    id: 'opencode',
    adapter: 'opencode',
    promptDir: 'OPENCODE',
    defaultInteractive: false,

    /**
     * OpenCode is captured by decrypting its own origin rather than by moving it.
     *
     * Redirecting it does not work: the provider origin lives in `opencode.json`, not in an
     * environment variable, so `OPENAI_BASE_URL` leaves the run talking straight past the proxy.
     * Writing a project-level config with the proxy origin in it does redirect OpenCode when the
     * command is typed in a shell, and did not when the same file and command were launched from
     * here — the proxy recorded nothing at all. Rather than keep chasing that, this takes the route
     * orca built for an agent whose origin cannot be moved: `--tls-intercept` terminates the TLS
     * OpenCode established itself, at the socket, and the config is left alone.
     *
     * The models under the built-in `opencode` provider are the ones this reaches, several of them
     * free, which is also what makes iterating on the capture cost nothing. A provider pointed at a
     * plain-HTTP gateway of your own is neither redirected nor decrypted, and needs its own answer.
     */
    recordFlags: ['--tls-intercept', '--tls-hosts', '+opencode.ai,+*.opencode.ai'],
    defaultModel: 'opencode/mimo-v2.5-free',
    recordArgs: (model, prompt) => ['--', 'run', ...(model ? ['--model', model] : []), prompt],
    consoleArgs: (model, prompt) => ['run', ...(model ? ['--model', model] : []), `"${prompt}"`],
    forceAnthropicUpstream: false,

    extract: extractOpenAiShaped,
  },

  cursor: {
    id: 'cursor',
    adapter: 'exec',
    netOnly: true,
    promptDir: 'CURSOR',
    defaultInteractive: false,
    exe: () => join(process.env.LOCALAPPDATA ?? '', 'cursor-agent', 'cursor-agent.cmd'),
    forceAnthropicUpstream: false,

    /**
     * Cursor is the awkward one, and every part of that is a protocol fact rather than a choice.
     *
     * Its agent stream speaks HTTP/2 exclusively to a host of its own, so there is no base URL to
     * move and interception has to terminate h2 -- which orca could not do until the interceptor
     * learned to. The wire format is Connect over protobuf, so the body is bytes rather than JSON
     * and only survives a trace because a non-text body is now recorded as base64. And the prompt
     * is not in the request at all: the request carries the user's turn and the model settings,
     * and the server sends the composed conversation *back* in the response stream, gzipped inside
     * the protobuf. That is where this reads it from.
     *
     * `--trust` because the agent will not run non-interactively in a directory it has not been
     * trusted in, and unlike `--yolo` it grants nothing else.
     */
    recordFlags: ['--tls-intercept', '--tls-hosts', '+api2.cursor.sh,+*.cursor.sh'],
    defaultModel: 'auto',
    recordArgs: (model, prompt) => [
      '--',
      join(process.env.LOCALAPPDATA ?? '', 'cursor-agent', 'cursor-agent.cmd'),
      '-p',
      '--trust',
      ...(model ? ['--model', model] : []),
      prompt,
    ],
    consoleArgs: (model, prompt) => [
      '-p',
      '--trust',
      ...(model ? ['--model', model] : []),
      `"${prompt}"`,
    ],

    /** Not used: the prompt is read from the trace as a whole, by `extractFromRun` below. */
    extract: () => ({ blocks: [], context: [], tools: [], toolNames: [], meta: {} }),

    /**
     * Reads the run rather than one request, because the halves live in different messages: the
     * model id is in the request and the conversation is in the response.
     */
    extractFromRun(dir) {
      const events = readEvents(dir);
      const blobText = (payload) => {
        if (payload === undefined) return undefined;
        if (typeof payload === 'string') return payload;
        if (!payload.$blob) return undefined;
        const sha = payload.$blob.replace('sha256:', '');
        return JSON.parse(readFileSync(join(dir, 'blobs', sha.slice(0, 2), sha), 'utf8'));
      };

      const agentEvents = events.filter((e) => String(e.attrs?.host ?? '').includes('agentn'));
      if (agentEvents.length === 0) {
        throw new Error(
          'no Cursor agent stream in the run.\n' +
            '  the conversation host is reached over HTTP/2, so the interceptor has to speak h2;\n' +
            '  check that --tls-hosts covers *.cursor.sh and that this orca build has the h2 path.',
        );
      }

      const messages = [];
      let model;
      let serverError;
      for (const e of agentEvents) {
        const body = blobText(e.payload);
        if (body === undefined) continue;
        for (const frame of connectFrames(recordedBytes(body))) {
          const text = frame.toString('utf8');
          messages.push(...roleObjects(text));
          // Which model actually answered, from the response.
          //
          // Not from the request: with `auto` the request carries the router's whole candidate
          // set -- nine of them on one run, grok-4.6 first -- so reading a name out of it reports
          // a candidate and files the capture under the wrong model. The response states the
          // choice once, in `providerOptions`.
          model ??= /"modelName":"(?:cursor-)?([a-zA-Z0-9.\-]+)"/.exec(text)?.[1];
          // The stream carries its own errors as JSON, and they explain an empty capture far
          // better than the absence of a system message does. `resource_exhausted` is what a
          // model the account has no quota for looks like.
          serverError ??= /"error":\{"code":"([a-z_]+)"/.exec(text)?.[1];
        }
      }

      const system = messages.filter((m) => m.role === 'system');
      if (system.length === 0) {
        throw new Error(
          serverError
            ? `Cursor answered ${serverError} rather than running the turn, so there is no prompt` +
                ' to read.\n  resource_exhausted means the account has no quota left for this' +
                ' model; try another, or `auto`.'
            : 'the Cursor agent stream carried no system message',
        );
      }
      const blocks = system.map((m, i) => ({ label: `system[${i}]`, text: String(m.content) }));
      const context = messages
        .filter((m) => m.role !== 'system')
        .map((m, i) => ({
          label: `${m.role}[${i}]`,
          text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }));

      // Cursor declares no tool schemas at all. The prompt describes two meta-tools --
      // `GetDynamicTools` and `CallDynamicTool` -- and names the rest as an attribute on a
      // namespace element, leaving the schemas server-side. So the names come from there, and a
      // count of zero would have been the wrong answer rather than a missing one.
      const contextText = context.map((c) => c.text).join('\n');
      const named = [...contextText.matchAll(/<namespace\s[^>]*tools="([^"]+)"/g)]
        .flatMap((m) => m[1].split(',').map((s) => s.trim()))
        .filter(Boolean);
      const meta = [...contextText.matchAll(/`(GetDynamicTools|CallDynamicTool)`/g)].map(
        (m) => m[1],
      );
      const toolNames = [...new Set([...meta, ...named])];

      // The router's candidates, from the request. Worth keeping: it is the only place that says
      // what `auto` was choosing between.
      const requestText = agentEvents
        .filter((e) => e.type === 'net.request' || e.type === 'model.request')
        .map((e) => blobText(e.payload))
        .filter((b) => b !== undefined)
        .flatMap((b) => connectFrames(recordedBytes(b)).map((f) => f.toString('utf8')))
        .join('\n');
      const candidates = [
        ...new Set(
          [
            ...requestText.matchAll(
              /(?:claude|gpt|gemini|grok|composer)-[a-z0-9]+(?:[.-][a-z0-9]+)*/gi,
            ),
          ]
            .map((m) => m[0])
            // The working directory reaches the request as a path, and a slug beginning `claude-`
            // matches the same shape. Real ids are short.
            .filter((id) => id.length <= 24),
        ),
      ].sort();

      return {
        model,
        blocks,
        context,
        tools: [],
        toolNames,
        meta: { wire: 'connect+proto', router_candidates: candidates },
      };
    },
  },

  qwen: {
    id: 'qwen',
    adapter: 'generic-openai',
    promptDir: 'QWENCODE',
    defaultInteractive: false,
    recordArgs: (_model, prompt) => ['--', 'qwen', '-p', prompt],
    consoleArgs: (_model, prompt) => ['-p', `"${prompt}"`],
    forceAnthropicUpstream: false,

    /**
     * Qwen Code reads its OpenAI-compatible endpoint straight from the environment, which is the
     * one thing `generic-openai` redirects, so nothing clever is needed — no config to rewrite and
     * no TLS to terminate. What it does need is the key and the model name, since it has no
     * credential store of its own: `OPENAI_API_KEY` if the environment already carries one,
     * otherwise the gateway key `orca setup` stored, which is where the traffic is going anyway.
     */
    prepare(_cwd, model) {
      const key = process.env.OPENAI_API_KEY ?? orcaGatewayKey();
      if (!key) throw new Error('qwen needs OPENAI_API_KEY set, or an orca gateway with a key');
      if (!model) throw new Error('qwen needs --model: the id its endpoint serves');
      return { env: { OPENAI_API_KEY: key, OPENAI_MODEL: model }, restore() {} };
    },

    extract: extractOpenAiShaped,
  },
};

// ---------------------------------------------------------------------------- scrubbing

function gitValue(cwd, key) {
  const r = spawnSync('git', ['config', '--get', key], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function orcaGatewayHost() {
  const p = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'orca', 'config.json');
  try {
    const url = JSON.parse(readFileSync(p, 'utf8')).gateway?.url;
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
}

/** How Claude Code slugs a working directory for its per-project state folders. */
const projectSlug = (cwd) => cwd.replace(/[:\\/]/g, '-').replace(/_/g, '-');

/**
 * Ordered, because the rules overlap: the memory directory sits inside the home directory, so a
 * bare home rule applied first would leave a half-scrubbed path behind.
 */
function buildScrubber(cwd) {
  const home = homedir();
  const user = userInfo().username;
  const gitName = gitValue(cwd, 'user.name');
  const gitEmail = gitValue(cwd, 'user.email');
  const gateway = orcaGatewayHost();

  const rules = [
    [/Recent commits:\n(?:[0-9a-f]{7,40} [^\n]*\n?)+/g, 'Recent commits:\n{{RECENT_COMMITS}}\n'],
    [pathRe(join(home, '.claude', 'projects')), '{{CLAUDE_PROJECTS}}'],
    [pathRe(join(home, '.codex')), '{{CODEX_HOME}}'],
    [pathRe(join(home, '.claude')), '{{CLAUDE_HOME}}'],
    [pathRe(cwd), '{{CWD}}'],
    [new RegExp(reEscape(projectSlug(cwd)), 'gi'), '{{PROJECT_SLUG}}'],
    [pathRe(tmpdir()), '{{TMP}}'],
    [pathRe(home), '{{HOME}}'],
  ];
  if (gitName)
    rules.push([new RegExp(`Git user: ${reEscape(gitName)}`, 'g'), 'Git user: {{GIT_USER}}']);
  if (gitEmail) rules.push([new RegExp(reEscape(gitEmail), 'gi'), '{{EMAIL}}']);
  if (gateway) rules.push([new RegExp(reEscape(gateway), 'g'), '{{GATEWAY}}']);
  rules.push(
    [/(OS Version: [^\n]*?)\d+\.\d+\.\d{4,}/g, '$1{{OS_BUILD}}'],
    [/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, '{{EMAIL}}'],
    // Lookarounds rather than \b: an id is often prefixed, as in `msg_01a06161-...`, and `_` is a
    // word character, so \b never matches between the two and the whole rule silently misses.
    [
      /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi,
      '{{UUID}}',
    ],
    [/(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi, '{{HEX}}'],
    [new RegExp(`\\b${reEscape(user)}\\b`, 'gi'), '{{USER}}'],
  );

  const scrub = (s) => rules.reduce((acc, [re, to]) => acc.replace(re, to), s);

  /** Anything surviving the pass means a rule is wrong, and silence would be the real bug. */
  const audit = (s) => {
    const checks = {
      home: pathRe(home),
      username: new RegExp(`\\b${reEscape(user)}\\b`, 'gi'),
      email: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g,
      uuid: /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi,
      long_hex: /(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi,
      ipv4: /\b(?!127\.0\.0\.1|0\.0\.0\.0)\d{1,3}(?:\.\d{1,3}){3}\b/g,
    };
    if (gitName) checks.git_user = new RegExp(reEscape(gitName), 'g');
    const found = [];
    for (const [k, re] of Object.entries(checks)) {
      const m = s.match(re);
      if (m) found.push(`${k} x${m.length} (${m[0]})`);
    }
    return found;
  };

  const scrubJson = (v) =>
    typeof v === 'string'
      ? scrub(v)
      : Array.isArray(v)
        ? v.map(scrubJson)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubJson(x)]))
          : v;

  return {
    scrub,
    scrubJson,
    audit,
    inputs: {
      home: true,
      user: true,
      git_user: Boolean(gitName),
      git_email: Boolean(gitEmail),
      gateway: Boolean(gateway),
    },
  };
}

// ---------------------------------------------------------------------------- workspace trust

/**
 * Claude Code will not start interactively in a directory it has not been trusted in, and the
 * dialog it shows instead has nobody to answer it here — the console it opens in is unattended, so
 * the capture just waits out its timeout.
 *
 * Trust is one boolean in `~/.claude.json`, keyed by the working directory with forward slashes.
 * `-p` never asks, which is why non-interactive captures work in a scratch directory.
 *
 * Checked but never written. Setting the flag from here would work, and it was a mistake to offer:
 * it makes capturing in a throwaway directory the path of least resistance, and the working
 * directory is part of the prompt. A capture in a non-repository loses the whole `gitStatus` block
 * and describes an environment the user never works in. Refusing early instead pushes the capture
 * into a directory that is actually representative.
 *
 * `--dangerously-skip-permissions` is not a way around this either: it adds a paragraph about the
 * active permission mode to the injected system turn, so it changes the prompt being captured.
 */
const claudeConfigPath = () => join(homedir(), '.claude.json');
const trustKey = (cwd) => resolve(cwd).split(BS).join('/');

function trustState(cwd) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(claudeConfigPath(), 'utf8'));
  } catch {
    return {};
  }
  const want = trustKey(cwd).toLowerCase();
  const key = Object.keys(cfg.projects ?? {}).find(
    (k) => k.split(BS).join('/').toLowerCase() === want,
  );
  return { key, trusted: key !== undefined && cfg.projects[key].hasTrustDialogAccepted === true };
}

// ---------------------------------------------------------------------------- trace reading

const runDir = (cwd, runId) => join(cwd, '.orca', 'runs', runId);

const readEvents = (dir) =>
  readFileSync(join(dir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function readBlob(dir, ref) {
  const sha = ref.replace('sha256:', '');
  let v = JSON.parse(readFileSync(join(dir, 'blobs', sha.slice(0, 2), sha), 'utf8'));
  if (typeof v === 'string') v = JSON.parse(v); // orca stores request bodies double-encoded
  return v;
}

/**
 * The recorded request that carries the agent's own prompt.
 *
 * Not the largest: later turns of a Claude Code run load deferred tools, so the biggest request in
 * a trace describes a state the first turn was never in. Not the first with a prompt in it either
 * — a harness opens with side calls that carry a full `system[]` of their own. Claude Code's title
 * generator is the trap here: four system blocks, a naming spec, and no tools. The agent turn is
 * the one that ships the tool definitions, so that is what identifies it, with the looser test
 * kept only for a trace where nothing declares tools at all.
 */
function pickPromptRequest(dir, profile) {
  let fallback;
  for (const e of readEvents(dir)) {
    if (e.type !== 'model.request' || !e.payload?.$blob) continue;
    let body;
    try {
      body = readBlob(dir, e.payload.$blob);
    } catch {
      continue;
    }
    const got = profile.extract(body);
    if (got.blocks.length === 0) continue;
    if (got.toolNames.length > 0) return { event: e, body, got };
    fallback ??= { event: e, body, got };
  }
  return fallback;
}

/** True once the trace holds the request we want, so the poll loop knows to stop. */
const hasPromptRequest = (dir, profile) => {
  const got = pickPromptRequest(dir, profile);
  return got && got.got.toolNames.length > 0 ? got : undefined;
};

/**
 * What came back for one specific request: the prefix the server charged for, or the error instead.
 *
 * Read off the response to that request rather than the first plausible number in the trace, since
 * the side calls carry usage blocks of their own. The error case matters as much as the token
 * count: a turn can come back `overloaded_error` inside a 200 stream, and the capture is still
 * good — the prompt travels in the request — but reporting nothing would let a failed turn look
 * like a clean one.
 */
const isTransientFailure = ({ response_error: kind, response_status: status }) =>
  (status !== undefined && status >= 500) ||
  /overload|rate_?limit|server_error|unavailable|timeout|internal/i.test(kind ?? '');

function responseFacts(dir, seq) {
  for (const e of readEvents(dir)) {
    if (e.type !== 'model.response' || e.seq < seq) continue;
    let text = typeof e.payload === 'string' ? e.payload : undefined;
    if (!text && e.payload?.$blob) {
      const sha = e.payload.$blob.replace('sha256:', '');
      try {
        text = readFileSync(join(dir, 'blobs', sha.slice(0, 2), sha), 'utf8');
      } catch {
        continue;
      }
    }
    const m = /"usage":\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/.exec(text ?? '');
    if (m) {
      try {
        const u = JSON.parse(m[0].slice('"usage":'.length));
        const prefix =
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.input_tokens ?? 0) +
          (u.prompt_tokens ?? 0);
        if (prefix > 0) return { prefix_tokens: prefix, usage: u };
      } catch {
        /* fall through to the error check */
      }
    }
    const err =
      /"error":\s*\{[^{}]*"type":\s*"([\w-]+)"/.exec(text ?? '') ??
      /"type":\s*"([\w]*error[\w]*)"/.exec(text ?? '');
    if (err) return { response_error: err[1], response_status: e.attrs.status };
    return {};
  }
  return {};
}

// ---------------------------------------------------------------------------- capture modes

function upstreamArgs(profile) {
  if (typeof flags.upstream === 'string') {
    return ['--upstream-anthropic', flags.upstream, '--upstream-openai', flags.upstream];
  }
  // A configured gateway captures every anthropic call, and a third-party router usually does not
  // serve the model, which surfaces as `400 unknown provider`. Codex is the opposite case: its own
  // config points at that gateway, so leaving it alone is what makes the model resolve.
  if (profile.forceAnthropicUpstream && orcaGatewayHost()) {
    return ['--upstream-anthropic', 'https://api.anthropic.com'];
  }
  return [];
}

/** Non-interactive: one `orca record`, which exits on its own when the agent does. */
function captureRecorded(profile, cwd, model, prompt) {
  // No port here: this path lets orca stand the proxy up and pick one. Only the held-open proxy
  // path knows a port in advance, and only a harness whose config has to name it cares.
  const prepared = profile.prepare?.(cwd, model);
  try {
    const args = [
      'record',
      profile.adapter,
      '--no-fs',
      '--no-shell',
      ...(profile.recordFlags ?? []),
      ...upstreamArgs(profile),
      ...profile.recordArgs(model, prompt),
    ];
    console.log(`  orca ${args.join(' ')}`);
    const cmd = orcaCommand(args);
    const { out } = runShim(cmd.name, cmd.args, {
      cwd,
      timeout: Number(flags.timeout ?? 300) * 1000,
      env: { ...process.env, ...(prepared?.env ?? {}) },
    });
    const runId = /run=(run_[0-9a-f]+)/.exec(out)?.[1];
    if (!runId) throw new Error(`orca record produced no run id.\n${out.trim()}`);
    // `capture.empty` counts *model* exchanges, and a harness captured by decrypting its own
    // protocol has none -- Cursor's traffic is recorded as net exchanges instead. Treating the
    // warning as fatal there rejected a run that had the prompt in it.
    if (!profile.netOnly && /capture\.empty/.test(out)) {
      throw new Error(`the agent never called the proxy.\n${out.trim()}`);
    }
    return runId;
  } finally {
    prepared?.restore();
  }
}

const killPort = (port) =>
  powershell(
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; ` +
      `if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }`,
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Interactive: hold the proxy open, then let PowerShell start the agent in a console of its own.
 *
 * `Start-Process` without `-NoNewWindow` is the whole trick — Windows hands a console application
 * a real console, so `process.stdin.isTTY` is true and the harness assembles its interactive
 * prompt. A pty shim is the obvious alternative and does not work: winpty asserts on
 * `cols > 0 && rows > 0`, which it cannot learn from a pipe. Node's own `detached` is no help
 * either, since on Windows it means DETACHED_PROCESS — no console at all.
 */
/**
 * Start the agent in a console of its own. `Start-Process` without `-NoNewWindow` is the whole
 * trick: Windows hands a console application a real console, so `process.stdin.isTTY` is true and
 * the harness assembles its interactive prompt. A pty shim does not work here — winpty asserts on
 * `cols > 0 && rows > 0`, which it cannot learn from a pipe — and node's `detached` means
 * DETACHED_PROCESS on Windows, so no console at all.
 */
function consoleLauncher(profile, cwd, model, prompt) {
  return (port, prepared) => {
    const exe = profile.exe();
    if (!existsSync(exe)) throw new Error(`agent executable not found: ${exe}`);
    // A nested session inherits these and registers as a child, which changes the prompt.
    const strip = [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_MESSAGING_SOCKET',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_PID',
      'CLAUDE_EFFORT',
      'CLAUDE_CODE_EXECPATH',
      'AI_AGENT',
    ];
    const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const argList = profile.consoleArgs(model, prompt).map(psQuote).join(',');
    const script = [
      `foreach ($n in @(${strip.map(psQuote).join(',')})) { if (Test-Path "Env:\$n") { Remove-Item "Env:\$n" } }`,
      ...Object.entries(prepared?.env ?? {}).map(([k, v]) => `$env:${k} = ${psQuote(v)}`),
      `$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:${port}'`,
      `$env:OPENAI_BASE_URL = 'http://127.0.0.1:${port}/v1'`,
      `$p = Start-Process -FilePath ${psQuote(exe)} -WindowStyle Minimized -PassThru -WorkingDirectory ${psQuote(cwd)} -ArgumentList @(${argList})`,
      `Write-Output "PID=$($p.Id)"`,
    ].join('; ');
    const launched = powershell(script);
    const pid = /PID=(\d+)/.exec(launched.out)?.[1];
    if (!pid) throw new Error(`could not launch the agent in a console.\n${launched.out.trim()}`);
    console.log(`  launched pid=${pid} in its own console`);
    return {
      stop: () => powershell(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`),
    };
  };
}

/**
 * Start the agent as an ordinary child, for a harness that needs no terminal.
 *
 * Used instead of `orca record` where the adapter's environment does not reach the agent: OpenCode
 * answered from the gateway with the proxy set and left an empty trace, and the same launch under
 * a held-open proxy records fine. Holding the proxy ourselves also fixes the port before the
 * agent's config is written, which is what makes the `{env:...}` indirection in that config work.
 */
function shimLauncher(profile, cwd, model, prompt) {
  return (port, prepared) => {
    const args = profile.recordArgs(model, prompt).filter((a) => a !== '--');
    console.log(`  ${profile.adapter} ${args.join(' ')}`);
    const r = runShim(profile.adapter, args, {
      cwd,
      timeout: Number(flags.timeout ?? 180) * 1000,
      // No base-URL variables when the harness was redirected through its own config: OpenCode
      // lets an environment variable win over the config value, and setting both left it talking
      // to the gateway while the proxy recorded nothing. Whoever redirected the agent owns the
      // origin, and only one of them may.
      env: prepared
        ? { ...process.env, ...prepared.env }
        : {
            ...process.env,
            OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          },
    });
    // Kept whole: when the trace comes back empty the agent's own output is the only evidence of
    // why, and a tail line is usually just an ANSI reset.
    const lines = r.out
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (const l of lines.slice(-3)) console.log(`  ${l.slice(0, 100)}`);
    return { stop: () => undefined, output: lines };
  };
}

async function captureWithProxy(profile, cwd, model, prompt, launch) {
  if (profile.trustKeyed && !trustState(cwd).trusted) {
    throw new Error(
      `${profile.id} has not been trusted in ${cwd}, so it would stop on the trust dialog.\n` +
        '  start it there once by hand and accept, then run this again.\n' +
        '  capture in a directory you actually work in: the working directory is part of the\n' +
        '  prompt, and a non-repository loses the gitStatus block entirely.',
    );
  }
  const port = Number(flags.port ?? 46011);
  const deadline = Date.now() + Number(flags.timeout ?? 180) * 1000;
  killPort(port);

  const attachArgs = [
    'attach',
    '--for',
    profile.adapter,
    '--port',
    String(port),
    ...upstreamArgs(profile),
  ];
  console.log(`  orca ${attachArgs.join(' ')}`);
  const attachCmd = orcaCommand(attachArgs);
  const attach = spawnShim(attachCmd.name, attachCmd.args, { cwd });
  let attachOut = '';
  attach.stdout?.on('data', (d) => {
    attachOut += d;
  });
  attach.stderr?.on('data', (d) => {
    attachOut += d;
  });

  try {
    let runId;
    while (!runId && Date.now() < deadline) {
      runId = /attached run=(run_[0-9a-f]+)/.exec(attachOut)?.[1];
      if (!runId) await sleep(300);
    }
    if (!runId) throw new Error(`orca attach never reported a run id.\n${attachOut.trim()}`);

    const prepared = profile.prepare?.(cwd, model, port);
    let running;
    try {
      running = launch(port, prepared);
    } catch (err) {
      prepared?.restore();
      throw err;
    }

    try {
      const dir = runDir(cwd, runId);
      let found;
      while (!found && Date.now() < deadline) {
        if (existsSync(join(dir, 'events.jsonl'))) {
          try {
            found = hasPromptRequest(dir, profile);
          } catch {
            /* mid-write, retry */
          }
        }
        if (!found) await sleep(1000);
      }
      if (!found) {
        const said = running.output?.length
          ? `\n  the agent said:\n${running.output.map((l) => `    ${l.slice(0, 120)}`).join('\n')}`
          : '';
        const hint =
          profile.failureHint ??
          `  if the agent stopped on a trust dialog, start it once in ${cwd} by hand,\n` +
            '  or pass --cwd with a directory it already trusts.';
        throw new Error(`no prompt-carrying request arrived within the timeout.\n${hint}${said}`);
      }
      console.log(
        `  captured seq=${found.event.seq} tools=${found.got.toolNames.length} bytes=${found.event.payload.bytes}`,
      );
      return runId;
    } finally {
      running.stop();
      prepared?.restore();
    }
  } finally {
    attach.kill();
    await sleep(600);
    killPort(port); // killing the shim does not reach the node process behind it
  }
}

// ---------------------------------------------------------------------------- writing

function writeCapture(profile, cwd, runId, interactive, dirOverride) {
  const dir = dirOverride ?? runDir(cwd, runId);
  // A harness whose prompt is spread across a stream reads the run, not one request.
  const found = profile.extractFromRun
    ? { body: {}, got: profile.extractFromRun(dir), event: { seq: 0, payload: { bytes: 0 } } }
    : pickPromptRequest(dir, profile);
  if (!found) throw new Error(`run ${runId} holds no prompt-carrying request`);
  const { body, got, event } = found;

  // A request whose turn came back an error still holds a real prompt, and for a transient
  // overload that is worth keeping. But a mistyped model id fails the same way, and filing it
  // would put a folder and an index row under a model that does not exist. Refusing by default
  // and naming the error is the honest split; a genuinely wanted failed capture says so.
  const facts = responseFacts(dir, event.seq);
  if (facts.response_error && !flags['allow-failed']) {
    const err = new Error(
      `the captured turn came back ${facts.response_error}` +
        `${facts.response_status ? ` (status ${facts.response_status})` : ''}, so nothing was filed.\n` +
        '  pass --allow-failed to keep the capture regardless; the prompt itself is genuine.',
    );
    // Worth separating, because the two failures want opposite handling. A 4xx means the request
    // was wrong -- a mistyped model, a missing credential -- and filing it would create a folder
    // for a model that does not exist. A 5xx or an overload is the free tier being busy, and the
    // prompt in that request is as good as any other, so the answer is to run it again.
    err.transient = isTransientFailure(facts);
    throw err;
  }

  const model = got.model ?? body.model ?? 'unknown-model';
  // One folder per model, as asked — but print and interactive are two different prompts for the
  // same model, so the non-default mode gets a suffix rather than overwriting the canonical one.
  const dirName =
    typeof flags.dir === 'string'
      ? flags.dir
      : interactive === profile.defaultInteractive
        ? model
        : `${model}.${interactive ? 'interactive' : 'print'}`;
  const dest = join(CAPTURE_DIR, dirName);

  // A model id does not identify a capture on its own: two harnesses can serve the same model, and
  // filing the second one over the first destroys it silently. Learned the hard way — opencode and
  // codex both run gpt-5.6-sol.
  const existingMeta = join(dest, `${dirName.replace(/\./g, '-')}-meta.json`);
  if (existsSync(existingMeta)) {
    try {
      const prev = JSON.parse(readFileSync(existingMeta, 'utf8'));
      if (prev.harness && prev.harness !== profile.id) {
        throw new Error(
          `capture/${dirName} already holds a ${prev.harness} capture of ${prev.model}.\n` +
            `  pass --dir ${profile.id}-${model} to file this one beside it.`,
        );
      }
    } catch (err) {
      if (err instanceof SyntaxError === false) throw err;
    }
  }

  mkdirSync(dest, { recursive: true });

  // Every file carries the folder's name, so a file pulled out on its own still says which model
  // and which mode it came from. `.` would read as a second extension, hence the dash.
  const slug = dirName.replace(/\./g, '-');
  const file = (suffix) => join(dest, `${slug}-${suffix}`);

  const { scrub, scrubJson, audit, inputs } = buildScrubber(cwd);

  const promptText = `${got.blocks.map((b) => scrub(b.text.replace(/^\n+|\n+$/g, ''))).join('\n\n')}\n`;
  const leaks = audit(promptText);
  if (leaks.length > 0)
    throw new Error(`scrubbing left identifying data behind: ${leaks.join('; ')}`);

  const annotated = `${[...got.blocks, ...got.context]
    .map(
      (b) =>
        `===== ${b.label} · ${b.text.length} chars${b.cache ? ` · cache=${b.cache}` : ''} =====\n${scrub(b.text)}`,
    )
    .join('\n\n')}\n`;

  const meta = {
    model,
    harness: profile.id,
    mode: interactive ? 'interactive' : 'non-interactive',
    captured_at: new Date().toISOString(),
    orca_run: runId,
    orca_version: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).orca_version,
    ...got.meta,
    // Every figure here describes the prompt as sent. Scrubbing shortens the text a little, so
    // the file on disk is a few hundred characters smaller; mixing the two made the block sizes
    // fail to add up to the total.
    sizes: {
      prompt_chars: got.blocks.reduce((a, b) => a + b.text.length, 0),
      prompt_file_chars: promptText.length,
      blocks: got.blocks.map((b) => ({ label: b.label, chars: b.text.length })),
      context_chars: got.context.reduce((a, c) => a + c.text.length, 0),
      tools: got.toolNames.length,
      tools_bytes: JSON.stringify(got.tools).length,
      request_bytes: event.payload?.bytes ?? 0,
    },
    ...facts,
    tool_names: got.toolNames,
    scrubbed_with: inputs,
  };

  meta.dir_slug = slug;
  // The capture folder may be disambiguated by hand (--dir) when two harnesses serve one model.
  // Under prompt/ the harness folder already does that, so the file is named for the model alone.
  meta.prompt_slug =
    `${model}${interactive === profile.defaultInteractive ? '' : interactive ? '-interactive' : '-print'}`
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/\./g, '-');
  meta.prompt_dir = profile.promptDir ?? profile.id.toUpperCase();
  meta.prompt_file = `prompt/${meta.prompt_dir}/${meta.prompt_slug}-system-prompt.md`;
  meta.regenerate =
    `node capture/capture.mjs ${profile.id} --model ${model}` +
    (interactive === profile.defaultInteractive ? '' : interactive ? ' --interactive' : ' --print');

  // Two copies on purpose: the capture folder stays self-contained, and `prompt/` stays a flat
  // collection you can read without walking into subdirectories. The capture-side file is the
  // source and `mirrorPrompts()` repairs the other from it, so a hand edit to one cannot survive
  // unnoticed.
  writeFileSync(file('system-prompt.md'), promptText, 'utf8');
  const mirrorPath = join(PROMPT_DIR, meta.prompt_dir, `${meta.prompt_slug}-system-prompt.md`);
  mkdirSync(dirname(mirrorPath), { recursive: true });
  writeFileSync(mirrorPath, promptText, 'utf8');
  writeFileSync(file('prompt-annotated.txt'), annotated, 'utf8');
  writeFileSync(file('request.json'), JSON.stringify(scrubJson(body), null, 2), 'utf8');
  writeFileSync(file('tools.json'), JSON.stringify(scrubJson(got.tools), null, 2), 'utf8');
  writeFileSync(file('meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  writeFileSync(join(dest, 'README.md'), folderReadme(meta), 'utf8');

  // An existing run belongs to whoever made it: read in place, never moved or deleted.
  if (dirOverride) return { dest, meta };

  // The stale-trace case is why this runs either way: a folder that keeps last run's trace while
  // meta.json names this one describes two different runs at once.
  const traceDest = join(dest, 'trace');
  rmSync(traceDest, { recursive: true, force: true });
  if (flags['no-trace']) {
    rmSync(dir, { recursive: true, force: true });
  } else {
    // The capture directory and prompt/ are routinely on different drives, and rename cannot
    // cross one. Copy-then-delete is the only move that works in both cases.
    try {
      renameSync(dir, traceDest);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      cpSync(dir, traceDest, { recursive: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Either way the run has left the capture directory, so orca's scaffolding there is dead.
  try {
    if (readdirSync(join(cwd, '.orca', 'runs')).length === 0) {
      rmSync(join(cwd, '.orca'), { recursive: true, force: true });
    }
  } catch {
    /* someone else's .orca, leave it */
  }

  return { dest, meta };
}

/**
 * A folder's README, derived from its own meta.json so `--index` can refresh it in place after a
 * rename rather than letting the file table drift out of date.
 */
function folderReadme(meta) {
  const slug = meta.dir_slug;
  return [
    `# ${meta.model}`,
    '',
    `${meta.harness}, ${meta.mode}${meta.entrypoint ? ` (\`cc_entrypoint=${meta.entrypoint}\`)` : ''}, captured ${meta.captured_at.slice(0, 10)}.`,
    '',
    '| file | scrubbed | what |',
    '|---|---|---|',
    `| \`${slug}-system-prompt.md\` | yes | the prompt on its own, nothing else |`,
    `| \`${slug}-prompt-annotated.txt\` | yes | same text with block boundaries and char counts |`,
    `| \`${slug}-request.json\` | yes | the whole request body as sent |`,
    `| \`${slug}-tools.json\` | yes | tool definitions |`,
    `| \`${slug}-meta.json\` | n/a | run id, sizes, token counts, tool names |`,
    '| `trace/` | **no** | the raw orca run. holds account and session ids |',
    '',
    `Mirrored to \`../${meta.prompt_file}\`. This copy is the source; \`--index\` repairs the other from it.`,
    '',
    `Regenerate with \`${meta.regenerate}\`.`,
    '',
  ].join('\n');
}

/**
 * Keep `prompt/` in step with the capture folders.
 *
 * Two copies of one text is a drift risk, so it gets checked rather than trusted: the capture-side
 * file is the source, and a mirror that is missing or different is rewritten from it. Reported, not
 * silent, because a difference means someone edited a generated file.
 */
function mirrorPrompts(metas) {
  const repaired = [];
  for (const m of metas) {
    const src = join(CAPTURE_DIR, m.dir_name, `${m.dir_slug}-system-prompt.md`);
    if (!existsSync(src)) continue;
    if (!m.prompt_dir || !m.prompt_slug) continue;
    const dst = join(PROMPT_DIR, m.prompt_dir, `${m.prompt_slug}-system-prompt.md`);
    const want = readFileSync(src, 'utf8');
    const have = existsSync(dst) ? readFileSync(dst, 'utf8') : undefined;
    if (have === want) continue;
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, want, 'utf8');
    repaired.push(
      `${m.dir_slug}: ${have === undefined ? 'mirror was missing' : 'mirror differed'}`,
    );
  }
  return repaired;
}

function writeIndex() {
  const rows = readdirSync(CAPTURE_DIR, { withFileTypes: true })
    .map((d) => {
      if (!d.isDirectory()) return undefined;
      const metaFile = join(CAPTURE_DIR, d.name, `${d.name.replace(/\./g, '-')}-meta.json`);
      return existsSync(metaFile) ? { name: d.name, metaFile } : undefined;
    })
    .filter(Boolean)
    .map((d) => {
      const m = JSON.parse(readFileSync(d.metaFile, 'utf8'));
      if (m.dir_slug && m.regenerate) {
        writeFileSync(join(CAPTURE_DIR, d.name, 'README.md'), folderReadme(m), 'utf8');
      }
      return {
        model: m.model,
        harness: m.harness,
        mode: m.mode,
        captured_at: m.captured_at,
        prompt_chars: m.sizes?.prompt_chars,
        tools: m.sizes?.tools,
        request_bytes: m.sizes?.request_bytes,
        prefix_tokens: m.prefix_tokens,
        dir: `capture/${d.name}`,
        prompt_file: m.prompt_file,
        dir_name: d.name,
        dir_slug: m.dir_slug,
        prompt_dir: m.prompt_dir,
        prompt_slug: m.prompt_slug,
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
  const repaired = mirrorPrompts(rows);
  // dir_name and dir_slug are plumbing for the mirror, not part of the published index.
  const published = rows.map(({ dir_name, dir_slug, prompt_dir, prompt_slug, ...rest }) => rest);
  writeFileSync(join(CAPTURE_DIR, 'index.json'), JSON.stringify(published, null, 2), 'utf8');
  return { rows: published, repaired };
}

// ---------------------------------------------------------------------------- main

if (flags.index) {
  const { rows, repaired } = writeIndex();
  console.log(`index.json: ${rows.length} model${rows.length === 1 ? '' : 's'}`);
  for (const r of repaired) console.log(`  mirrored  ${r}`);
  process.exit(0);
}

const profile = PROFILES[harness ?? ''];
if (!profile) {
  console.error(USAGE);
  process.exit(1);
}

const interactive = flags.print ? false : flags.interactive ? true : profile.defaultInteractive;
if (!WIN && interactive) {
  console.error('interactive capture is Windows-only for now; pass --print for the other variant');
  process.exit(1);
}

const cwd = resolve(typeof flags.cwd === 'string' ? flags.cwd : process.cwd());
const model = typeof flags.model === 'string' ? flags.model : profile.defaultModel;
const userPrompt =
  typeof flags.prompt === 'string' ? flags.prompt : 'Reply with exactly: ok. Do not use any tools.';

console.log(
  `capturing ${profile.id}${model ? ` · ${model}` : ''} · ${interactive ? 'interactive' : 'non-interactive'}`,
);
console.log(`  cwd ${cwd}`);

const fromRun = typeof flags['from-run'] === 'string' ? resolve(flags['from-run']) : undefined;
const attempts = fromRun ? 1 : 1 + Number(flags.retries ?? 2);

async function attempt() {
  let runId;
  if (fromRun) {
    if (!existsSync(join(fromRun, 'events.jsonl'))) {
      throw new Error(`${fromRun} is not an orca run directory`);
    }
    runId = basename(fromRun);
    console.log(`  filing existing run ${runId}`);
  } else {
    const launcher = profile.recordVia === 'attach' ? shimLauncher : consoleLauncher;
    runId =
      interactive || profile.recordVia === 'attach'
        ? await captureWithProxy(
            profile,
            cwd,
            model,
            userPrompt,
            launcher(profile, cwd, model, userPrompt),
          )
        : captureRecorded(profile, cwd, model, userPrompt);
  }
  return writeCapture(profile, cwd, runId, interactive, fromRun);
}

let result;
for (let i = 1; i <= attempts; i += 1) {
  try {
    result = await attempt();
    break;
  } catch (err) {
    const last = i === attempts;
    if (!err.transient || last) {
      console.error(`\ncapture failed: ${err.message}`);
      if (err.transient) console.error(`  gave up after ${attempts} attempts.`);
      process.exit(1);
    }
    console.log(`  ${err.message.split('\n')[0]}`);
    console.log(`  transient, retrying (${i + 1}/${attempts})`);
  }
}

const { dest, meta } = result;
writeIndex();
console.log('');
console.log(`  ${basename(dest)}/`);
console.log(
  `    prompt    ${meta.sizes.prompt_chars.toLocaleString()} chars in ${meta.sizes.blocks.length} blocks`,
);
console.log(`    tools     ${meta.sizes.tools}`);
console.log(`    request   ${meta.sizes.request_bytes.toLocaleString()} bytes`);
if (meta.prefix_tokens) console.log(`    prefix    ${meta.prefix_tokens.toLocaleString()} tokens`);
console.log('    scrubbed  clean');
if (meta.response_error) {
  console.log('');
  console.log(`  note: the agent's turn came back ${meta.response_error}, so there is no token`);
  console.log('        count for it. the prompt is unaffected - it travels in the request.');
}
console.log('');
console.log(`written to ${dest}`);
console.log(`  mirrored ${meta.prompt_file}`);
