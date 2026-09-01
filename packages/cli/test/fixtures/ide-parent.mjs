/**
 * An editor that spawns the real agent, which is the shape of Codex-in-the-IDE.
 *
 * The VS Code and Cursor extensions do not make model calls themselves — they run a agent binary
 * as a child process and talk to it over a pipe. Orca cannot launch that child, because the editor
 * launches it. What orca can launch is the editor, and everything it needs then reaches the agent
 * by inheritance: `HTTPS_PROXY`, the run CA, and the base-URL variables alike.
 *
 * So this fixture makes no model call of its own. It exists to put one process between orca and
 * the agent, and to fail loudly if that gap is where the capture environment goes missing.
 */
import { spawn } from 'node:child_process';

const [, , child, ...rest] = process.argv;
if (!child) {
  console.error('ide-parent: needs the agent to spawn');
  process.exit(2);
}

console.log('ide-parent: launching the agent, having asked no model anything');

// `env` is deliberately not passed: inheriting the parent's environment untouched is the property
// under test. Passing `{...process.env}` would test the same thing, but it would also hide a
// regression where orca stopped putting the capture into the environment in the first place.
const agent = spawn(process.execPath, [child, ...rest], { stdio: 'inherit' });

agent.on('exit', (code, signal) => {
  console.log(`ide-parent: agent exited code=${code ?? 'null'} signal=${signal ?? 'none'}`);
  process.exit(code ?? 1);
});
agent.on('error', (err) => {
  console.error(`ide-parent: could not spawn the agent: ${String(err)}`);
  process.exit(3);
});
