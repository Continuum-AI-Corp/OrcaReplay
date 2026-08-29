#!/usr/bin/env node
/**
 * Trace format conformance runner.
 *
 * Validates every trace under examples/traces/ against the normative JSON Schema, and validates a
 * trace produced by our own writer alongside them. Both halves are load-bearing and they prove
 * different things: a hand-written example validating shows the schema is targetable by an
 * implementation that is not ours, and the writer's output validating shows *ours* still conforms.
 *
 * Checking only the examples — which is what this did — let the shipped fixture drift into
 * containing events the writer cannot produce while the job reported a clean bill of health for
 * "the format". So the run also reports which declared event types no shipped trace exercises,
 * because a type nothing emits and nothing tests is a claim, not a feature.
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENT_TYPES, validateEvent, validateManifest } from '../packages/schema/dist/index.js';
import { TraceWriter } from '../packages/core/dist/index.js';

const root = new URL('..', import.meta.url).pathname;
const examplesDir = join(root, 'examples', 'traces');

let checked = 0;
let failures = 0;
/** Every event type any validated trace actually contained. */
const seen = new Set();

function fail(where, errors) {
  failures += 1;
  console.error(`FAIL ${where}`);
  for (const e of errors) console.error(`     ${e}`);
}

async function checkTrace(dir, label) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const mr = validateManifest(manifest);
  if (!mr.valid) fail(`${dir}/manifest.json`, mr.errors);

  const raw = await readFile(join(dir, 'events.jsonl'), 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  let expectedSeq = 0;
  for (const [i, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // A truncated final line is legal (spec §2); anything earlier is not.
      if (i === lines.length - 1) continue;
      fail(`${dir}/events.jsonl:${i + 1}`, ['unparseable line']);
      continue;
    }
    const r = validateEvent(event);
    if (!r.valid) fail(`${dir}/events.jsonl:${i + 1}`, r.errors);
    if (event.seq !== expectedSeq) {
      fail(`${dir}/events.jsonl:${i + 1}`, [`seq ${event.seq}, expected dense ${expectedSeq}`]);
    }
    expectedSeq = event.seq + 1;
    seen.add(event.type);
    checked += 1;
  }
  console.log(`  ${label ?? dir.replace(root, '')}: ${lines.length} events`);
}

let entries = [];
try {
  entries = await readdir(examplesDir);
} catch {
  console.log('no examples/traces/ directory yet — nothing to check');
  process.exit(0);
}

for (const name of entries) {
  const dir = join(examplesDir, name);
  if (!(await stat(dir)).isDirectory()) continue;
  await checkTrace(dir);
}

// A trace this repository's writer produced, checked by the same rules as the examples. Without
// it the job could stay green while the writer emitted something the schema forbids.
const scratch = await mkdtemp(join(tmpdir(), 'orca-conformance-'));
try {
  const writer = await TraceWriter.create(scratch, {
    adapter: { id: 'generic-openai', version: '0.0.0' },
    argv: ['generic-openai'],
    cwd: scratch,
    orcaVersion: '0.0.0',
  });
  await writer.append({ type: 'run.start', actor: 'orca', turn: 0, attrs: { adapter: 'x' } });
  await writer.append({
    type: 'model.request',
    actor: 'agent',
    turn: 1,
    attrs: { model: 'gpt-5.2', dialect: 'openai' },
    payload: JSON.stringify({ model: 'gpt-5.2', messages: [] }),
  });
  await writer.append({
    type: 'model.response',
    actor: 'model',
    turn: 1,
    attrs: { model: 'gpt-5.2', status: 200, input_tokens: 1, output_tokens: 1 },
    payload: JSON.stringify({ id: 'x', content: [] }),
  });
  // A tunnelled and a decrypted connection, which `--tls-intercept` now emits for real. Without a
  // pair here the coverage line below still reported `net.*` as unexercised while the recorder was
  // writing them, which is the opposite of the honesty this report exists to provide.
  await writer.append({
    type: 'net.request',
    actor: 'agent',
    turn: 1,
    attrs: { host: 'api.example.com', port: 443, method: 'POST', path: '/v1/x' },
  });
  await writer.append({
    type: 'net.response',
    actor: 'gateway',
    turn: 1,
    attrs: { host: 'api.example.com', status: 200, duration_ms: 12 },
  });
  // An MCP pair, which `--mcp-config` emits for real. It reached this list only after the shim
  // resolution was fixed — until then the recorder rewrote every stdio server to launch a module
  // that exits without starting it, so this type was unexercised because the layer did not work,
  // which is exactly what the coverage line below exists to surface.
  await writer.append({
    type: 'mcp.request',
    actor: 'agent',
    turn: 1,
    attrs: { server: 'files', kind: 'request', method: 'tools/list', id: 1 },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  await writer.append({
    type: 'mcp.response',
    actor: 'agent',
    turn: 1,
    attrs: { server: 'files', kind: 'response', id: 1 },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
  });
  // A fork and the divergence a fork reports. Both come out of `orca replay --from N --model X`.
  await writer.append({
    type: 'fork',
    actor: 'orca',
    turn: 1,
    attrs: { parent_run: 'run_000000000000', fork_point: 2, model: 'gpt-5.2' },
  });
  await writer.append({
    type: 'divergence',
    actor: 'orca',
    turn: 1,
    attrs: { level: 'minor', rung: 2, detail: 'trailing message differs', source_seq: 2 },
  });
  // A routing decision, which a fork emits for real now: orca substituted the model, picked the
  // dialect that serves it and picked the origin.
  await writer.append({
    type: 'route.decision',
    actor: 'gateway',
    turn: 1,
    attrs: {
      model: 'gpt-5.2',
      target: 'openai',
      recorded: 'anthropic',
      origin: 'https://api.openai.com',
      crossProvider: true,
      reason: 'gpt-5.2 is served by openai, not the recorded anthropic',
    },
  });
  await writer.append({ type: 'run.end', actor: 'orca', turn: 1, attrs: { exit_code: 0 } });
  await writer.close(0);
  await checkTrace(writer.runDir, 'this writer, freshly recorded');
} finally {
  await rm(scratch, { recursive: true, force: true });
}

// Only types this repository actually emits are added above. Writing a synthetic event for a type
// nothing produces would empty this list while making it a lie — the line is worth having precisely
// because it is what noticed that MCP capture emitted nothing.
//
// `checkpoint` is the one type that is *supposed* to stay unexercised: spec §3 derives a checkpoint
// at read time and forbids recording one. Reporting it beside genuine gaps invites someone to close
// it by emitting the event the spec says not to — which is exactly what the shipped example used to
// do — so it is named as intentional instead.
const DERIVED_ONLY = new Set(['checkpoint']);
const unexercised = EVENT_TYPES.filter((t) => !seen.has(t) && !DERIVED_ONLY.has(t));
const derived = EVENT_TYPES.filter((t) => !seen.has(t) && DERIVED_ONLY.has(t));
if (derived.length > 0) {
  console.log(`\nderived at read time, never recorded (spec §3): ${derived.join(', ')}`);
}
console.log(
  unexercised.length > 0
    ? `declared but not exercised by any trace here: ${unexercised.join(', ')}`
    : 'every declared event type is exercised by a trace here',
);

console.log(`\n${checked} events checked, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
