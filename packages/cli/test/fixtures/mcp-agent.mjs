#!/usr/bin/env node
/**
 * A stand-in agent that uses an MCP server, for end-to-end tests.
 *
 * It does the two things that matter to the recorder: it reads its MCP config from the environment
 * (orca rewrites a copy and points the agent at it), and it talks to the configured stdio server
 * over newline-delimited JSON-RPC — which is what the shim tees.
 *
 * It also drives a model turn either side of the MCP call, and sits for a while before exiting, so
 * a test can tell an event stamped when it happened from one stamped when the frames file was
 * drained. Those are indistinguishable if they are microseconds apart.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = process.env.ANTHROPIC_BASE_URL;
const configPath = process.env.MCP_CONFIG_PATH;
if (!base || !configPath) {
  console.error('mcp-agent: ANTHROPIC_BASE_URL and MCP_CONFIG_PATH are both required');
  process.exit(2);
}

const messages = [{ role: 'user', content: 'call the echo server' }];

async function modelTurn() {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 1024, messages }),
  });
  const body = await res.json();
  messages.push({ role: 'assistant', content: body.content });
  messages.push({ role: 'user', content: 'and again' });
}

async function mcpCall() {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const entry = Object.values(config.mcpServers)[0];
  const server = spawn(entry.command, entry.args ?? [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const reply = new Promise((resolve) => {
    let buf = '';
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', (chunk) => {
      buf += chunk;
      const at = buf.indexOf('\n');
      if (at >= 0) resolve(buf.slice(0, at));
    });
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  await reply;
  server.stdin.end();
  await new Promise((resolve) => server.on('close', resolve));
}

// Turn 1, then the MCP call inside it, then turn 2 — so there is a right answer and a wrong one
// for which turn the call belongs to.
await modelTurn();
await mcpCall();
await modelTurn();

// Keep running. The frames file is drained after this process exits, so without a measurable gap a
// timestamp taken at the drain and one taken when the call happened look the same.
await new Promise((resolve) => setTimeout(resolve, 400));
console.log('mcp-agent: done');
