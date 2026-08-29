import { afterAll, describe, expect, it } from 'vitest';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { exportTraceHtml } from '../src/export.js';
import { ev, manifest, resetSeq, tempRunDir, writeRun } from './fixtures.js';

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(label: string, run: Parameters<typeof writeRun>[1]): Promise<string> {
  const dir = await tempRunDir(label);
  scratch.push(dir);
  await writeRun(dir, run);
  return dir;
}

describe('exportTraceHtml', () => {
  it('reads a run directory and writes one self-contained file', async () => {
    resetSeq();
    const dir = await fixture('basic', {
      events: [
        ev({ type: 'run.start', attrs: { adapter: 'claude-code' } }),
        ev({ type: 'shell.exec', attrs: { command: 'npm test' } }),
        ev({ type: 'run.end', attrs: { exit_code: 0 } }),
      ],
    });
    const out = join(dir, 'nested', 'trace.html');
    const result = await exportTraceHtml(dir, out);

    expect(result.path).toBe(out);
    const written = await readFile(out, 'utf8');
    expect(result.bytes).toBe((await stat(out)).size);
    expect(written.startsWith('<!doctype html>')).toBe(true);
    expect(written).toContain('npm test');
    expect(written).toContain('run_abc123');

    const refs = [...written.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]!);
    for (const ref of refs) expect(ref).not.toMatch(/^(?:[a-z]+:)?\/\//i);
  });

  it('inlines the blobs the panes need', async () => {
    resetSeq();
    const dir = await fixture('blobs', {
      events: [
        ev({
          type: 'tool.result',
          payload: { $blob: 'sha256:aabb', bytes: 11, media_type: 'text/plain' },
        }),
      ],
      blobs: { 'sha256:aabb': 'hello blobs' },
    });
    const written = await readFile(
      (await exportTraceHtml(dir, join(dir, 'out.html'))).path,
      'utf8',
    );
    expect(written).toContain('hello blobs');
  });

  it('respects the blob byte cap rather than writing a huge file', async () => {
    resetSeq();
    const dir = await fixture('cap', {
      events: [
        ev({ type: 'tool.result', payload: { $blob: 'sha256:1111', bytes: 2000 } }),
        ev({ type: 'tool.result', payload: { $blob: 'sha256:2222', bytes: 3000 } }),
      ],
      blobs: { 'sha256:1111': 'a'.repeat(2000), 'sha256:2222': 'b'.repeat(3000) },
    });
    const out = join(dir, 'capped.html');
    await exportTraceHtml(dir, out, { maxBlobBytes: 2500 });
    const written = await readFile(out, 'utf8');
    expect(written).toContain('a'.repeat(200));
    expect(written).not.toContain('b'.repeat(200));
    expect(written).toContain('payload omitted, 3000 bytes');
  });

  it('defaults the cap to 8 MB', async () => {
    resetSeq();
    const big = 'c'.repeat(9 * 1024 * 1024);
    const dir = await fixture('bigcap', {
      events: [ev({ type: 'tool.result', payload: { $blob: 'sha256:3333', bytes: big.length } })],
      blobs: { 'sha256:3333': big },
    });
    const out = join(dir, 'big.html');
    const result = await exportTraceHtml(dir, out);
    expect(result.bytes).toBeLessThan(2 * 1024 * 1024);
    expect(await readFile(out, 'utf8')).toContain('payload omitted');
  });

  it('tolerates a truncated final line, as the spec requires of every reader', async () => {
    resetSeq();
    const dir = await fixture('torn', {
      events: [ev({ type: 'run.start' }), ev({ type: 'note', attrs: { text: 'kept' } })],
    });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(dir, 'events.jsonl'), '{"seq":2,"ts":"2026-01-01T00');
    const out = join(dir, 'torn.html');
    await exportTraceHtml(dir, out);
    const written = await readFile(out, 'utf8');
    expect(written).toContain('kept');
    expect((written.match(/role="tab"/g) ?? []).length).toBe(2);
  });

  it('skips a binary blob instead of corrupting the document', async () => {
    resetSeq();
    const dir = await fixture('binary', {
      events: [ev({ type: 'tool.result', payload: { $blob: 'sha256:4444', bytes: 4 } })],
      blobs: { 'sha256:4444': new Uint8Array([0x00, 0x01, 0x02, 0xff]) },
    });
    const out = join(dir, 'bin.html');
    await exportTraceHtml(dir, out);
    expect(await readFile(out, 'utf8')).toContain('payload omitted, 4 bytes');
  });

  it('reports a missing manifest clearly', async () => {
    const dir = await tempRunDir('missing');
    scratch.push(dir);
    await expect(exportTraceHtml(dir, join(dir, 'x.html'))).rejects.toThrow(/manifest\.json/);
  });

  it('handles a run directory with no blobs directory at all', async () => {
    resetSeq();
    const dir = await fixture('noblobs', {
      events: [ev({ type: 'tool.result', payload: { $blob: 'sha256:5555', bytes: 12 } })],
    });
    const out = join(dir, 'nb.html');
    await expect(exportTraceHtml(dir, out)).resolves.toMatchObject({ path: out });
    expect(await readFile(out, 'utf8')).toContain('payload omitted, 12 bytes');
  });
});
