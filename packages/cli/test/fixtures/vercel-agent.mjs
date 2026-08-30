#!/usr/bin/env node
/**
 * A stand-in for an agent built on the Vercel AI SDK.
 *
 * The one property that matters is what it does *not* do: it reads no base-URL variable. Like
 * `@ai-sdk/openai`, whose default provider takes its origin as a constructor argument and nothing
 * else, it holds `https://api.openai.com` in code. Under every other adapter that makes it
 * invisible to orca — the run succeeds, exits 0, and the trace is empty.
 *
 * It also hands `fetch` a `Request` object rather than a string on its second turn, because the
 * SDKs that do this are exactly the ones that would slip past a hook that only rewrites strings.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ORIGIN = 'https://api.openai.com';
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

const body = () =>
  JSON.stringify({ model: 'gpt-5.2', instructions: 'You are a careful engineer.', input, tools });

for (let turn = 0; turn < 2; turn += 1) {
  const url = `${ORIGIN}/v1/responses`;
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body(),
    // Without this the control run — no hook installed — waits on a connection that will never
    // be made, and a test that hangs teaches nobody anything.
    signal: AbortSignal.timeout(Number(process.env.VERCEL_AGENT_TIMEOUT_MS ?? '4000')),
  };

  let res;
  try {
    // Turn 2 goes through a Request object, the way an SDK's own fetch wrapper builds one.
    res = turn === 0 ? await fetch(url, init) : await fetch(new Request(url, init));
  } catch (err) {
    console.error(`vercel-agent: could not reach ${ORIGIN} (${err.name})`);
    process.exit(0);
  }
  if (!res.ok) {
    console.error(`vercel-agent: ${res.status} from ${url}: ${(await res.text()).slice(0, 300)}`);
    process.exit(3);
  }

  let calledTool = false;
  for (const item of (await res.json()).output ?? []) {
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

console.log('vercel-agent: done');
