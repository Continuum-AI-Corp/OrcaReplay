import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceWriter } from '@orcareplay/core';
import { validateEvent } from '@orcareplay/schema';
import { parseArgs } from './../src/args.js';
import { Output } from './../src/out.js';
import { recordCommand } from './../src/commands/record.js';
import {
  discardAgentSpans,
  eventForSpan,
  installAgentSpans,
  pythonPathWith,
  readAgentSpans,
  SITECUSTOMIZE,
  SITECUSTOMIZE_SOURCE,
} from '../src/agent-spans.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-spans-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/**
 * The sixth capture layer: what a harness reports about itself.
 *
 * Every other layer records something orca observed. This one records something orca was *told*,
 * and it exists because three facts were measured as unrecoverable from the wire — which agent a
 * turn belonged to, that a handoff happened and from whom, and that a guardrail ran at all.
 *
 * The handoff is the sharp case. The SDK implements one as a function tool named
 * `transfer_to_<agent>`, so the proxy records an ordinary tool call. A rule could guess a handoff
 * from that name, but a user tool may be called the same thing, and the agent it came *from* never
 * reaches the wire. These tests pin the translation from span to event, and the two properties the
 * bootstrap has to have.
 */
describe('turning SDK spans into trace events', () => {
  it('keeps a handoff, naming both ends', () => {
    const event = eventForSpan({
      kind: 'span',
      type: 'HandoffSpanData',
      started_at: '2026-09-10T03:46:03.483810+00:00',
      data: { type: 'handoff', from_agent: 'Triage', to_agent: 'Billing Specialist' },
    });
    expect(event?.type).toBe('agent.handoff');
    expect(event?.attrs).toMatchObject({ from: 'Triage', to: 'Billing Specialist' });
  });

  it('keeps a guardrail, including one that did not trip', () => {
    // The one that did not trip is the interesting one: a guardrail need make no request at all, so
    // a quiet pass leaves nothing on the wire whatsoever.
    const event = eventForSpan({
      kind: 'span',
      type: 'GuardrailSpanData',
      data: { type: 'guardrail', name: 'not_empty', triggered: false },
    });
    expect(event?.type).toBe('agent.guardrail');
    expect(event?.attrs).toMatchObject({ name: 'not_empty', triggered: false });
  });

  it('keeps an agent, with the handoffs it was offered', () => {
    const event = eventForSpan({
      kind: 'span',
      type: 'AgentSpanData',
      data: { name: 'Triage', handoffs: ['Billing Specialist'], tools: [], output_type: 'str' },
    });
    expect(event?.type).toBe('agent.start');
    expect(event?.attrs).toMatchObject({
      name: 'Triage',
      handoffs: 'Billing Specialist',
      tools: 0,
    });
  });

  it('drops the model exchanges, which the proxy already has byte for byte', () => {
    // Not an optimisation. Writing them again would put a second, worse copy of the conversation in
    // the trace, and replay matches on the recorded bytes.
    for (const type of ['ResponseSpanData', 'GenerationSpanData']) {
      expect(eventForSpan({ kind: 'span', type, data: {} }), type).toBeUndefined();
    }
  });

  it('drops the structural spans the timeline already shows', () => {
    for (const type of ['TurnSpanData', 'TaskSpanData', 'CustomSpanData']) {
      expect(eventForSpan({ kind: 'span', type, data: {} }), type).toBeUndefined();
    }
  });

  it('produces events the normative schema accepts', () => {
    const spans = [
      { kind: 'span', type: 'AgentSpanData', data: { name: 'A', handoffs: [], tools: [] } },
      { kind: 'span', type: 'HandoffSpanData', data: { from_agent: 'A', to_agent: 'B' } },
      { kind: 'span', type: 'GuardrailSpanData', data: { name: 'g', triggered: true } },
    ];
    for (const span of spans) {
      const derived = eventForSpan(span)!;
      const result = validateEvent({
        seq: 1,
        ts: '2026-09-10T03:46:03.483Z',
        mono_us: 1,
        turn: 1,
        type: derived.type,
        actor: 'harness',
        attrs: JSON.parse(JSON.stringify(derived.attrs)),
      });
      expect(result.valid, `${derived.type}: ${result.errors.join('; ')}`).toBe(true);
    }
  });
});

describe('reading what the processor wrote', () => {
  it('skips a line that will not parse rather than failing the run', async () => {
    // The file is appended to by another process which may have been killed mid-write. Losing the
    // last span beats failing to seal an otherwise complete trace.
    const path = join(dir, 'spans.jsonl');
    await writeFile(
      path,
      '{"kind":"span","type":"HandoffSpanData","data":{}}\n{"kind":"span",\n\n',
      'utf8',
    );
    expect((await readAgentSpans(path)).spans).toHaveLength(1);
  });

  it('is empty when there is no file, because that is the ordinary case', async () => {
    expect((await readAgentSpans(join(dir, 'nothing.jsonl'))).spans).toEqual([]);
  });

  it('skips a line that parses to something that is not a span', async () => {
    // "Malformed" cannot mean only "does not parse". `null` is valid JSON and is exactly what a
    // producer writes when it could not serialise a span, and it used to be handed to
    // `eventForSpan`, which dereferenced it — one line ended the run and left the trace with no
    // `ended_at`, `counts` or `integrity`, which reads as *tampered* rather than as unfinished.
    const path = join(dir, 'not-objects.jsonl');
    const lines = [
      'null',
      '42',
      '"a string"',
      '[1,2]',
      '{"kind":"span","type":"HandoffSpanData","data":{}}',
      '',
    ];
    await writeFile(path, lines.join('\n'), 'utf8');
    const { spans } = await readAgentSpans(path);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.type).toBe('HandoffSpanData');
  });
});

describe('a translator that cannot be handed something it does not expect', () => {
  // `eventForSpan` takes `unknown` rather than `AgentSpan` deliberately: its only caller reads a
  // file another process appends to, so the type is a description of what is expected rather than
  // a guarantee. Belt and braces with the filter above — the failure it prevents is not worth one
  // layer of defence.
  it('returns undefined for anything that is not an object', () => {
    for (const value of [null, undefined, 42, 'span', [], true]) {
      expect(eventForSpan(value)).toBeUndefined();
    }
  });
});

describe('the spans file is a transport, not part of the trace', () => {
  it('is created by orca rather than by the child, so it gets the run directory mode', async () => {
    // SECURITY.md: "Trace files and blobs are written mode 0600." A file the child creates gets
    // that interpreter's umask instead, which is how a run directory ends up with one
    // world-readable file in it. The two capture layers that already leave a side file here
    // pre-create it for exactly this reason.
    const capture = await installAgentSpans(dir);
    const info = await stat(capture.spansPath);
    expect(info.isFile()).toBe(true);
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
  });

  it('is gone once its contents are in the trace', async () => {
    // Nothing reads it after the drain — not replay, not fork, not the viewer. Leaving it would
    // make it the only thing in a run directory that the redactor, the integrity digest and
    // `orca scrub` all miss: a scrub would print `removed=N` with the same material beside it.
    const capture = await installAgentSpans(dir);
    await writeFile(capture.spansPath, '{"kind":"span","type":"HandoffSpanData","data":{}}\n');
    const { ingested } = await readAgentSpans(capture.spansPath);
    expect(await discardAgentSpans(ingested)).toBeUndefined();
    expect(existsSync(capture.spansPath)).toBe(false);
  });

  it('reports a removal it could not do rather than throwing', async () => {
    // It runs inside the region that seals the trace, so a throw here is the hang and the unsealed
    // manifest all over again. Failing to delete it is worth a warning and never worth the trace.
    const asDirectory = join(dir, 'occupied.jsonl');
    await mkdir(join(asDirectory, 'in-the-way'), { recursive: true });
    expect(await discardAgentSpans([asDirectory])).toEqual(expect.stringMatching(/./));
  });

  it('deletes what the read ingested, never a fresh listing', async () => {
    // The set that is destroyed has to be the set that was read. Listing again at delete time
    // removes whatever matches *then* — and a process that begins tracing between the two is the
    // case one file per process exists for. Its file would go unparsed, and because the `dropped`
    // record lives in that same file, the loss could not even be reported.
    const span = '{"kind":"span","type":"HandoffSpanData"}\n';
    const capture = await installAgentSpans(dir);
    await writeFile(`${capture.spansPath}.111`, span);
    const { spans, ingested } = await readAgentSpans(capture.spansPath);
    expect(spans).toHaveLength(1);

    // Two processes start tracing after the read.
    await writeFile(`${capture.spansPath}.222`, span);
    await writeFile(`${capture.spansPath}.333`, '{"kind":"dropped","count":7}\n');

    expect(await discardAgentSpans(ingested)).toBeUndefined();
    expect(existsSync(`${capture.spansPath}.222`), 'deleted without being read').toBe(true);
    expect(existsSync(`${capture.spansPath}.333`), 'deleted without being read').toBe(true);
    expect(existsSync(`${capture.spansPath}.111`)).toBe(false);
  });
});

describe('the bootstrap orca writes', () => {
  it('lands where Python will import it', async () => {
    const capture = await installAgentSpans(dir);
    const source = await readFile(join(capture.pythonPath, SITECUSTOMIZE), 'utf8');
    expect(source).toBe(SITECUSTOMIZE_SOURCE);
    // A directory, not the file: PYTHONPATH names places to look, and `sitecustomize` has to be
    // importable as a top-level module from one of them.
    expect(capture.pythonPath.endsWith('py')).toBe(true);
  });

  it('imports the published package, never this repository', () => {
    // It runs in the agent's interpreter, which resolves imports against its own environment. The
    // fetch hook and the shell shim are written out standalone for exactly this reason.
    expect(SITECUSTOMIZE_SOURCE).toContain('from orcareplay_openai_agents import install');
    expect(SITECUSTOMIZE_SOURCE).not.toMatch(/packages[/\\]/);
  });

  it('does nothing at all unless orca is recording', () => {
    // It is imported by *every* Python process the run starts, including `python --version`.
    expect(SITECUSTOMIZE_SOURCE).toContain('if not os.environ.get("ORCA_AGENT_SPANS")');
  });

  it('lets no failure of its own reach the agent', () => {
    // Every import and call is guarded. A capture layer that can break the run it is capturing is
    // worse than one that captures nothing.
    const guarded = SITECUSTOMIZE_SOURCE.split('except Exception:').length - 1;
    expect(guarded).toBeGreaterThanOrEqual(3);
  });
});

describe('pythonPathWith', () => {
  it('puts our directory first and keeps theirs', () => {
    expect(pythonPathWith('/orca', '/theirs:/more', ':')).toBe('/orca:/theirs:/more');
  });

  it('does not add itself twice', () => {
    expect(pythonPathWith('/orca', '/orca:/theirs', ':')).toBe('/orca:/theirs');
  });

  it('handles an unset PYTHONPATH without leaving an empty segment', () => {
    // An empty segment means "the current directory" to Python, which is not what an unset variable
    // asked for and is a way to shadow a module by where you happened to run from.
    expect(pythonPathWith('/orca', undefined, ':')).toBe('/orca');
    expect(pythonPathWith('/orca', '', ':')).toBe('/orca');
  });
});

/**
 * The spans file is a raw sink, so it may not outlive the run on *any* path.
 *
 * It is appended to by the agent’s own interpreter and never passes the write-path redactor,
 * and `orca scrub` rewrites only `events.jsonl`, the manifest and the blobs — so a scrub would
 * report `removed=N` with the same material sitting beside it untouched, which SECURITY.md calls
 * worse than having no scrubber at all.
 *
 * The ingest deletes it on the way out, and `abandon` deletes it for a throw that reaches there.
 * Neither covers the window in between: `installAgentSpans` runs at the top of the recording, and
 * the first `try` that routes to `abandon` is a hundred and fifty lines later — with the TLS
 * setup, the proxy’s own bind, the opening `run.start` append and the initial filesystem
 * snapshot in between, every one of which can throw. So the file is owned by `recordCommand`,
 * beside the minted CAs it already releases, and released for every throw rather than for the
 * ones a particular function happens to catch.
 *
 * Parameterised over where the throw lands, because the two later cases passed before that was
 * true and the first two did not.
 */
describe('an abandoned run does not leave the spans file behind', () => {
  const exec = promisify(execFile);
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-abandon-'));
    await exec('git', ['init', '-q'], { cwd: workspace });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(workspace, { recursive: true, force: true });
  });

  /**
   * Only `TraceWriter.append` is replaced, and only to make one call reject the way a full disk
   * would. Everything else — the command, the proxy, the child — is real.
   */
  it.each([
    [1, 'before the proxy is even listening'],
    [2, 'while the run is opening'],
    [3, 'once the trace is being sealed'],
  ])('removes it when append #%i throws, %s', async (nth) => {
    const agent = join(workspace, 'agent.mjs');
    await writeFile(
      agent,
      [
        'import { appendFileSync } from "node:fs";',
        'const p = process.env.ORCA_AGENT_SPANS;',
        'if (p) appendFileSync(p, JSON.stringify({ kind: "span", type: "AgentSpanData", data: { name: "Triage" } }) + "\\n");',
        'console.log("GOT: done");',
      ].join('\n'),
    );

    const real = TraceWriter.prototype.append;
    let calls = 0;
    vi.spyOn(TraceWriter.prototype, 'append').mockImplementation(async function (
      this: TraceWriter,
      ...args: Parameters<typeof real>
    ) {
      calls += 1;
      if (calls >= nth) throw new Error('ENOSPC: no space left on device');
      return real.apply(this, args);
    } as typeof real);

    const out = new Output({ write: () => {}, isTTY: false });
    await expect(
      recordCommand(
        parseArgs(['record', 'generic-openai', '--', process.execPath, agent]),
        out,
        workspace,
      ),
    ).rejects.toThrow();

    const runs = join(workspace, '.orca', 'runs');
    const ids = await readdir(runs).catch(() => []);
    expect(ids.length, 'no run directory was made, so this proves nothing').toBeGreaterThan(0);
    const left = ids.filter((id) => existsSync(join(runs, id, 'agent-spans.jsonl')));
    expect(left, 'the raw spans file outlived an abandoned run').toEqual([]);
  });
});
