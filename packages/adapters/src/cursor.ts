import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { detectAgent } from './detect.js';

/**
 * Where the installer puts `cursor-agent`, per platform.
 *
 * Detection only — the launch uses the bare name, like every other adapter, so the fixture stays
 * the same on every machine. What these are for is answering "is this agent even installed here",
 * which matters more than usual because on Windows the installer does *not* put the shim on PATH.
 */
const CURSOR_AGENT_PATHS = [
  // Windows: %LOCALAPPDATA%\cursor-agent\, which holds both shims
  'AppData/Local/cursor-agent/cursor-agent.cmd',
  'AppData/Local/cursor-agent/agent.cmd',
  // macOS and Linux
  '.local/bin/cursor-agent',
  '.local/bin/agent',
  // The editor's own directory, present whether or not the CLI is
  '.cursor',
];

/**
 * Cursor's terminal agent, which has nothing to redirect.
 *
 * Every other harness here reads an origin from somewhere orca can reach. Cursor reads none: the
 * agent stream goes to hosts of Cursor's own over HTTP/2 exclusively, in Connect-over-protobuf,
 * and the endpoint is compiled in. So this adapter sets no variables at all and the redirect
 * happens underneath it, at the socket, when the run is given `--tls-intercept`.
 *
 * Two things an operator has to supply, because this adapter cannot:
 *
 *   - **The hosts.** `DEFAULT_TLS_HOSTS` does not carry Cursor's, deliberately: a recorded run
 *     reached `api2.cursor.sh`, `repo42.cursor.sh` and `agentn.global.api5.cursor.sh`, and the
 *     shard numbers in the last two vary per account, so covering them needs a wildcard —
 *     `--tls-hosts '+*.cursor.sh'`. Putting a wildcard over a vendor's whole domain into the
 *     default list would decrypt its sign-in origins too, which is the one thing that list
 *     promises not to do. So it stays an explicit opt-in.
 *   - **`--trust`.** The agent refuses to run non-interactively in a directory it has not been
 *     trusted in. Passing it is the operator's call, not this adapter's: it is a permission grant,
 *     and an adapter that quietly granted permissions on someone's behalf would be a worse bug
 *     than the inconvenience it saved.
 *
 * The installer ships two shims, `cursor-agent` and `agent`, byte-identical and in the same
 * directory: both run `versions/<build>/index.js` through the bundled node, and
 * `CURSOR_INVOKED_AS` is how the tool learns which name it was called by. Its own usage text
 * says `agent`, the shorter and more natural one. `cursor-agent` is launched here anyway,
 * because a bare `agent` on PATH is generic enough to belong to something else, and since the
 * two shims sit in one directory, whichever name resolves means both do.
 *
 * On Windows that directory is `%LOCALAPPDATA%\cursor-agent\` and the installer does not add
 * it to PATH, so `orca record cursor` reports ENOENT until it is. Loud rather than silent, which
 * is the tradeoff for a fixture that means the same thing on every machine;
 * `orca record exec -- <full path to the shim> ...` is the way round it.
 *
 * `harnessVersions` is deliberately unset: Cursor ships date-stamped builds
 * (`2026.09.02-c22c1a3`), not semver, so a range would be a claim in a vocabulary the harness
 * does not use. The version the fixture was verified against is recorded in its `note` instead.
 */
export const cursorAdapter: Adapter = {
  id: 'cursor',
  aliases: ['cursor-agent'],

  // Redirecting nothing is the intent, not a defect. See the `capture` field on `Adapter`.
  capture: 'transport',

  async detect(cwd: string): Promise<boolean> {
    void cwd;
    return detectAgent(['cursor-agent', 'agent'], CURSOR_AGENT_PATHS);
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    // No origin and no credential: the agent authenticates with the session its own sign-in
    // wrote, and there is no variable to point anywhere. An empty overlay is the whole contract.
    return { command: 'cursor-agent', args: [...ctx.userArgs], env: {} };
  },
};
