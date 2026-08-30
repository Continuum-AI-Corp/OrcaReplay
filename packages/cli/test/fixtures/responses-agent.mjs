#!/usr/bin/env node
/**
 * A stand-in agent that speaks the OpenAI Responses API, for end-to-end tests.
 *
 * This is the shape the Codex CLI and the OpenAI Agents SDK take: `OPENAI_BASE_URL` for the
 * origin, `POST /v1/responses` for every turn, the whole conversation resent each time as `input`
 * items — which is what lets a proxy in front of it see the entire loop, tool results included.
 *
 * Before the Responses dialect existed, running this under `orca record` did not produce an empty
 * trace. It produced a dead agent: the proxy answered 404 on turn one.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.OPENAI_BASE_URL;
if (!base) {
  console.error('responses-agent: OPENAI_BASE_URL is not set');
  process.exit(2);
}

const turns = Number(process.env.RESPONSES_AGENT_TURNS ?? '2');
const cwd = process.cwd();
const input = [{ role: 'user', content: [{ type: 'input_text', text: 'fix the auth test' }] }];

const tools = [
  {
    type: 'function',
    name: 'edit_file',
    description: 'Write content to a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
];

for (let turn = 0; turn < turns; turn += 1) {
  const res = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY ?? 'test-key'}`,
    },
    body: JSON.stringify({
      model: process.env.RESPONSES_AGENT_MODEL ?? 'gpt-5.2',
      instructions: 'You are a careful engineer.',
      input,
      tools,
      max_output_tokens: 1024,
    }),
  });

  if (!res.ok) {
    console.error(`responses-agent: ${res.status} from ${base}/responses`);
    process.exit(3);
  }

  const body = await res.json();
  let calledTool = false;
  for (const item of body.output ?? []) {
    if (item.type === 'message') {
      const text = (item.content ?? []).map((c) => c.text ?? '').join('');
      if (text) console.log(text);
      input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
    } else if (item.type === 'function_call') {
      calledTool = true;
      const args = JSON.parse(item.arguments);
      writeFileSync(join(cwd, args.path), args.content);
      input.push({
        type: 'function_call',
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
      input.push({ type: 'function_call_output', call_id: item.call_id, output: 'ok' });
    }
  }
  if (!calledTool) break;
}

console.log(`responses-agent: completed ${turns} turns`);
