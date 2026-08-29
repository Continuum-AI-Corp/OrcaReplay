import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceWriter } from '@orcareplay/core';
import { validateEvent, validateManifest } from '@orcareplay/schema';
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

  describe('--dry-run', () => {
    it('reports what would go and changes nothing', async () => {
      // The one command in the tool whose effect cannot be undone, and the only one that had no
      // way to look first. It also fires the standard detectors alongside your literal, so what it
      // takes out is genuinely not knowable in advance — which is what makes the preview load-bearing
      // rather than a nicety.
      const runDir = await makeRun(['the deploy host is prod-db-7.internal.example.com']);
      const before = await readFile(join(runDir, 'events.jsonl'), 'utf8');
      const manifestBefore = await readFile(join(runDir, 'manifest.json'), 'utf8');

      const result = await scrubCommand(
        parseArgs(['scrub', 'last', '--match', 'prod-db-7.internal.example.com', '--dry-run']),
        out,
        cwd,
      );

      expect(result.dryRun).toBe(true);
      expect(result.removals, 'it still counts what it found').toBeGreaterThan(0);
      expect(result.filesChanged).toBeGreaterThan(0);
      expect(await readFile(join(runDir, 'events.jsonl'), 'utf8')).toBe(before);
      expect(await readFile(join(runDir, 'manifest.json'), 'utf8')).toBe(manifestBefore);
      expect(lines.join('\n')).toContain('would rewrite events.jsonl');
    });

    it('does not delete the filesystem snapshots that --drop-fs would', async () => {
      const runDir = await makeRun(['nothing sensitive here']);
      await mkdir(join(runDir, 'fs'), { recursive: true });
      await writeFile(join(runDir, 'fs', 'HEAD'), 'ref: refs/heads/main\n');

      await scrubCommand(parseArgs(['scrub', 'last', '--drop-fs', '--dry-run']), out, cwd);

      expect(
        await stat(join(runDir, 'fs')).then(
          () => true,
          () => false,
        ),
        'a dry run must not perform the most destructive thing the command does',
      ).toBe(true);
    });

    it('then really removes it when the flag comes off', async () => {
      const runDir = await makeRun(['the deploy host is prod-db-7.internal.example.com']);
      await scrubCommand(
        parseArgs(['scrub', 'last', '--match', 'prod-db-7.internal.example.com', '--dry-run']),
        out,
        cwd,
      );
      await scrubCommand(
        parseArgs(['scrub', 'last', '--match', 'prod-db-7.internal.example.com']),
        out,
        cwd,
      );
      expect(await readFile(join(runDir, 'events.jsonl'), 'utf8')).not.toContain(
        'prod-db-7.internal.example.com',
      );
    });
  });

  it('leaves no .tmp file behind when it rewrites a trace', async () => {
    // events.jsonl used to be written with a plain writeFile, which truncates before it writes: a
    // ^C in that window left a truncated events file and a manifest digest describing the whole
    // one. Every rewrite now lands by rename, and the staging file must not survive the commit.
    const runDir = await makeRun(['the deploy host is prod-db-7.internal.example.com']);
    await scrubCommand(
      parseArgs(['scrub', 'last', '--match', 'prod-db-7.internal.example.com']),
      out,
      cwd,
    );
    const entries = await readdir(runDir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
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

/**
 * The failure mode that matters for a scrubber is not "removed too little" — it is "reported a
 * clean trace it never searched". Each of these pins one way `orca scrub` used to do exactly that.
 */
describe('scrub — false all-clears', () => {
  let cwd: string;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-scrub-clear-'));
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

  it('refuses --match with no value instead of scrubbing nothing', async () => {
    const runDir = await makeRun(['the host is prod-db-7.internal.example.com']);
    await expect(scrubCommand(parseArgs(['scrub', 'last', '--match']), out, cwd)).rejects.toThrow(
      /--match/,
    );
    expect(await readFile(join(runDir, 'events.jsonl'), 'utf8')).toContain('prod-db-7');
    expect(lines.join(''), 'it must not claim the trace is clean').not.toMatch(/nothing matched/);
  });

  it('refuses an empty --match= the same way', async () => {
    await makeRun(['anything']);
    await expect(scrubCommand(parseArgs(['scrub', 'last', '--match=']), out, cwd)).rejects.toThrow(
      /--match/,
    );
  });

  it('refuses --matches with no value too', async () => {
    await makeRun(['anything']);
    await expect(scrubCommand(parseArgs(['scrub', 'last', '--matches']), out, cwd)).rejects.toThrow(
      /--matches/,
    );
  });

  it('does not count a removal it reverted', async () => {
    // `note` sits inside `"type":"note"`, so the scrubbed line still parses but no longer
    // validates. The original goes back — and the count must go back with it.
    await makeRun(['keep this text']);
    const result = await scrubCommand(parseArgs(['scrub', 'last', '--match', 'note']), out, cwd);
    expect(result.removals).toBe(0);
    expect(lines.join('')).toMatch(/removed=0/);
  });

  it('warns loudly, naming the event, when it puts a line back', async () => {
    const runDir = await makeRun(['keep this text']);
    const result = await scrubCommand(parseArgs(['scrub', 'last', '--match', 'note']), out, cwd);

    expect(result.reverted).toBe(1);
    const printed = lines.join('');
    expect(printed).toMatch(/warn scrub_reverted/);
    // The note event is seq 1: run.start, note, run.end.
    expect(printed).toMatch(/seq=1/);
    // And it says plainly that the match survived, because it did.
    expect(await readFile(join(runDir, 'events.jsonl'), 'utf8')).toContain('"type":"note"');
    expect(printed.toLowerCase()).toMatch(/still/);
  });

  it('warns when the scrub would leave the line unparseable, rather than reverting in silence', async () => {
    // `"payload"` is a key, so removing it leaves a bare token where a string had to be.
    const runDir = await makeRun(['keep this text']);
    const before = await readFile(join(runDir, 'events.jsonl'), 'utf8');
    const result = await scrubCommand(
      parseArgs(['scrub', 'last', '--match', '"payload"']),
      out,
      cwd,
    );

    expect(result.reverted).toBe(1);
    expect(result.removals).toBe(0);
    expect(lines.join('')).toMatch(/warn scrub_reverted/);
    expect(await readFile(join(runDir, 'events.jsonl'), 'utf8')).toBe(before);
  });
});

/**
 * `manifest.json` is where the operator is named: `cwd` and `argv` carry the checkout path, and
 * `env_allowlisted` carries HOME, PATH and USER verbatim. `orca scrub last --match my-hostname`
 * is the README's own example, so the manifest has to go through the same detectors as the rest.
 */
describe('scrub — the manifest', () => {
  const ENV_KEY = 'ORCA_SCRUB_TEST_HOST';
  let cwd: string;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-scrub-manifest-'));
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
  });

  afterEach(async () => {
    delete process.env[ENV_KEY];
    await rm(cwd, { recursive: true, force: true });
  });

  async function makeRun(host = 'prod-db-7.internal.example.com'): Promise<string> {
    process.env[ENV_KEY] = `/home/${host}/checkout`;
    const writer = await TraceWriter.create(join(cwd, '.orca', 'runs'), {
      adapter: { id: 'test' },
      argv: ['claude', '--project', `/srv/${host}`],
      cwd: `/srv/${host}`,
      orcaVersion: '0.1.0',
      envAllowlist: [ENV_KEY],
    });
    await writer.append({ type: 'run.start', actor: 'orca', turn: 0 });
    await writer.append({ type: 'run.end', actor: 'orca', turn: 0 });
    await writer.close(0);
    return writer.runDir;
  }

  it('removes the literal from cwd, argv and the allowlisted environment', async () => {
    const runDir = await makeRun();
    const before = await readFile(join(runDir, 'manifest.json'), 'utf8');
    expect(before, 'fixture must put the host in all three places').toContain(
      'prod-db-7.internal.example.com',
    );

    await scrubCommand(
      parseArgs(['scrub', 'last', '--match', 'prod-db-7.internal.example.com']),
      out,
      cwd,
    );

    const after = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as {
      cwd: string;
      argv: string[];
      env_allowlisted: Record<string, string>;
    };
    expect(JSON.stringify(after)).not.toContain('prod-db-7.internal.example.com');
    expect(after.cwd).toContain('redacted');
    expect(after.argv.join(' ')).toContain('redacted');
    expect(after.env_allowlisted[ENV_KEY]).toContain('redacted');
  });

  it('re-runs the standard detectors over the manifest as well', async () => {
    const runDir = await makeRun();
    // A key that leaked into the recorded command line, which the write path never saw.
    const raw = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    raw.argv = ['claude', '--token', 'ghr_abcdefghijklmnopqrstuvwxyz0123456789'];
    await writeFile(join(runDir, 'manifest.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    await scrubCommand(parseArgs(['scrub', 'last']), out, cwd);

    const after = await readFile(join(runDir, 'manifest.json'), 'utf8');
    expect(after).not.toContain('ghr_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('leaves a manifest that still validates and still verifies', async () => {
    const runDir = await makeRun();
    await scrubCommand(
      parseArgs(['scrub', 'last', '--match', 'prod-db-7.internal.example.com']),
      out,
      cwd,
    );

    const parsed: unknown = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
    const result = validateManifest(parsed);
    expect(result.valid, result.errors.join(', ')).toBe(true);

    const { TraceReader } = await import('@orcareplay/core');
    await expect((await TraceReader.open(runDir)).verifyIntegrity()).resolves.toMatchObject({
      ok: true,
    });
  });

  it('counts what it removed from the manifest', async () => {
    await makeRun();
    const result = await scrubCommand(
      parseArgs(['scrub', 'last', '--match', 'prod-db-7.internal.example.com']),
      out,
      cwd,
    );
    // cwd, one argv element, and the environment value.
    expect(result.removals).toBeGreaterThanOrEqual(3);
  });

  it('refuses, changing nothing, when the scrub would take the manifest apart', async () => {
    const runDir = await makeRun();
    const manifestBefore = await readFile(join(runDir, 'manifest.json'), 'utf8');

    // A bare quote is not a value in the manifest, it is the JSON itself.
    await expect(
      scrubCommand(parseArgs(['scrub', 'last', '--match', '"']), out, cwd),
    ).rejects.toThrow(/manifest/);

    expect(await readFile(join(runDir, 'manifest.json'), 'utf8')).toBe(manifestBefore);
  });

  it('refuses, changing nothing, when the scrub would invalidate the manifest', async () => {
    const runDir = await makeRun();
    const manifestBefore = await readFile(join(runDir, 'manifest.json'), 'utf8');
    const eventsBefore = await readFile(join(runDir, 'events.jsonl'), 'utf8');

    // `run_` is the run id's required prefix, so removing it breaks a field the schema pins.
    await expect(
      scrubCommand(parseArgs(['scrub', 'last', '--match', 'run_']), out, cwd),
    ).rejects.toThrow(/manifest/);

    expect(await readFile(join(runDir, 'manifest.json'), 'utf8')).toBe(manifestBefore);
    expect(await readFile(join(runDir, 'events.jsonl'), 'utf8')).toBe(eventsBefore);
  });
});

/**
 * `fs/` is a bare git object store holding the whole workspace at every turn — usually the largest
 * thing in a run. Its objects are addressed by the hash of what they contain, so a secret in a
 * source file cannot be edited out of it the way a blob can. What must not happen is the scrubber
 * reporting a clean trace while every snapshot still holds the file.
 */
describe('scrub — the shadow filesystem store', () => {
  const NEEDLE = 'prod-db-7.internal.example.com';
  let cwd: string;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-scrub-fs-'));
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /** A run whose shadow store holds one workspace file containing `contents`. */
  async function makeRunWithSnapshot(contents: string): Promise<{ runDir: string; tree: string }> {
    await writeFile(join(cwd, 'config.ts'), contents, 'utf8');
    const writer = await TraceWriter.create(join(cwd, '.orca', 'runs'), {
      adapter: { id: 'test' },
      argv: ['test'],
      cwd,
      orcaVersion: '0.1.0',
    });
    await writer.append({ type: 'run.start', actor: 'orca', turn: 0 });
    const { FsCapture } = await import('@orcareplay/fs-capture');
    const capture = await FsCapture.start({ runDir: writer.runDir, cwd });
    const snapshot = await capture.snapshotTurn(0);
    await writer.append({
      type: 'fs.snapshot',
      actor: 'orca',
      turn: 0,
      attrs: { tree: snapshot.tree },
    });
    await writer.append({ type: 'run.end', actor: 'orca', turn: 0 });
    await writer.close(0);
    return { runDir: writer.runDir, tree: snapshot.tree };
  }

  it('reports that the shadow store still holds the match instead of claiming a clean trace', async () => {
    const { runDir } = await makeRunWithSnapshot(`export const host = '${NEEDLE}';\n`);
    const result = await scrubCommand(parseArgs(['scrub', 'last', '--match', NEEDLE]), out, cwd);

    expect(result.fsStoreMatches).toBeGreaterThan(0);
    const printed = lines.join('');
    expect(printed).toMatch(/warn fs_store_not_scrubbed/);
    expect(printed).toMatch(/--drop-fs/);
    expect(
      printed,
      'it must not call a trace clean while the store still holds the match',
    ).not.toMatch(/nothing matched/);
    expect(runDir).toBeTruthy();
  });

  /** The report has to be true: restoring the snapshot really does bring the match back. */
  it('is telling the truth — the snapshot still restores the match', async () => {
    const { runDir, tree } = await makeRunWithSnapshot(`export const host = '${NEEDLE}';\n`);
    await scrubCommand(parseArgs(['scrub', 'last', '--match', NEEDLE]), out, cwd);

    const dest = await mkdtemp(join(tmpdir(), 'orca-scrub-fs-restore-'));
    const { ShadowIndex } = await import('@orcareplay/fs-capture');
    const shadow = await ShadowIndex.create({ gitDir: join(runDir, 'fs'), workTree: cwd });
    await shadow.materialize(tree, dest);
    expect(await readFile(join(dest, 'config.ts'), 'utf8')).toContain(NEEDLE);
    await rm(dest, { recursive: true, force: true });
  });

  it('drops the store outright with --drop-fs, and says what that costs', async () => {
    const { runDir } = await makeRunWithSnapshot(`export const host = '${NEEDLE}';\n`);
    const result = await scrubCommand(
      parseArgs(['scrub', 'last', '--match', NEEDLE, '--drop-fs']),
      out,
      cwd,
    );

    expect(result.fsStoreDropped).toBe(true);
    expect(result.fsStoreMatches).toBe(0);
    await expect(stat(join(runDir, 'fs'))).rejects.toThrow();
    expect(lines.join('')).toMatch(/fs_store_dropped/);
  });

  it('says nothing about the store when it holds no match', async () => {
    await makeRunWithSnapshot('export const host = "localhost";\n');
    const result = await scrubCommand(parseArgs(['scrub', 'last', '--match', NEEDLE]), out, cwd);

    expect(result.fsStoreMatches).toBe(0);
    expect(lines.join('')).not.toMatch(/fs_store_not_scrubbed/);
  });

  it('finds a match in a captured filename, not only in file contents', async () => {
    await writeFile(join(cwd, `${NEEDLE}.conf`), 'listen = 8080\n', 'utf8');
    await makeRunWithSnapshot('export const host = "localhost";\n');
    const result = await scrubCommand(parseArgs(['scrub', 'last', '--match', NEEDLE]), out, cwd);
    expect(result.fsStoreMatches).toBeGreaterThan(0);
  });
});

/** A store that is present but unreadable is the one case where "0 matches" proves nothing. */
describe('scrub — an unreadable shadow store', () => {
  it('says it could not check, rather than reporting a clean trace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-scrub-fs-bad-'));
    const lines: string[] = [];
    const out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    const writer = await TraceWriter.create(join(cwd, '.orca', 'runs'), {
      adapter: { id: 'test' },
      argv: ['test'],
      cwd,
      orcaVersion: '0.1.0',
    });
    await writer.append({ type: 'run.start', actor: 'orca', turn: 0 });
    await writer.close(0);
    // Present, but not an object database git can open.
    await mkdir(join(writer.runDir, 'fs'), { recursive: true });

    const result = await scrubCommand(parseArgs(['scrub', 'last', '--match', 'ABSENT']), out, cwd);

    expect(result.fsStoreMatches).toBe(0);
    const printed = lines.join('');
    expect(printed).toMatch(/warn fs_store_unverified/);
    expect(printed, 'an unchecked store is not a clean one').not.toMatch(/nothing matched/);
    await rm(cwd, { recursive: true, force: true });
  });
});
