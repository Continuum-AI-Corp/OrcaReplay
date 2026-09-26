import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/main.js';

/**
 * Through `main()`, because that is where a thrown message is cut into `what` and `why` — and where
 * the line breaks a message was composed with came out spelled `\x0a`, one line with the choices of
 * a flag, the install command or the order settings are read in run together inside it.
 */
describe('a failure prints as the lines it was written in', () => {
  let cwd: string;
  let printed: string[];
  const real = { out: process.stdout.write, err: process.stderr.write };

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-failure-lines-'));
    printed = [];
    const capture = ((s: string | Uint8Array) => (
      printed.push(String(s)),
      true
    )) as typeof process.stdout.write;
    process.stdout.write = capture;
    process.stderr.write = capture;
  });

  afterEach(async () => {
    process.stdout.write = real.out;
    process.stderr.write = real.err;
    await rm(cwd, { recursive: true, force: true });
  });

  it('lists the choices of a flag one per line', async () => {
    const code = await main(
      ['record', 'generic-openai', '--retrieval-store', 'bogus', '--', 'node', '-e', '1'],
      cwd,
    );
    const lines = printed.join('').split('\n');
    expect(code).toBe(1);
    expect(lines).toContain('  full   keep the response, so the run can be replayed offline');
    expect(lines).toContain(
      '  digest keep only its sha256, which proves a later run agreed but cannot serve it',
    );
    expect(lines.join('\n')).not.toContain('\\x0a');
  });
});
