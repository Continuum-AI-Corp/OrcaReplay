#!/usr/bin/env node
/**
 * Plugin API neutrality check.
 *
 * The OrcaRouter plugin — and any other vendor plugin — must reach OrcaReplay only through the
 * published @orcareplay/plugin-api surface. Enforcing that mechanically is the difference between
 * a neutrality commitment and a neutrality claim: nobody writes an adapter for a project that
 * might grow a privileged path for its owner.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const providersSrc = join(root, 'packages', 'providers', 'src');

/** Packages a vendor provider plugin may import. Anything else is a privileged path. */
const ALLOWED = new Set(['@orcareplay/plugin-api', '@orcareplay/schema']);
const VENDOR_HINT = /orcarouter/i;

let failures = 0;

async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) out.push(...(await walk(p)));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

let files = [];
try {
  files = await walk(providersSrc);
} catch {
  console.log('no providers package yet — nothing to check');
  process.exit(0);
}

const vendorFiles = files.filter((f) => VENDOR_HINT.test(f));
for (const file of files) {
  const src = await readFile(file, 'utf8');
  const isVendor = VENDOR_HINT.test(file) || VENDOR_HINT.test(src.slice(0, 400));
  if (!isVendor) continue;
  for (const m of src.matchAll(/from\s+'(@orcareplay\/[^']+)'/g)) {
    const pkg = m[1];
    if (!ALLOWED.has(pkg)) {
      failures += 1;
      console.error(`FAIL ${file.replace(root, '')}: vendor plugin imports ${pkg}`);
      console.error(`     allowed: ${[...ALLOWED].join(', ')}`);
    }
  }
}

console.log(
  vendorFiles.length === 0
    ? 'no vendor plugin present yet; check is a no-op until one lands'
    : `${vendorFiles.length} vendor plugin file(s) checked`,
);
console.log(`${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
