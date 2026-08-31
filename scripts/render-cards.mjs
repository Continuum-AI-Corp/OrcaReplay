#!/usr/bin/env node
/**
 * Render the README's card art.
 *
 * Nothing here is drawn for the README. The script records a real run — a real child process, the
 * real proxy, the real PATH shim — and then asks orca for the same cards `orca export` gives
 * anyone else. If the card renderers change, this output changes with them, which is the only way
 * README art stays honest.
 *
 * The run it records is the README's bug hunt: the agent edits a file, runs a check through a
 * tool call, the check exits 1, and the agent finishes anyway. Both tools go through the loop
 * because that is how a real coding harness works — and it is what gives the graph an inferred
 * edge from a tool call to the shell command it ran. An earlier draft had the agent shell out
 * directly, which is legal but produces a trace where nothing connects the model to the failure,
 * and a two-event card that undersells what the graph does.
 *
 * The model stub lives here rather than in `packages/cli/test/fixtures` so that README art never
 * constrains a test fixture, or the other way round.
 *
 * Optional tooling, deliberately not in package.json so `npm ci` stays lean for everyone who is
 * not regenerating README art:
 *
 *   npm i --no-save playwright-core pngjs gifenc
 *   npm run build && node scripts/render-cards.mjs   # -> docs/graph-card.png, docs/chain-card.png
 *
 * Set ORCA_CHROMIUM if Playwright's browser is somewhere it will not find on its own.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'packages', 'cli', 'dist', 'cli.js');
const CHECK = 'node --check nonexistent-file.ts';

/** The agent: reads the base URL like a real harness, and runs both tools through the loop. */
const AGENT = `
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const base = process.env.ANTHROPIC_BASE_URL;
const tools = [
  { name: 'edit_file', description: 'Write a file', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
];
const messages = [{ role: 'user', content: [{ type: 'text', text: 'fix the failing auth test' }] }];
for (let turn = 0; turn < 4; turn++) {
  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 1024, tools, messages }),
  });
  const body = await res.json();
  messages.push({ role: 'assistant', content: body.content });
  const use = body.content.find((b) => b.type === 'tool_use');
  if (!use) break;
  let result = 'ok';
  if (use.name === 'edit_file') {
    writeFileSync(use.input.path, use.input.content);
    result = 'wrote ' + use.input.path;
  } else if (use.name === 'bash') {
    // Through sh, so the PATH shim records it with its exit code. The agent ignores that it
    // failed, which is the whole bug the cards are about.
    try {
      execFileSync('sh', ['-c', use.input.command], { stdio: 'ignore' });
    } catch {
      result = 'exit 1';
    }
  }
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: result }] });
}
`;

/** Deterministic three-step script: edit, check, stop. */
function startModel() {
  const reply = (turn) => {
    const base = { id: `msg_${turn}`, type: 'message', role: 'assistant', model: 'claude-opus-5' };
    if (turn === 0) {
      return {
        ...base,
        content: [
          { type: 'text', text: 'editing auth.ts' },
          {
            type: 'tool_use',
            id: 'tu_0',
            name: 'edit_file',
            input: { path: 'auth.ts', content: 'export const fixed = true;\n' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
      };
    }
    if (turn === 1) {
      return {
        ...base,
        content: [
          { type: 'text', text: 'checking it' },
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: CHECK } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 140, output_tokens: 30 },
      };
    }
    return {
      ...base,
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 180, output_tokens: 12 },
    };
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* the default reply is fine */
      }
      const turn = (body.messages ?? []).filter((m) => m.role === 'assistant').length;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply(turn)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

const workspace = mkdtempSync(join(tmpdir(), 'orca-cards-'));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: workspace, encoding: 'utf8' });
/**
 * Async, and that is not incidental: the model stub serves from *this* process, so a synchronous
 * child blocks the event loop that has to answer the agent. Recording with execFileSync deadlocked
 * — the proxy forwarded upstream, and upstream could not reply until the recording it was waiting
 * on had finished.
 */
const runAsync = promisify(execFile);

run('git', ['init', '-q']);
run('git', ['config', 'user.email', 'art@example.com']);
run('git', ['config', 'user.name', 'Card Art']);
writeFileSync(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
writeFileSync(join(workspace, 'agent.mjs'), AGENT);
run('git', ['add', '-A']);
run('git', ['commit', '-qm', 'before']);

const model = await startModel();
try {
  await runAsync(
    'node',
    [CLI, 'record', 'generic-openai', '--upstream-anthropic', model.url, '--', 'node', 'agent.mjs'],
    { cwd: workspace },
  );
} finally {
  await model.close();
}

// Exactly the commands the README tells people to run. No special path for the art.
run('node', [CLI, 'export', 'last', '--graph-card', 'graph-card.png']);
run('node', [CLI, 'export', 'last', '--card', 'chain-card.png']);

for (const name of ['graph-card.png', 'chain-card.png']) {
  copyFileSync(join(workspace, name), join(REPO, 'docs', name));
  console.log(`docs/${name}`);
}
console.log(run('node', [CLI, 'graph', 'last']));
