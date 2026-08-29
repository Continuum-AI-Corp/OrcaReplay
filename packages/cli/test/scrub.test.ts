import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceWriter } from '@orcareplay/core';
import { validateEvent } from '@orcareplay/schema';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { scrubCommand } from '../src/commands/scrub.js';

/**
 * `orca scrub` is the second line of defence behind write-path redaction, and it is a promise
 * made in SECURITY.md and in the bug-report template. It has to actually remove things.
 */
describe('scrub', () => {
  let cwd: string;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-scrub-'));
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function makeRun(payloads: unknown[]): Promise<string> {
    const writer = await TraceWriter.create(join(cwd, '.orca', 'runs'), {
      adapter: { id: 'test' },
      argv: ['test'],
      cwd,
      orcaVersion: '0.1.0',
    });
    await writer.append({ type: 'run.start', actor: 'orca', turn: 0 });
    for (const payload of payloads) {
      await writer.append({ type: 'note', actor: 'orca', turn: 1, payload: payload as never });
    }
    await writer.append({ type: 'run.end', actor: 'orca', turn: 1 });
    await writer.close(0);
    return writer.runDir;
  }

  it('removes a literal string the user names', async () => {
    const runDir = await makeRun(['the deploy host is prod-db-7.internal.example.com']);
    await scrubCommand(
      parseArgs(['scrub', 'last', '--match', 'prod-db-7.internal.example.com']),
      out,
      cwd,
    );

    const raw = await readFile(join(runDir, 'events.jsonl'), 'utf8');
    expect(raw).not.toContain('prod-db-7.internal.example.com');
    expect(raw).toContain('redacted');
  });

  it('leaves the rest of the payload intact', async () => {
    const runDir = await makeRun(['keep this. remove SECRETVALUE. keep this too.']);
    await scrubCommand(parseArgs(['scrub', 'last', '--match', 'SECRETVALUE']), out, cwd);
    const raw = await readFile(join(runDir, 'events.jsonl'), 'utf8');
    expect(raw).toContain('keep this');
    expect(raw).toContain('keep this too');
  });

  it('re-runs the standard detectors, catching what the write path missed', async () => {
    const runDir = await makeRun(['token AKIAIOSFODNN7EXAMPLE embedded in prose']);
    await scrubCommand(parseArgs(['scrub', 'last']), out, cwd);
    expect(await readFile(join(runDir, 'events.jsonl'), 'utf8')).not.toContain(
      'AKIAIOSFODNN7EXAMPLE',
    );
  });

  it('keeps every event valid against the schema afterwards', async () => {
    const runDir = await makeRun(['sk-abcdefghij0123456789abcdef', 'ordinary text']);
    await scrubCommand(parseArgs(['scrub', 'last']), out, cwd);

    const raw = await readFile(join(runDir, 'events.jsonl'), 'utf8');
    for (const line of raw.split('\n').filter(Boolean)) {
      const r = validateEvent(JSON.parse(line));
      expect(r.valid, r.errors.join(', ')).toBe(true);
    }
  });

  it('scrubs blob contents too, not only inline payloads', async () => {
    // Large enough to spill to a blob, so the value never appears in events.jsonl.
    const big = `${'x'.repeat(5000)} NEEDLE-IN-A-BLOB ${'y'.repeat(200)}`;
    const runDir = await makeRun([big]);

    const before = await readFile(join(runDir, 'events.jsonl'), 'utf8');
    expect(before, 'fixture must actually exercise the blob path').not.toContain(
      'NEEDLE-IN-A-BLOB',
    );

    await scrubCommand(parseArgs(['scrub', 'last', '--match', 'NEEDLE-IN-A-BLOB']), out, cwd);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const grep = promisify(execFile);
    const hit = await grep('grep', ['-r', 'NEEDLE-IN-A-BLOB', runDir]).catch(() => null);
    expect(hit, 'the needle must be gone from every file in the run').toBeNull();
  });

  it('updates the integrity digest so the trace still verifies', async () => {
    const runDir = await makeRun(['remove ME-PLEASE now']);
    await scrubCommand(parseArgs(['scrub', 'last', '--match', 'ME-PLEASE']), out, cwd);

    const { TraceReader } = await import('@orcareplay/core');
    const reader = await TraceReader.open(runDir);
    const integrity = await reader.verifyIntegrity();
    expect(integrity.ok, 'a scrubbed trace that fails its own integrity check is unusable').toBe(
      true,
    );
  });

  it('records what it removed, by rule, without recording the value', async () => {
    const runDir = await makeRun(['drop TOPSECRETTOKEN here']);
    await scrubCommand(parseArgs(['scrub', 'last', '--match', 'TOPSECRETTOKEN']), out, cwd);
    const redactions = JSON.parse(await readFile(join(runDir, 'redactions.json'), 'utf8'));
    const dumped = JSON.stringify(redactions);
    expect(dumped).toContain('scrub');
    expect(dumped).not.toContain('TOPSECRETTOKEN');
  });

  it('reports how much it changed', async () => {
    await makeRun(['remove GONE1 and GONE1 again']);
    await scrubCommand(parseArgs(['scrub', 'last', '--match', 'GONE1']), out, cwd);
    expect(lines.join('')).toMatch(/scrubbed/);
  });

  it('is idempotent — scrubbing twice changes nothing the second time', async () => {
    const runDir = await makeRun(['remove TWICE-OVER now']);
    await scrubCommand(parseArgs(['scrub', 'last', '--match', 'TWICE-OVER']), out, cwd);
    const first = await readFile(join(runDir, 'events.jsonl'), 'utf8');
    await scrubCommand(parseArgs(['scrub', 'last', '--match', 'TWICE-OVER']), out, cwd);
    expect(await readFile(join(runDir, 'events.jsonl'), 'utf8')).toBe(first);
  });

  it('refuses a dry run that would change nothing without pretending it did', async () => {
    const runDir = await makeRun(['nothing sensitive here at all']);
    await scrubCommand(parseArgs(['scrub', 'last', '--match', 'ABSENT']), out, cwd);
    expect(await readFile(join(runDir, 'events.jsonl'), 'utf8')).toContain('nothing sensitive');
    expect(lines.join('')).toMatch(/removed=0/);
  });
});

describe('scrub — binary safety', () => {
  it('leaves a binary blob byte-identical even when it contains the literal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-scrub-bin-'));
    const out = new Output({ write: () => {}, isTTY: false });
    const writer = await TraceWriter.create(join(cwd, '.orca', 'runs'), {
      adapter: { id: 'test' },
      argv: ['test'],
      cwd,
      orcaVersion: '0.1.0',
    });
    await writer.append({ type: 'run.start', actor: 'orca', turn: 0 });
    await writer.close(0);

    const { BlobStore } = await import('@orcareplay/core');
    const store = new BlobStore(join(writer.runDir, 'blobs'));
    // Contains the literal AND a NUL byte. Without the binary guard the scrubber would rewrite
    // this as UTF-8 text and silently corrupt every byte after the replacement.
    const binary = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
      Buffer.from('NEEDLE'),
      Buffer.from([0x00, 0xff, 0xfe]),
    ]);
    const ref = await store.put(binary);

    await scrubCommand(parseArgs(['scrub', 'last', '--match', 'NEEDLE']), out, cwd);

    expect(Buffer.from(await store.get(ref))).toEqual(binary);
    await rm(cwd, { recursive: true, force: true });
  });

  it('still scrubs a text blob containing the same literal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-scrub-txt-'));
    const out = new Output({ write: () => {}, isTTY: false });
    const writer = await TraceWriter.create(join(cwd, '.orca', 'runs'), {
      adapter: { id: 'test' },
      argv: ['test'],
      cwd,
      orcaVersion: '0.1.0',
    });
    await writer.append({ type: 'run.start', actor: 'orca', turn: 0 });
    await writer.close(0);

    const { BlobStore } = await import('@orcareplay/core');
    const store = new BlobStore(join(writer.runDir, 'blobs'));
    const ref = await store.put(`prose with NEEDLE inside ${'z'.repeat(100)}`);

    await scrubCommand(parseArgs(['scrub', 'last', '--match', 'NEEDLE']), out, cwd);

    const after = Buffer.from(await store.get(ref)).toString('utf8');
    expect(after).not.toContain('NEEDLE');
    expect(after).toContain('prose with');
    await rm(cwd, { recursive: true, force: true });
  });
});
