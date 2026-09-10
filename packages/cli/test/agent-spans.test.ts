import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateEvent } from '@orcareplay/schema';
import {
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
