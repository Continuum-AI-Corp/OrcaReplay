import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateEvent } from '@orcareplay/schema';
import {
  discardAgentSpanTransport,
  eventForSpan,
  installAgentSpans,
  pythonPathWith,
  readAgentSpans,
  SITECUSTOMIZE,
  SITECUSTOMIZE_SOURCE,
} from '../src/agent-spans.js';
import { parseArgs } from '../src/args.js';
import { recordCommand } from '../src/commands/record.js';
import { Output } from '../src/out.js';

const here = dirname(fileURLToPath(import.meta.url));
let seq = 0;
const result_seq = () => (seq += 1);

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
    expect(await readAgentSpans(path)).toHaveLength(1);
  });

  it('is empty when there is no file, because that is the ordinary case', async () => {
    expect(await readAgentSpans(join(dir, 'nothing.jsonl'))).toEqual([]);
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
 * The transport is not part of the trace, and the tests say so in both directions.
 *
 * It is written by the agent's own interpreter, so nothing orca owns can redact it on the way in.
 * While it sat in the run directory that made it a sink the write path never touched, `orca scrub`
 * never rewrote — it reaches `events.jsonl`, the manifest and the blobs, and nothing else — and
 * nobody deleted. A run whose secret was only in that file answered `orca scrub --match` with
 * "nothing matched — the trace is unchanged", which SECURITY.md calls the one failure a scrubber
 * must not have.
 */
describe('the spans transport is not in the trace', () => {
  const exec = promisify(execFile);
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-transport-'));
    await exec('git', ['init', '-q'], { cwd: workspace });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: workspace });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('puts the transport outside the run directory, and the bootstrap inside', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'orca-run-'));
    const capture = await installAgentSpans(runDir);
    expect(capture.spansPath.startsWith(runDir), 'the transport is in the run directory').toBe(
      false,
    );
    expect(capture.transportDir.startsWith(runDir)).toBe(false);
    expect(capture.pythonPath.startsWith(runDir), 'the bootstrap belongs with the run').toBe(true);
    // Existence, not mode: the mode assertion below can only run on POSIX, and without this a
    // pre-create that stopped happening would be caught on Linux and nowhere else.
    expect(existsSync(capture.spansPath), 'orca did not create the transport itself').toBe(true);
    await rm(runDir, { recursive: true, force: true });
    await rm(capture.transportDir, { recursive: true, force: true });
  });

  // POSIX only, for the reason writer.test.ts states: NTFS has no mode bits, so `stat` answers
  // 0o666 whatever was asked for. Skipped rather than loosened.
  it.skipIf(process.platform === 'win32')(
    'creates the transport 0600 rather than leaving it to the agent’s umask',
    async () => {
      const runDir = await mkdtemp(join(tmpdir(), 'orca-run-'));
      const capture = await installAgentSpans(runDir);
      // SECURITY.md: "Trace files and blobs are written mode 0600."
      expect((await stat(capture.spansPath)).mode & 0o777).toBe(0o600);
      await rm(runDir, { recursive: true, force: true });
      await rm(capture.transportDir, { recursive: true, force: true });
    },
  );

  it('discardAgentSpanTransport takes the directory, not a listing of it', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'orca-run-'));
    const capture = await installAgentSpans(runDir);
    // A producer that appeared after any listing would have been taken with it.
    await writeFile(`${capture.spansPath}.9999`, '{}\n');
    expect(await discardAgentSpanTransport(capture.transportDir)).toBeUndefined();
    expect(existsSync(capture.transportDir)).toBe(false);
    await rm(runDir, { recursive: true, force: true });
  });

  it('reports rather than throws when the transport cannot be removed', async () => {
    expect(await discardAgentSpanTransport(join(tmpdir(), 'orca-spans-never-existed'))).toBe(
      undefined,
    );
  });

  /**
   * End to end, which is the only level at which "nothing is left in the trace" can be asserted:
   * the agent writes a span carrying a credential, and afterwards the run directory holds neither
   * the file nor the credential — while the events it was for are still in `events.jsonl`.
   */
  it('leaves no spans file and no payload in the run directory, and still records the events', async () => {
    const pkg = join(here, '..', '..', '..', 'python-openai-agents');
    const secret = 'sk-transportcanary0123456789abcd';
    // Unique to this run, and one of the fields the allow-list does keep — so it is present in the
    // transport while the transport exists, which is what makes its absence afterwards meaningful.
    const marker = `Triage-${process.pid}-${result_seq()}`;
    const agent = join(workspace, 'agent.py');
    await writeFile(
      agent,
      [
        'import os, sys',
        `sys.path.insert(0, ${JSON.stringify(pkg)})`,
        'from orcareplay_openai_agents import OrcaTracingProcessor',
        'secret = os.environ["CANARY"]',
        'class AgentSpanData:',
        '    def export(self):',
        `        return {"name": ${JSON.stringify(marker)}, "handoffs": ["Billing"], "tools": ["t"],`,
        '                "output_type": "str", "instructions": secret}',
        'class FunctionSpanData:',
        '    def export(self):',
        '        return {"name": "run_shell", "output": secret}',
        'class Span:',
        '    def __init__(self, d, i):',
        '        self.span_data = d; self.span_id = i; self.parent_id = None; self.trace_id = "t"',
        '        self.started_at = "2026-09-13T00:00:00+00:00"',
        '        self.ended_at = "2026-09-13T00:00:01+00:00"',
        '        self.error = {"data": {"echoed": secret}}',
        'p = OrcaTracingProcessor()',
        'p.on_span_end(Span(AgentSpanData(), "a"))',
        'p.on_span_end(Span(FunctionSpanData(), "f"))',
        'print("GOT: done")',
      ].join('\n'),
    );

    const out = new Output({ write: () => {}, isTTY: false });
    const previous = process.env['CANARY'];
    process.env['CANARY'] = secret;
    let result;
    try {
      result = await recordCommand(
        parseArgs(['record', 'generic-openai', '--', 'python', agent]),
        out,
        workspace,
      );
    } finally {
      if (previous === undefined) delete process.env['CANARY'];
      else process.env['CANARY'] = previous;
    }
    expect(result.runId).toBeTruthy();

    const runDir = join(workspace, '.orca', 'runs', result.runId);
    const left = await readdir(runDir);
    expect(
      left.filter((f) => f.startsWith('agent-spans')),
      'the transport is in the trace',
    ).toEqual([]);

    const holders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else {
          const text = await readFile(full, 'utf8').catch(() => '');
          if (text.includes(secret)) holders.push(full.slice(runDir.length + 1));
        }
      }
    };
    await walk(runDir);
    expect(holders, 'the credential reached the run directory').toEqual([]);

    // The transport is outside the run directory, so "nothing left in the trace" cannot see it
    // being left behind. Look where it actually lives. The marker is the agent's name rather than
    // the credential, because the allow-list means the credential never reaches the file even when
    // the file survives — so a canary would answer the wrong question.
    const temp = tmpdir();
    const strays: string[] = [];
    for (const entry of await readdir(temp, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('orca-spans-')) continue;
      const file = join(temp, entry.name, 'agent-spans.jsonl');
      const text = await readFile(file, 'utf8').catch(() => '');
      if (text.includes(marker)) strays.push(file);
    }
    expect(strays, 'the transport outlived the run').toEqual([]);

    // And the layer still did its job.
    const events = await readFile(join(runDir, 'events.jsonl'), 'utf8');
    const types = events
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toContain('agent.start');
    expect(events).toContain(marker);
  }, 60_000);
});
