import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  PYTHON_ADAPTERS,
  readAgentSpans,
  SITECUSTOMIZE,
  SITECUSTOMIZE_SOURCE,
  type PythonAdapter,
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
  it('narrows its transport before the first span can land in it', async () => {
    // The comment this replaces asserted "`mkdtemp` gives a directory only this user can enter" —
    // true on POSIX, and on Windows the mode is discarded and the directory takes whatever `%TEMP%`
    // hands down. Narrowed before `spans.jsonl` exists, because `icacls` does not re-propagate.
    const runDir = await mkdtemp(join(tmpdir(), 'orca-spans-acl-'));
    const spans = await installAgentSpans(runDir);
    if (process.platform !== 'win32') {
      expect((await stat(spans.transportDir)).mode & 0o777).toBe(0o700);
      return;
    }
    const icacls = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe');
    for (const path of [spans.transportDir, spans.spansPath]) {
      const { stdout } = await promisify(execFile)(icacls, [path]);
      expect(stdout.split(/\r?\n/).filter((l) => l.includes(':(')).length, path).toBe(3);
    }
    // The directory itself owns its ACL rather than inheriting one.
    const { stdout } = await promisify(execFile)(icacls, [spans.transportDir]);
    expect(stdout, spans.transportDir).not.toContain('(I)');
  });
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

  it('keeps a graph node, with the superstep and the ids that pair it', () => {
    const event = eventForSpan({
      kind: 'span',
      type: 'LangGraphNodeStart',
      span_id: 'run-1',
      parent_id: 'graph-1',
      started_at: '2026-09-16T03:46:03.483810+00:00',
      data: { node: 'validate_only', step: 2 },
    });
    expect(event?.type).toBe('graph.node.start');
    expect(event?.attrs).toMatchObject({
      node: 'validate_only',
      step: 2,
      run_id: 'run-1',
      parent_run_id: 'graph-1',
    });
  });

  it('keeps which node raised, and only the class', () => {
    // The node that failed is the first thing anyone asks of a broken graph, and the wire cannot
    // say: a node that dies before calling a model leaves no request at all. The message is not
    // carried, because the adapter has no redactor in front of it.
    const event = eventForSpan({
      kind: 'span',
      type: 'LangGraphNodeEnd',
      span_id: 'run-2',
      ended_at: '2026-09-16T03:46:04.000000+00:00',
      data: { node: 'lookup', step: 3, error: 'ValueError' },
    });
    expect(event?.type).toBe('graph.node.end');
    expect(event?.attrs).toMatchObject({ node: 'lookup', step: 3, error: 'ValueError' });
    expect(event?.attrs['ended_at']).toBe('2026-09-16T03:46:04.000000+00:00');
  });

  it('leaves the superstep out rather than guessing when it is not a number', () => {
    // `attrs` values are scalars the reader prints. A step that arrived as a string would render
    // as a superstep that never existed.
    const event = eventForSpan({
      kind: 'span',
      type: 'LangGraphNodeStart',
      data: { node: 'n', step: '2' },
    });
    expect(event?.attrs).not.toHaveProperty('step', '2');
    expect(event?.attrs['step']).toBeUndefined();
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
      {
        kind: 'span',
        type: 'LangGraphNodeStart',
        span_id: 'r',
        parent_id: 'p',
        data: { node: 'n', step: 1 },
      },
      { kind: 'span', type: 'LangGraphNodeEnd', span_id: 'r', data: { node: 'n', error: 'E' } },
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
    for (const { module } of PYTHON_ADAPTERS) {
      expect(SITECUSTOMIZE_SOURCE).toContain(`from ${module} import install`);
    }
    expect(SITECUSTOMIZE_SOURCE).not.toMatch(/packages[/\\]/);
  });

  it('attaches every adapter in the table, and each independently', () => {
    // One adapter that is absent, or whose `install` raises, must not stop the next from
    // attaching. `else` is what separates those two outcomes: a package that is present and broken
    // is not reported as one that was never installed.
    for (const { module, root, distribution, package: pkg } of PYTHON_ADAPTERS) {
      expect(SITECUSTOMIZE_SOURCE).toContain(`from ${module} import install as _${module}`);
      expect(SITECUSTOMIZE_SOURCE).toContain(`missing["${root}"] = ("${distribution}", "${pkg}")`);
    }
  });

  it('does nothing at all unless orca is recording', () => {
    // It is imported by *every* Python process the run starts, including `python --version`.
    expect(SITECUSTOMIZE_SOURCE).toContain('path = os.environ.get("ORCA_AGENT_SPANS")');
    expect(SITECUSTOMIZE_SOURCE).toContain('if not path:');
  });

  /**
   * Asserted against the code rather than the file, because the file explains itself.
   *
   * `_unavailable`'s docstring names `find_spec("agents.tracing")` — the option it rejects, with
   * the measurement that rejected it. A test that searched the whole source would trip on the
   * prose describing what the code does not do.
   */
  const bootstrapCode = (): string =>
    SITECUSTOMIZE_SOURCE.replace(/"""[\s\S]*?"""/g, '').replace(/^\s*#.*$/gm, '');

  it('confirms with distribution metadata before it reports anything', () => {
    // Seeing a module name imported is where the question starts, not where it is answered:
    // `agents.py` is an ordinary name for an ordinary module, and measured, a project with its own
    // two-line `agents.py` and `PYTHONPATH=.` on a machine with no SDK was told to install the
    // adapter. `importlib.metadata` asks which distribution provides that name.
    expect(bootstrapCode()).toContain('importlib.metadata.distribution(distribution)');
    // And it never *asks* whether a name resolves. It defines `find_spec` — that is how a finder
    // is told an import is happening — but calling one on a name would be the rejected design, and
    // the expensive one: `find_spec("agents.tracing")` costs 2066ms because resolving a submodule
    // spec imports the parent.
    expect(bootstrapCode()).not.toMatch(/find_spec\s*\(\s*["']/);
  });

  it('never imports what it is asking about', () => {
    // Measured on this machine: `distribution("openai-agents")` 2.3ms, `import agents` 1973ms —
    // and `find_spec("agents.tracing")`, the specific-looking middle option, **2066ms**, because
    // resolving a submodule spec imports the parent. This file is in front of every Python process
    // the recording starts, on an interpreter that starts in 50ms.
    for (const { root } of PYTHON_ADAPTERS) {
      expect(bootstrapCode()).not.toMatch(new RegExp(String.raw`^\s*import ${root}\b`, 'm'));
    }
    expect(bootstrapCode()).not.toContain('agents.tracing');
  });

  it('reports a framework only once the agent imports it', () => {
    // The whole reason the watcher exists. Installed is not used, and a machine with several
    // frameworks lying around would otherwise be told to install an adapter for each of them on
    // every recorded run.
    expect(bootstrapCode()).toContain('class _WhenImported:');
    expect(bootstrapCode()).toContain('sys.meta_path.insert(0, _WhenImported(path, missing))');
    // Armed only for what is actually missing, so a fully equipped machine carries nothing.
    expect(bootstrapCode()).toContain('if missing:');
  });

  it('never claims a module it is asked about', () => {
    // The watcher observes imports; it must not participate in them. Every path through
    // `find_spec` returns None, so the ordinary finders load the framework exactly as they would
    // have — a debugging aid that changed how a package resolves would be a far worse trade than
    // one that captured nothing.
    const body = bootstrapCode().slice(bootstrapCode().indexOf('def find_spec'));
    const returns = body.slice(0, body.indexOf('\ndef ') + 1).match(/^\s+return .*/gm) ?? [];
    expect(returns.length).toBeGreaterThan(0);
    for (const line of returns) expect(line.trim()).toBe('return None');
  });

  it('lets no failure of its own reach the agent', () => {
    // Every import and call is guarded. A capture layer that can break the run it is capturing is
    // worse than one that captures nothing.
    const guarded = SITECUSTOMIZE_SOURCE.split('except Exception:').length - 1;
    expect(guarded).toBeGreaterThanOrEqual(3 + PYTHON_ADAPTERS.length);
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
   * The failure this whole warning exists for, end to end — and the false positive it must not be.
   *
   * Before the warning, uninstalling the package and recording the same agent moved the trace from
   * 15 events to 11 and printed nothing at all: the same `recorded … exit=0`, byte for byte. Every
   * other capture layer says when it did not fire — MCP warns `mcp.not_wired`, the proxy warns
   * `capture.empty`. This one was the exception.
   *
   * The first version of the warning then fired on the wrong runs, which is the other half of what
   * these pin. Both fixtures go on PYTHONPATH rather than beside the agent, and that is a property
   * of the mechanism rather than a convenience: measured, `sitecustomize` runs while `sys.path[0]`
   * is still the PYTHONPATH entry — the script's own directory is not added until afterwards.
   */

  /** An origin that answers one chat completion, so a run has a model exchange to have lost. */
  async function stubOrigin(): Promise<{ url: string; stop: () => void }> {
    const body = JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 1756000000,
      model: 'stub-1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}`, stop: () => server.close() };
  }

  /** Record `agentSource`, with `shadows` on PYTHONPATH and a stub origin behind the proxy. */
  async function recordWith(
    agentSource: string,
    shadows: string,
  ): Promise<{ said: string[]; exitCode: number; exchanges: number }> {
    const agent = join(workspace, 'agent.py');
    await writeFile(agent, agentSource);
    const origin = await stubOrigin();
    const said: string[] = [];
    const out = new Output({ write: (line: string) => said.push(line), isTTY: false });
    const previousPath = process.env['PYTHONPATH'];
    const previousKey = process.env['OPENAI_API_KEY'];
    process.env['PYTHONPATH'] = shadows;
    process.env['OPENAI_API_KEY'] = 'stub-key';
    try {
      const result = await recordCommand(
        parseArgs([
          'record',
          'generic-openai',
          '--upstream-openai',
          origin.url,
          '--',
          'python',
          agent,
        ]),
        out,
        workspace,
      );
      return { said, exitCode: result.exitCode, exchanges: result.modelExchanges };
    } finally {
      origin.stop();
      if (previousPath === undefined) delete process.env['PYTHONPATH'];
      else process.env['PYTHONPATH'] = previousPath;
      if (previousKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previousKey;
    }
  }

  /**
   * Every adapter absent, deterministically, whatever this machine has installed.
   *
   * All of them rather than the one under test: the bootstrap installs each adapter in
   * `PYTHON_ADAPTERS`, and a machine that happens to have one of the others would otherwise make
   * this suite's assertions depend on what is in its site-packages. The venv here has both
   * langgraph and openai-agents, which is how that stopped being hypothetical.
   */
  async function withoutAdapters(dir: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    for (const { module } of PYTHON_ADAPTERS) {
      await writeFile(
        join(dir, `${module}.py`),
        'raise ImportError("stands in for a machine without the package")\n',
      );
    }
    return dir;
  }

  /**
   * A framework the agent can import, and the distribution metadata that confirms it.
   *
   * Both halves matter, and they are the two questions the bootstrap asks in order: it notices the
   * *module* being imported, then asks `importlib.metadata` which *distribution* provides that
   * name. A stub module with no metadata is the `agents.py` false positive; metadata with no
   * module is a framework nobody used.
   *
   * Shadowed rather than relying on the real package, so the test says the same thing on a machine
   * that has the framework and one that does not — and so it does not pay a two-second SDK import.
   */
  async function frameworkPresent(dir: string, adapter: PythonAdapter): Promise<void> {
    await writeFile(join(dir, `${adapter.root}.py`), 'VALUE = 1\n');
    const distInfo = join(dir, `${adapter.distribution.replace(/-/g, '_')}-9.9.9.dist-info`);
    await mkdir(distInfo, { recursive: true });
    await writeFile(
      join(distInfo, 'METADATA'),
      `Metadata-Version: 2.1\nName: ${adapter.distribution}\nVersion: 9.9.9\n`,
    );
  }

  const ADAPTER_BY_PACKAGE = (pkg: string): PythonAdapter => {
    const found = PYTHON_ADAPTERS.find((entry) => entry.package === pkg);
    if (found === undefined) throw new Error(`no adapter named ${pkg}`);
    return found;
  };

  /** One model call through whatever base URL orca set, needing no SDK installed. */
  const CALLS_A_MODEL = [
    'import json, os, urllib.request',
    'base = os.environ["OPENAI_BASE_URL"].rstrip("/")',
    'req = urllib.request.Request(',
    '    base + "/chat/completions",',
    '    data=json.dumps({"model": "stub-1", "messages": [{"role": "user", "content": "hi"}]}).encode(),',
    '    headers={"content-type": "application/json", "authorization": "Bearer stub-key"},',
    ')',
    'urllib.request.urlopen(req, timeout=30).read()',
    'print("GOT: done")',
  ].join('\n');

  it.each(PYTHON_ADAPTERS.map((adapter) => [adapter.package, adapter] as const))(
    'says so when the agent uses the framework and %s is not there',
    async (pkg, adapter) => {
      const shadows = await withoutAdapters(join(workspace, 'shadows'));
      await frameworkPresent(shadows, adapter);

      const { said, exitCode, exchanges } = await recordWith(
        `import ${adapter.root}\n${CALLS_A_MODEL}`,
        shadows,
      );

      expect(
        exchanges,
        'the run made no model call, so the gate below is untested',
      ).toBeGreaterThan(0);
      const warning = said.find(
        (line) => line.includes('agent_spans.unavailable') && line.includes(pkg),
      );
      expect(warning, `no warning for ${pkg} in:\n${said.join('')}`).toBeTruthy();
      // Its own explanation, not the first adapter's. When this text was one constant, adding a
      // second adapter produced a warning that named langgraph and described the Agents SDK.
      expect(warning).toContain(adapter.distribution);
      expect(warning).toContain(adapter.lost);
      expect(warning).toContain(`pip install ${pkg}`);
      // A warning, not a failure: the run is still a run, and the model traffic in it is real.
      expect(exitCode).toBe(0);
    },
    60_000,
  );

  it('says nothing about a framework the agent never imported', async () => {
    // Installed is not used. An ordinary machine has frameworks lying around that a given run has
    // no relationship to — this venv has two — and asking `importlib.metadata` at startup would
    // tell every recorded run on it to install every adapter orca ships. A warning that fires when
    // nothing is wrong is how warnings stop being read.
    const shadows = await withoutAdapters(join(workspace, 'shadows'));
    for (const adapter of PYTHON_ADAPTERS) await frameworkPresent(shadows, adapter);

    const { said, exchanges } = await recordWith(CALLS_A_MODEL, shadows);

    expect(exchanges).toBeGreaterThan(0);
    expect(said.join('')).not.toContain('agent_spans.unavailable');
  }, 60_000);

  // The lookalike case — a project's own `agents.py` — is asserted in the `-S` suite below and not
  // here, for the reason that suite gives: this level keeps site-packages, so on a machine that
  // really has the framework installed a warning is correct however the module resolved, and the
  // test would be asserting a property of the machine.

  it('stays quiet for a run that made no model call', async () => {
    // A run with no model exchange lost no structure worth a `pip install`, and `capture.empty`
    // already says the larger thing that went wrong — naming a package on top of that sends
    // someone to a package manager over a problem that is not about a package.
    const shadows = await withoutAdapters(join(workspace, 'shadows'));
    const adapter = ADAPTER_BY_PACKAGE('orcareplay-openai-agents');
    await frameworkPresent(shadows, adapter);

    const { said, exchanges } = await recordWith(
      `import ${adapter.root}\nprint("GOT: done")\n`,
      shadows,
    );

    expect(exchanges).toBe(0);
    expect(said.join('')).not.toContain('agent_spans.unavailable');
    expect(said.join(''), 'the larger problem should still be reported').toContain('capture.empty');
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
    ).toEqual({ unavailable: [], dropped: 0, droppedBy: [] });
  });

  it('says which adapter lost records, where the record says', () => {
    // Several adapters write to one transport, so a total says how much was lost and nothing about
    // where to look. The field is read here rather than merely written: `_dropped` in the first
    // adapter was counted from the start and consumed by nothing, which is how a field becomes
    // payload.
    const losses = agentSpanLosses([
      { kind: 'dropped', count: 2, package: 'orcareplay-langgraph' },
      { kind: 'dropped', count: 1, package: 'orcareplay-openai-agents' },
      { kind: 'dropped', count: 4 },
    ] as never[]);
    expect(losses.dropped).toBe(7);
    expect(losses.droppedBy).toEqual(['orcareplay-langgraph', 'orcareplay-openai-agents']);
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
   * Run the real bootstrap against a path arranged three ways.
   *
   * `-S` and the explicit import, rather than letting `site` load it: this interpreter is whichever
   * one is on PATH, and the one the repository uses to run its checks has both the SDK **and** the
   * adapter installed — so none of the three could be arranged by adding files. `-S` drops
   * site-packages and keeps `PYTHONPATH`, which makes all three a property of what this test writes
   * rather than of the machine it runs on. It is also the only level at which the lookalike case
   * below can be asserted at all: on a machine with the SDK installed, a run that warns is warning
   * correctly, whatever else is on the path. What `-S` gives up is `site` importing `sitecustomize`
   * by itself, and that is covered by the end-to-end record above.
   */
  /**
   * What the interpreter is given: a module it can import, metadata that names a distribution
   * providing it, and what the process then imports. The three are independent because the three
   * cases that matter differ in exactly one of them.
   */
  interface Fixture {
    name: string;
    /** Adapters whose framework module exists on the path. */
    modules?: readonly PythonAdapter[];
    /** Adapters whose framework distribution metadata exists on the path. */
    metadata?: readonly PythonAdapter[];
    /** What the process imports after the bootstrap has run. */
    imports?: readonly string[];
  }

  async function runBootstrap(fixture: Fixture): Promise<string> {
    const boot = join(bootRoot, fixture.name);
    const spans = join(bootRoot, `${fixture.name}.jsonl`);
    await mkdir(boot, { recursive: true });
    await writeFile(join(boot, 'sitecustomize.py'), SITECUSTOMIZE_SOURCE);
    for (const { root } of fixture.modules ?? []) {
      await writeFile(join(boot, `${root}.py`), 'VALUE = 1\n');
    }
    for (const { distribution } of fixture.metadata ?? []) {
      const distInfo = join(boot, `${distribution.replace(/-/g, '_')}-9.9.9.dist-info`);
      await mkdir(distInfo, { recursive: true });
      await writeFile(
        join(distInfo, 'METADATA'),
        `Metadata-Version: 2.1\nName: ${distribution}\nVersion: 9.9.9\n`,
      );
    }
    const program = ['import sitecustomize', ...(fixture.imports ?? []).map((m) => `import ${m}`)];
    await exec(python as string, ['-S', '-c', program.join('; ')], {
      env: { ...process.env, PYTHONPATH: boot, ORCA_AGENT_SPANS: spans },
    });
    return await readFile(spans, 'utf8').catch(() => '');
  }

  it.each(PYTHON_ADAPTERS.map((adapter) => [adapter.package, adapter] as const))(
    'says so when the agent imports the framework and %s is not there',
    async (pkg, adapter) => {
      if (!python) return; // no interpreter here; CI has one and asserts this
      const written = await runBootstrap({
        name: `used-${adapter.root}`,
        modules: [adapter],
        metadata: [adapter],
        imports: [adapter.root],
      });
      expect(agentSpanLosses(readSpansText(written)).unavailable).toEqual([pkg]);
    },
  );

  it('stays quiet about a framework that is installed and never imported', async () => {
    if (!python) return;
    // Installed is not used, and this is the case that made the distinction worth drawing: this
    // venv has both frameworks, so reporting on what is installed meant every recorded run on it
    // was told to install two adapters it had no relationship to. The count grows with every
    // adapter orca ships, and a warning that fires when nothing is wrong is how warnings stop
    // being read.
    expect(
      await runBootstrap({
        name: 'installed-unused',
        modules: PYTHON_ADAPTERS,
        metadata: PYTHON_ADAPTERS,
      }),
    ).toBe('');
  });

  it('stays quiet for a project whose own module happens to be called agents', async () => {
    if (!python) return;
    // The false positive #83 was about, still guarded. Noticing the import is where the question
    // starts; `importlib.metadata` is what answers it. A project with a two-line `agents.py` and
    // `PYTHONPATH=.`, on a machine with no SDK at all, was told "the agent imported the OpenAI
    // Agents SDK" and sent to `pip install` a package it has no use for.
    const agents = PYTHON_ADAPTERS.find((entry) => entry.root === 'agents')!;
    expect(
      await runBootstrap({ name: 'lookalike-module', modules: [agents], imports: ['agents'] }),
    ).toBe('');
  });

  it('stays quiet for a Python process that is not an agent', async () => {
    if (!python) return;
    // `orca record` exports ORCA_AGENT_SPANS to every child. Without this guard a run whose agent
    // shells out to `python` would warn about a package that process had no use for.
    expect(await runBootstrap({ name: 'nothing' })).toBe('');
  });

  it('reports a framework once, however many of its modules are imported', async () => {
    if (!python) return;
    // The watcher is asked for every submodule of an ordinary framework import — measured, 164
    // times for one `from langgraph.graph import StateGraph`. Reporting per `find_spec` would turn
    // one fact into a screenful.
    const adapter = PYTHON_ADAPTERS.find((entry) => entry.root === 'langgraph')!;
    const written = await runBootstrap({
      name: 'many-submodules',
      modules: [adapter],
      metadata: [adapter],
      imports: ['langgraph', 'langgraph', 'langgraph'],
    });
    expect(readSpansText(written)).toHaveLength(1);
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
