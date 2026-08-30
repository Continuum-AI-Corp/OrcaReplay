#!/usr/bin/env node
/**
 * A stand-in for a gateway that launches a coding agent, for the OpenClaw-shaped tests.
 *
 * It makes no model call of its own. It spawns a child that does, and passes on nothing — the
 * child sees the environment only because a process inherits its parent's. That inheritance is the
 * whole mechanism behind recording a gateway, and it is a property of the OS rather than of orca,
 * which is exactly why it is worth a test rather than a sentence in a README.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
console.log('gateway: launching the coding agent');
const child = spawn(process.execPath, [join(here, 'responses-agent.mjs')], { stdio: 'inherit' });
child.on('exit', (code) => {
  console.log(`gateway: agent exited ${code}`);
  process.exit(code ?? 0);
});
