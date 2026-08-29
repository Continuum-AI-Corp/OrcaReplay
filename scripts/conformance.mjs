#!/usr/bin/env node
/**
 * Trace format conformance runner.
 *
 * Validates every trace under examples/traces/ against the normative JSON Schema. Any
 * implementation in any language can run the equivalent check; that is what makes v0 a format
 * other people can target rather than whatever our writer happens to emit today.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateEvent, validateManifest } from '../packages/schema/dist/index.js';

const root = new URL('..', import.meta.url).pathname;
const examplesDir = join(root, 'examples', 'traces');

let checked = 0;
let failures = 0;

function fail(where, errors) {
  failures += 1;
  console.error(`FAIL ${where}`);
  for (const e of errors) console.error(`     ${e}`);
}

async function checkTrace(dir) {
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
    checked += 1;
  }
  console.log(`  ${dir.replace(root, '')}: ${lines.length} events`);
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

console.log(`\n${checked} events checked, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
