import { parseArgs } from './args.js';
import { Output } from './out.js';
import { recordCommand } from './commands/record.js';
import { replayCommand } from './commands/replay.js';
import {
  checkpointsCommand,
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
  orca export [run] -o file.html a single self-contained file you can attach
  orca scrub [run] --match X     remove something from a recorded trace
        --drop-fs                delete the filesystem snapshots, which cannot be scrubbed
  orca ui [run]                  serve the viewer locally
  orca list                      runs recorded here
  orca gc --older-than 7d        reclaim space, forks' scratch worktrees included
                                 --keep N, --dry-run
  orca doctor                    check this machine can record at all
  orca setup                     point orca at a gateway once, to compare many models
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

Docs: https://github.com/Continuum-AI-Corp/OrcaReplay
`;

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  const args = parseArgs(argv);
  const out = new Output({
    write: (s) => process.stdout.write(s),
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
