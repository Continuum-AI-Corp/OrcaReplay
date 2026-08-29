import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Redactor, resolveRunSelector } from '@orcareplay/core';
import { validateEvent } from '@orcareplay/schema';
import type { ParsedArgs } from '../args.js';
import type { Output } from '../out.js';

export interface ScrubResult {
  runDir: string;
  filesChanged: number;
  removals: number;
}

/**
 * `orca scrub` — remove material from a trace after the fact.
 *
 * Write-path redaction (§7) is the first line of defence; this is the second, for the thing it
 * missed and for the internal hostname that is only sensitive in your organisation. It rewrites
 * `events.jsonl` and every blob in place, then refreshes the integrity digest — a scrubbed trace
 * that fails its own integrity check would be unusable, which would make people skip scrubbing.
 */
export async function scrubCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<ScrubResult> {
  const runDir = (await resolveRunSelector(cwd, args.positionals[0] ?? 'last')).dir;

  const literals = [...args.list('match'), ...args.list('matches')].filter(Boolean);
  const redactor = new Redactor();

  let removals = 0;
  let filesChanged = 0;

  /** Literal matches first, then the standard detectors over whatever is left. */
  const scrubText = (text: string): string => {
    let next = text;
    for (const literal of literals) {
      if (!literal) continue;
      const parts = next.split(literal);
      if (parts.length > 1) {
        removals += parts.length - 1;
        // Same placeholder shape the write path uses, so a reader cannot tell which pass caught it.
        next = parts.join(placeholderFor(literal));
      }
    }
    const { value, hits } = redactor.redactString(next, 'scrub');
    removals += hits.length;
    return value;
  };

  // events.jsonl, line by line, so a truncated final line stays tolerable.
  const eventsPath = join(runDir, 'events.jsonl');
  const original = await readFile(eventsPath, 'utf8');
  const scrubbedLines: string[] = [];
  for (const line of original.split('\n')) {
    if (line.trim() === '') continue;
    const scrubbed = scrubText(line);
    // Never write a line that would no longer parse or validate: a scrub that corrupts the trace
    // is worse than one that leaves something behind, because it destroys the evidence too.
    try {
      const parsed: unknown = JSON.parse(scrubbed);
      if (!validateEvent(parsed).valid) {
        scrubbedLines.push(line);
        continue;
      }
      scrubbedLines.push(scrubbed);
    } catch {
      scrubbedLines.push(line);
    }
  }
  const nextEvents = `${scrubbedLines.join('\n')}\n`;
  if (nextEvents !== original) {
    await writeFile(eventsPath, nextEvents, { mode: 0o600 });
    filesChanged += 1;
  }

  // Blobs hold most of the volume, so most of what needs removing lives there.
  const blobsRoot = join(runDir, 'blobs');
  for (const path of await walk(blobsRoot)) {
    const buf = await readFile(path);
    // Skip binary. A NUL byte, or a UTF-8 round trip that loses bytes, means rewriting this file
    // as text would corrupt it — and a secret is not going to be hiding in a PNG anyway.
    if (buf.includes(0)) continue;
    const text = buf.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buf)) continue;
    const scrubbed = scrubText(text);
    if (scrubbed !== text) {
      await writeFile(path, scrubbed, { mode: 0o600 });
      filesChanged += 1;
    }
  }

  const manifestPath = join(runDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  if (filesChanged > 0) {
    // Refresh the digest so `verifyIntegrity` still passes over the scrubbed file.
    manifest.integrity = {
      ...(manifest.integrity as Record<string, unknown>),
      events_sha256: createHash('sha256')
        .update(await readFile(eventsPath))
        .digest('hex'),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }

  if (removals > 0) {
    const redactionsPath = join(runDir, 'redactions.json');
    const existing = await readFile(redactionsPath, 'utf8').catch(() => '{"records":[]}');
    const doc = JSON.parse(existing) as { policy_version?: number; records?: unknown[] };
    doc.records = [
      ...(doc.records ?? []),
      // By rule and count, never by value — the whole point is that the value is gone.
      { rule: 'scrub', identifier: `manual:${literals.length} literal(s)`, count: removals },
    ];
    await writeFile(redactionsPath, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  }

  out.phase('scrubbed', { run: runDir, removed: removals, files: filesChanged });
  if (removals === 0) {
    out.plain('  nothing matched — the trace is unchanged');
  }

  return { runDir, filesChanged, removals };
}

function placeholderFor(literal: string): string {
  const hash = createHash('sha256').update(literal).digest('hex').slice(0, 8);
  return `<redacted:scrub:${hash}>`;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if ((await stat(path)).isFile()) out.push(path);
  }
  return out;
}
