#!/usr/bin/env node
/**
 * A very small coding agent, written so the quickstart needs nothing but Node.
 *
 * It reads `OPENAI_BASE_URL`, which is what `orca record` redirects, and drives an ordinary tool
 * loop over chat completions: read the failing test, edit the source, run the test again. That is
 * the whole shape orca depends on, so a trace recorded from it replays with nothing installed
 * beyond the runtime orca already needs.
 *
 *   orca record node -- node agent.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.OPENAI_BASE_URL;
if (!base) {
  console.error('agent: OPENAI_BASE_URL is not set — run this under `orca record`');
  process.exit(2);
}

const cwd = process.cwd();
const model = process.env.AGENT_MODEL ?? 'gpt-5.4-mini';
const maxTurns = Number(process.env.AGENT_MAX_TURNS ?? '8');

const tools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the project',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Replace a file in the project with new contents',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, ['--test', 'test/schedule.test.js'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function useTool(name, input) {
  if (name === 'read_file') return readFileSync(join(cwd, input.path), 'utf8');
  if (name === 'write_file') {
    writeFileSync(join(cwd, input.path), input.content);
    return `wrote ${input.path}`;
  }
  return `unknown tool ${name}`;
}

const messages = [
  {
    role: 'user',
    content:
      'The test suite in this project is failing. Read src/schedule.js and test/schedule.test.js, ' +
      'then fix the source so every test passes. You cannot run the tests — reason it out. ' +
      'Do not edit the tests. Say what you changed when you are done.',
  },
];

for (let turn = 0; turn < maxTurns; turn += 1) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.OPENAI_API_KEY
        ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({ model, messages, tools, max_tokens: 2048 }),
  });

  if (!res.ok) {
    console.error(`agent: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const reply = await res.json();
  const choice = reply.choices?.[0]?.message;
  if (!choice) {
    console.error('agent: no choice in the response');
    process.exit(1);
  }
  messages.push(choice);

  if (choice.content) console.log(String(choice.content).trim());

  const calls = choice.tool_calls ?? [];
  if (calls.length === 0) break;

  for (const call of calls) {
    const input = JSON.parse(call.function.arguments || '{}');
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: useTool(call.function.name, input),
    });
  }
}

// Exits 0 because the agent believes it is finished, which is the point of the demo: the run
// looks clean and the suite is still red. Whether it actually worked is what `npm test` says
// next, and what a fork onto another model is for.
console.log('done');
