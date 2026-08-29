#!/usr/bin/env node
/**
 * A stand-in coding agent, for end-to-end tests.
 *
 * It behaves the way the real targets do in the only respects OrcaReplay depends on: it reads
 * ANTHROPIC_BASE_URL from the environment, drives a multi-turn tool loop over the Messages API,
 * resends the whole conversation every turn (which is what lets the proxy see tool results), and
 * edits a file on disk. If OrcaReplay can record and replay this, the mechanism is sound.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.ANTHROPIC_BASE_URL;
if (!base) {
  console.error('fake-agent: ANTHROPIC_BASE_URL is not set');
  process.exit(2);
}

const turns = Number(process.env.FAKE_AGENT_TURNS ?? '3');
// Its own working directory, like a real agent. Overridable only because a couple of tests pin
// it; anything that pins it stops exercising the directory the harness was actually launched in,
// which is the whole point of restoring a worktree before a replay or a fork.
const cwd = process.env.FAKE_AGENT_CWD ?? process.cwd();
const prompt = process.env.FAKE_AGENT_PROMPT ?? 'fix the auth test';
// Real harnesses open with a system prompt and a tool catalogue that put the very first request
// well past the trace's inline payload limit, so the recorded body spills to a blob. Padding lets a
// test cross that boundary on purpose, because the code either side of it is not the same code.
const pad = Number(process.env.FAKE_AGENT_PAD ?? '0');
const system =
  pad > 0 ? `You are a coding agent. ${'Follow the conventions. '.repeat(pad)}` : undefined;

const tools = [
  {
    name: 'edit_file',
    description: 'Write content to a file',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
];

// Reading a file into the conversation is what makes a run depend on the filesystem it started
// from: the bytes end up inside the request, so replaying against a directory the recording itself
// mutated produces a different request. Real harnesses do this on almost every turn.
const readPath = process.env.FAKE_AGENT_READ;
const opening = readPath
  ? `${prompt}\n\n<file path="${readPath}">\n${readFileSync(join(cwd, readPath), 'utf8')}</file>`
  : prompt;

const messages = [{ role: 'user', content: [{ type: 'text', text: opening }] }];

for (let turn = 0; turn < turns; turn += 1) {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? 'test-key',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 1024,
      tools,
      messages,
      ...(system === undefined ? {} : { system }),
    }),
  });

  if (!res.ok) {
    console.error(`fake-agent: upstream ${res.status}: ${await res.text()}`);
    process.exit(3);
  }

  const body = await res.json();
  messages.push({ role: 'assistant', content: body.content });

  const toolUse = (body.content ?? []).find((b) => b.type === 'tool_use');
  if (!toolUse) break;

  // Perform the tool call, then hand the result back on the NEXT request — which is precisely
  // how the proxy gets to see it without hooking the harness.
  let result = 'ok';
  try {
    if (toolUse.name === 'edit_file') {
      writeFileSync(join(cwd, toolUse.input.path), toolUse.input.content);
      result = `wrote ${toolUse.input.path}`;
    }
  } catch (err) {
    result = `error: ${String(err)}`;
  }

  messages.push({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: result }],
  });
}

console.log(`fake-agent: completed ${messages.length} messages`);
