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
import { ORCA_VERSION } from './version.js';

const HELP = `orca ${ORCA_VERSION} — record, replay and fork debugger for AI agents

  orca record <agent>            run an agent and capture everything
  orca replay [run]              reproduce a run exactly, network off
        --ui                     open the timeline when it finishes
  orca replay [run] --from N     fork from a checkpoint and continue live
        --model <id>             continue on a different model
  orca compare [run] --models a,b,c
                                 fork the same checkpoint onto several models
        --verify <cmd>           run this in each fork; its exit code is the verdict
        --share [file.svg]       write the verdict table as a shareable card
  orca show [run]                the timeline, in the terminal
  orca checkpoints [run]         where you can fork from
  orca export [run] -o file.html a single self-contained file you can attach
  orca scrub [run] --match X      remove something from a recorded trace
  orca ui [run]                  serve the viewer locally
  orca list                      runs recorded here
  orca gc --older-than 7d        reclaim space; --keep N, --dry-run
  orca doctor                    check this machine can record at all

  [run] is a run id, or "last" (the default).

Flags
  --loose        on replay, continue live past an unmatched request
  --no-fs        skip filesystem capture
  --no-shell     skip shell capture (PATH shim in front of sh/bash)
  --mcp-config <path>  instrument MCP servers from this config
  --ci           machine-readable output, no progress
  --verbose      more detail
  --no-color     also honours NO_COLOR

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
