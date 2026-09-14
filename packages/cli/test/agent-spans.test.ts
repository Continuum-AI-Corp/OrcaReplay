import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateEvent } from '@orcareplay/schema';
import {
  agentSpanLosses,
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

  /**
   * A line that parsed is not yet a span, and this reader hands what it read straight on.
   *
   * `eventForSpan` reads `.kind` off whatever it is given, and the drain runs after the agent has
   * exited — where a throw is caught by `recordCommand`, which disposes of the transport and
   * rethrows. The run then has no `run.end`, `verifyIntegrity` calls it tampered with, and the
   * spans that were never read are gone with the transport. Every Python process the run starts
   * appends here, so a line that is valid JSON and not a span is an interleaved write away.
   */
  it('skips a line that parsed to something that is not a span', async () => {
    const path = join(dir, 'spans.jsonl');
    await writeFile(
      path,
      [
        'null',
        '7',
        '"a string"',
        '[1,2]',
        '{"kind":"span","type":"HandoffSpanData","data":{}}',
        '',
      ].join('\n'),
      'utf8',
    );

    const spans = await readAgentSpans(path);
    expect(spans).toHaveLength(1);
    for (const span of spans) expect(() => eventForSpan(span)).not.toThrow();
  });

  it('recovers a span from a line a short write left holding a fragment too', async () => {
    // The same rule the other two transports got: the torn record is unrecoverable, the whole one
    // stuck to it is not.
    const whole =
      '{"kind":"span","type":"HandoffSpanData","span_id":"s1","data":{"from_agent":"A","to_agent":"B"}}';
    const path = join(dir, 'spans.jsonl');
    await writeFile(path, `{"kind":"span","type${whole}\n`, 'utf8');

    const spans = await readAgentSpans(path);
    expect(spans, 'a span written in full went with the fragment glued to it').toHaveLength(1);
    expect(spans[0]!.span_id).toBe('s1');
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
    expect(SITECUSTOMIZE_SOURCE).toContain('path = os.environ.get("ORCA_AGENT_SPANS")');
    expect(SITECUSTOMIZE_SOURCE).toContain('if not path:');
  });

  it('asks whether the SDK is there rather than importing it', () => {
    // Measured on this machine: `find_spec("agents")` is 0.5ms and `import agents` is 1973ms, on an
    // interpreter that starts in 50ms. This file is in front of every Python process the recording
    // starts, so the import would put two seconds on each of them — including `python --version`.
    expect(SITECUSTOMIZE_SOURCE).toContain('importlib.util.find_spec("agents")');
    expect(SITECUSTOMIZE_SOURCE).not.toMatch(/^\s*import agents\b/m);
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

  /**
   * The failure this whole warning exists for, end to end.
   *
   * Before it, uninstalling the package and recording the same agent moved the trace from 15 events
   * to 11 and printed nothing at all — the same `recorded … exit=0`, byte for byte. Every other
   * capture layer says when it did not fire: MCP warns `mcp.not_wired`, the proxy warns
   * `capture.empty`. This one was the exception, and it is the *default* state until the package is
   * on PyPI.
   */
  it('says so when the SDK is there and the adapter is not', async () => {
    // Both shadows go on PYTHONPATH rather than next to the agent, and the difference is a real
    // property of the mechanism rather than a detail of the test: measured, `sitecustomize` runs
    // while `sys.path[0]` is still the PYTHONPATH entry — the script's own directory is not added
    // until afterwards. So the bootstrap's `find_spec` sees PYTHONPATH and site-packages, and
    // nothing the agent happens to sit beside.
    //
    // Going through PYTHONPATH also makes this say the same thing on a machine that has the real
    // package installed — every machine running this suite does — and on one that does not, and it
    // exercises orca keeping the caller's PYTHONPATH rather than replacing it.
    const shadows = join(workspace, 'shadows');
    await mkdir(shadows, { recursive: true });
    await writeFile(
      join(shadows, 'orcareplay_openai_agents.py'),
      'raise ImportError("stands in for a machine without the package")\n',
    );
    await writeFile(join(shadows, 'agents.py'), '# stands in for the SDK\n');
    const agent = join(workspace, 'agent.py');
    await writeFile(agent, 'print("GOT: done")\n');

    const said: string[] = [];
    const out = new Output({ write: (line: string) => said.push(line), isTTY: false });
    const previousPath = process.env['PYTHONPATH'];
    process.env['PYTHONPATH'] = shadows;
    let result;
    try {
      result = await recordCommand(
        parseArgs(['record', 'generic-openai', '--', 'python', agent]),
        out,
        workspace,
      );
    } finally {
      if (previousPath === undefined) delete process.env['PYTHONPATH'];
      else process.env['PYTHONPATH'] = previousPath;
    }

    const warning = said.find((line) => line.includes('agent_spans.unavailable'));
    expect(warning, `no warning in:\n${said.join('')}`).toBeTruthy();
    expect(warning).toContain('orcareplay-openai-agents');
    // A warning, not a failure: the run is still a run, and the model traffic in it is still real.
    expect(result.exitCode).toBe(0);
  }, 60_000);
});

/**
 * What the layer says when it captured nothing — the two ways it can come back empty.
 *
 * `_dropped` was counted from the first version and read by nothing, and the bootstrap's
 * `except ImportError` was silent, so both failures reached the operator as an absence: the same
 * `recorded … exit=0`, no agent events, no warning. Measured before this: uninstalling the package
 * and recording the same agent moved the trace from 15 events to 11 and printed nothing at all.
 */
describe('agentSpanLosses', () => {
  it('finds nothing to report in an ordinary run', () => {
    expect(
      agentSpanLosses([
        { kind: 'trace.start' },
        { kind: 'span', type: 'HandoffSpanData' },
        { kind: 'trace.end' },
      ]),
    ).toEqual({ unavailable: [], dropped: 0 });
  });

  it('reports a missing adapter once however many processes said so', () => {
    // The bootstrap runs in every Python process the recording starts, so an agent that shells out
    // to `python` writes this line once per child. Six lines are one fact; reporting it six times
    // reads like six failures.
    const spans = Array.from({ length: 6 }, () => ({
      kind: 'unavailable',
      package: 'orcareplay-openai-agents',
    }));
    expect(agentSpanLosses(spans).unavailable).toEqual(['orcareplay-openai-agents']);
  });

  it('keeps two different missing adapters apart', () => {
    expect(
      agentSpanLosses([
        { kind: 'unavailable', package: 'orcareplay-langgraph' },
        { kind: 'unavailable', package: 'orcareplay-openai-agents' },
        { kind: 'unavailable', package: 'orcareplay-langgraph' },
      ]).unavailable,
    ).toEqual(['orcareplay-langgraph', 'orcareplay-openai-agents']);
  });

  it('sums dropped counts rather than taking one', () => {
    // One `dropped` line per process, and the counts are of different records, so they add.
    expect(
      agentSpanLosses([
        { kind: 'dropped', count: 2 },
        { kind: 'span', type: 'AgentSpanData' },
        { kind: 'dropped', count: 3 },
      ]).dropped,
    ).toBe(5);
  });

  it('ignores a count that is not a usable number', () => {
    // The file is appended to by a process orca does not own, and a torn line can reparse into
    // anything. A `dropped` whose count is a string must not become `NaN` in a warning.
    for (const count of ['4', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      expect(agentSpanLosses([{ kind: 'dropped', count } as never]).dropped).toBe(0);
    }
  });

  it('falls back to the package it is written by when the name is missing', () => {
    for (const span of [{ kind: 'unavailable' }, { kind: 'unavailable', package: '' }]) {
      expect(agentSpanLosses([span as never]).unavailable).toEqual(['orcareplay-openai-agents']);
    }
  });

  it('does not turn either record into a trace event', () => {
    // They are for the operator, now, while the run is still on screen — not for the trace, which
    // has no event type for "this did not happen".
    expect(eventForSpan({ kind: 'unavailable', package: 'x' })).toBeUndefined();
    expect(eventForSpan({ kind: 'dropped', count: 3 } as never)).toBeUndefined();
  });
});

/**
 * The bootstrap's half, run rather than read.
 *
 * A string assertion cannot tell whether the guard is in the right place, and this one is subtle:
 * the marker must be written when the SDK is importable and the adapter is not, and *not* written
 * when neither is — because `orca record` puts this file in front of every `python` in the run and
 * most of them are not agents.
 */
describe('the bootstrap reports a missing adapter', () => {
  const exec = promisify(execFile);
  let python: string | undefined;
  let bootRoot: string;

  beforeEach(async () => {
    bootRoot = await mkdtemp(join(tmpdir(), 'orca-bootstrap-'));
    for (const candidate of ['python3', 'python']) {
      try {
        await exec(candidate, ['-c', 'pass']);
        python = candidate;
        break;
      } catch {
        python = undefined;
      }
    }
  });

  afterEach(async () => {
    await rm(bootRoot, { recursive: true, force: true });
  });

  /**
   * Run the real bootstrap against a path that has the SDK on it, or does not.
   *
   * `-S` and the explicit import, rather than letting `site` load it: this interpreter is whichever
   * one is on PATH, and the one the repository uses to run its checks has both the SDK **and** the
   * adapter installed — so neither half of this could be arranged by adding files. `-S` drops
   * site-packages and keeps `PYTHONPATH`, which makes both halves a property of what this test
   * writes rather than of the machine it runs on. What `-S` gives up is `site` importing
   * `sitecustomize` by itself, and that is asserted separately, by the end-to-end record above.
   */
  async function runBootstrap(withSdk: boolean): Promise<string> {
    const boot = join(bootRoot, withSdk ? 'with' : 'without');
    const spans = join(bootRoot, `${withSdk ? 'with' : 'without'}.jsonl`);
    await mkdir(boot, { recursive: true });
    await writeFile(join(boot, 'sitecustomize.py'), SITECUSTOMIZE_SOURCE);
    // A module, not an installed SDK: the bootstrap asks `find_spec`, which answers about the path.
    if (withSdk) await writeFile(join(boot, 'agents.py'), '# stands in for the SDK\n');
    await exec(python as string, ['-S', '-c', 'import sitecustomize'], {
      env: { ...process.env, PYTHONPATH: boot, ORCA_AGENT_SPANS: spans },
    });
    return await readFile(spans, 'utf8').catch(() => '');
  }

  it('says so when the SDK is there and the adapter is not', async () => {
    if (!python) return; // no interpreter here; CI has one and asserts this
    const written = await runBootstrap(true);
    expect(agentSpanLosses(readSpansText(written)).unavailable).toEqual([
      'orcareplay-openai-agents',
    ]);
  });

  it('stays quiet for a Python process that is not an agent', async () => {
    if (!python) return;
    // `orca record` exports ORCA_AGENT_SPANS to every child. Without this guard a run whose agent
    // shells out to `python` would warn about a package that process had no use for.
    expect(await runBootstrap(false)).toBe('');
  });

  it('never fails the process it is loaded into', async () => {
    if (!python) return;
    // Both directions already ran above without throwing — `exec` rejects on a non-zero exit — so
    // this pins the promise rather than re-testing the mechanism: the bootstrap is in front of
    // every `python` in the run, and a traceback here is a failure of the run.
    const boot = join(bootRoot, 'boot2');
    await mkdir(boot, { recursive: true });
    await writeFile(join(boot, 'sitecustomize.py'), SITECUSTOMIZE_SOURCE);
    const { stdout } = await exec(python, ['-c', 'print("ok")'], {
      env: {
        ...process.env,
        PYTHONPATH: boot,
        // A path no process can append to, which is what a wedged transport looks like.
        ORCA_AGENT_SPANS: join(bootRoot, 'no', 'such', 'dir', 'spans.jsonl'),
      },
    });
    expect(stdout.trim()).toBe('ok');
  });
});

/** The records on a transport's text, the way `readAgentSpans` would have them. */
function readSpansText(text: string): { kind: string }[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { kind: string });
}
