import { parseArgs, type ParsedArgs } from './args.js';
import { Orca } from './api.js';
import { serveMcp } from './mcp-server.js';
import { Output } from './out.js';
import { recordCommand } from './commands/record.js';
import { replayCommand } from './commands/replay.js';
import {
  checkpointsCommand,
  graphCommand,
  exportCommand,
  listCommand,
  showCommand,
  uiCommand,
} from './commands/inspect.js';
import { compareCommand } from './commands/compare.js';
import { scrubCommand } from './commands/scrub.js';
import { gcCommand } from './commands/gc.js';
import { doctorCommand } from './commands/doctor.js';
import { modelsCommand, setupCommand } from './commands/setup.js';
import { ORCA_VERSION } from './version.js';

const HELP = `orca ${ORCA_VERSION} — record, replay and fork debugger for AI agents

  orca record <agent>            run an agent and capture everything
  orca replay [run]              reproduce a run exactly, network off
        --ui                     open the timeline when it finishes
  orca replay [run] --from N     fork from a checkpoint and continue live
        --model <id>             continue on a different model
  orca compare [run] --models a,b,c
                                 fork the same checkpoint onto several models
        --from N                 checkpoint to fork every model from
        --verify <cmd>           run this in each fork; its exit code is the verdict
        --share [file.svg]       write the verdict table as a shareable card
  orca show [run]                the timeline, in the terminal
  orca checkpoints [run]         where you can fork from
  orca graph [run]               what caused what — recorded edges and derived ones
        --to N                   just the chain that produced event N
  orca export [run] -o file.html a single self-contained file you can attach
  orca scrub [run] --match X     remove something from a recorded trace
        --dry-run                say what would go, and write nothing
        --drop-fs                delete the filesystem snapshots, which cannot be scrubbed
  orca ui [run]                  serve the viewer locally
  orca list                      runs recorded here
  orca gc --older-than 7d        reclaim space, forks' scratch worktrees included
                                 --keep N, --dry-run
  orca doctor                    check this machine can record at all
  orca setup                     point orca at a gateway once, to compare many models
                                 defaults to OrcaRouter; --gateway for any other
        --gateway <url>          origin that serves the model APIs
        --key <k> | --key-env V  store the key, or read it from an environment variable
        --models a,b,c           default model list, so compare needs no flags
  orca models                    what the configured gateway serves, and what it costs

  [run] is a run id, or "last" (the default).

Flags
  --loose        on replay, continue live past an unmatched request
  --in-place     replay against this directory as it stands, restoring nothing
  --worktree     replay in a scratch copy; never touches your files
  --no-trace     do not record the exact replay itself as a run of its own
  --no-fs        skip filesystem capture
  --no-shell     skip shell capture (PATH shim in front of sh/bash)
  --mcp-config <path>  instrument MCP servers from this config
  --ci           machine-readable output, no progress
  --verbose      more detail
  --no-color     also honours NO_COLOR
  --port <n>     port for --ui and orca ui (default: any free port)

A harness that reads no base-URL variable cannot be captured that way at all — a Codex CLI signed
in with a ChatGPT subscription is the case. For that, and only for that:

  --tls-intercept              decrypt HTTPS for the hosts below, for this run only
  --tls-hosts a,b,c            which hosts to decrypt (default: model API hosts)
                               everything else is tunnelled unread; "*" is refused

  It mints a certificate authority in the run directory, trusts it to the agent through that
  child's environment alone, and deletes it when the run ends. It installs nothing, anywhere.
  If a machine is already behind a TLS-inspecting proxy, name its root in ORCA_TLS_UPSTREAM_CA.

Sending traffic somewhere other than the vendor — a gateway, a proxy, a local model — is what
these two are for. They apply to record, replay, fork and compare alike:

  --upstream-anthropic <url>   origin for /v1/messages       (env ORCA_UPSTREAM_ANTHROPIC)
  --upstream-openai <url>      origin for /chat/completions  (env ORCA_UPSTREAM_OPENAI)

Everything after -- goes to the agent:
  orca record claude -- -p "fix the failing test"

For a script, an agent, or CI — every command below also answers as data:

  --json         one JSON document on stdout, diagnostics on stderr
                 list · show · events · checkpoints · graph · record · replay · compare
                 · doctor

  orca mcp       serve orca to an agent over MCP on stdio, so it can read its own runs:
                 {"command": "orca", "args": ["mcp"]}

Docs: https://github.com/Continuum-AI-Corp/OrcaReplay
`;

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  const args = parseArgs(argv);
  if (args.bool('json')) return jsonMain(args, cwd);
  // Under `orca mcp`, stdout is the JSON-RPC transport. A single info line on it corrupts the
  // stream and the client drops the session with no useful error.
  const toStderr = args.command === 'mcp';
  const out = new Output({
    write: (s) => void (toStderr ? process.stderr : process.stdout).write(s),
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
    verbose: args.bool('verbose'),
    ci: args.bool('ci') || process.env.CI === 'true',
    // `--no-color` parses to `color: false`. The `true` fallback is what separates that from an
    // unset flag — `bool('color')` alone returns false for both, which would disable colour for
    // everyone.
    ...(args.bool('color', true) ? {} : { color: false }),
  });

  if (args.bool('version') || args.command === 'version') {
    out.plain(ORCA_VERSION);
    return 0;
  }
  if (args.command === 'help' || args.bool('help') || args.bool('h')) {
    out.plain(HELP);
    return 0;
  }

  try {
    switch (args.command) {
      case 'record':
        return (await recordCommand(args, out, cwd)).exitCode;
      case 'replay':
        return (await replayCommand(args, out, cwd)).exitCode;
      case 'compare':
        await compareCommand(args, out, cwd);
        return 0;
      case 'show':
        await showCommand(args, out, cwd);
        return 0;
      case 'checkpoints':
        await checkpointsCommand(args, out, cwd);
        return 0;
      case 'graph':
        await graphCommand(args, out, cwd);
        return 0;
      case 'export':
        await exportCommand(args, out, cwd);
        return 0;
      case 'ui':
        await uiCommand(args, out, cwd);
        return 0;
      case 'scrub':
        await scrubCommand(args, out, cwd);
        return 0;
      case 'list':
        await listCommand(args, out, cwd);
        return 0;
      case 'gc':
        await gcCommand(args, out, cwd);
        return 0;
      case 'doctor':
        // A failed check is the whole point of running this in CI, so it has to be visible in $?.
        return (await doctorCommand(args, out, cwd)).ok ? 0 : 1;
      case 'setup':
        await setupCommand(args, out);
        return 0;
      case 'models':
        await modelsCommand(args, out);
        return 0;
      case 'mcp':
        // stdout is the transport here, so nothing else may touch it: `out` already writes to
        // stderr under this command, and the server owns the stream until stdin closes.
        await serveMcp({ orca: new Orca({ cwd }), input: process.stdin, output: process.stdout });
        return 0;
      default:
        out.failure({
          event: 'unknown_command',
          what: `there is no "${args.command}" command`,
          next: 'orca help',
        });
        return 2;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [first, ...rest] = message.split('\n');
    out.failure({
      event: `${args.command}.failed`,
      what: first ?? message,
      why: rest.join('\n').trim() || undefined,
    });
    if (out.isVerbose && err instanceof Error && err.stack) out.plain(err.stack);
    return 1;
  }
}

/**
 * `--json`: one JSON document on stdout, diagnostics on stderr.
 *
 * The split is the whole design. A caller wants the answer, so stdout is one document rather than
 * a stream of log objects — `orca show last --json | jq .events` works with nothing in front of
 * it. And a run that warns must not corrupt that document, so every `info`/`warn` line goes to
 * stderr, where a human still reads it and a parser never sees it.
 *
 * Failures come back as JSON too. An agent that only handles the happy path is an agent that
 * hangs on the first bad run, so an error is a document with an `error` key and a non-zero exit,
 * never prose.
 */
async function jsonMain(args: ParsedArgs, cwd: string): Promise<number> {
  const out = new Output({
    // Diagnostics only. Nothing here may reach stdout.
    write: (s) => void process.stderr.write(s),
    env: process.env,
    verbose: args.bool('verbose'),
    ci: true,
    color: false,
  });
  const emit = (doc: unknown): void => void process.stdout.write(`${JSON.stringify(doc)}\n`);

  try {
    const orca = new Orca({ cwd });
    const selector = args.positionals[0] ?? 'last';
    switch (args.command) {
      case 'list':
        emit(await orca.list());
        return 0;
      case 'show':
        emit(await orca.show(selector));
        return 0;
      case 'events':
        emit(await orca.events(selector));
        return 0;
      case 'checkpoints':
        emit(await orca.checkpoints(selector));
        return 0;
      case 'graph':
        emit(
          await orca.graph(selector, {
            ...(args.num('to') === undefined ? {} : { to: args.num('to')! }),
          }),
        );
        return 0;
      case 'record': {
        const result = await recordCommand(args, out, cwd);
        emit(result);
        return result.exitCode;
      }
      case 'replay': {
        const result = await replayCommand(args, out, cwd);
        emit(result);
        return result.exitCode;
      }
      case 'compare':
        emit(await compareCommand(args, out, cwd));
        return 0;
      case 'doctor': {
        const result = await doctorCommand(args, out, cwd);
        emit(result);
        return result.ok ? 0 : 1;
      }
      default:
        emit({
          error: {
            message: `--json does not cover '${args.command}'`,
            // Naming what it does cover beats making someone try them one at a time.
            supported: [
              'list',
              'show',
              'events',
              'checkpoints',
              'graph',
              'record',
              'replay',
              'compare',
              'doctor',
            ],
          },
        });
        return 2;
    }
  } catch (err) {
    emit({ error: { message: err instanceof Error ? err.message : String(err) } });
    return 1;
  }
}
