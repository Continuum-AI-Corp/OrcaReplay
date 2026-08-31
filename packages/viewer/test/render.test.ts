import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildTimeline,
  detectLoops,
  formatBytes,
  formatDuration,
  formatTokens,
  kindForType,
  summarize,
} from '../src/render.js';
import { ev, manifest, resetSeq, snap } from './fixtures.js';

beforeEach(() => resetSeq());

describe('kindForType', () => {
  it('maps every spec event type to a short uppercase token', () => {
    expect(kindForType('model.request')).toBe('MODEL');
    expect(kindForType('model.response')).toBe('MODEL');
    expect(kindForType('tool.call')).toBe('TOOL');
    expect(kindForType('tool.result')).toBe('TOOL');
    expect(kindForType('shell.exec')).toBe('SHELL');
    expect(kindForType('shell.result')).toBe('SHELL');
    expect(kindForType('fs.change')).toBe('FILE');
    expect(kindForType('fs.snapshot')).toBe('SNAP');
    expect(kindForType('mcp.request')).toBe('MCP');
    expect(kindForType('mcp.response')).toBe('MCP');
    expect(kindForType('error')).toBe('ERROR');
    expect(kindForType('divergence')).toBe('DIVERGE');
    expect(kindForType('note')).toBe('NOTE');
    expect(kindForType('route.decision')).toBe('ROUTE');
    expect(kindForType('run.start')).toBe('RUN');
    expect(kindForType('run.end')).toBe('RUN');
    expect(kindForType('checkpoint')).toBe('CKPT');
    expect(kindForType('fork')).toBe('FORK');
    expect(kindForType('net.request')).toBe('NET');
  });

  it('derives a token for unknown types instead of failing (spec §2.3)', () => {
    expect(kindForType('vendor.thing' as never)).toBe('VENDOR');
    expect(kindForType('' as never)).toBe('EVENT');
  });
});

describe('buildTimeline', () => {
  it('carries seq and turn through unchanged', () => {
    const rows = buildTimeline([ev({ type: 'run.start', turn: 0 }), ev({ type: 'note', turn: 3 })]);
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows.map((r) => r.turn)).toEqual([0, 3]);
  });

  it('labels a model exchange with the model and token usage', () => {
    const rows = buildTimeline([
      ev({
        type: 'model.request',
        actor: 'model',
        attrs: { model: 'claude-opus-4', messages: 12 },
      }),
      ev({
        type: 'model.response',
        actor: 'model',
        attrs: {
          model: 'claude-opus-4',
          stop_reason: 'tool_use',
          usage: { input_tokens: 8412, output_tokens: 121 },
        },
      }),
    ]);
    expect(rows[0]!.kind).toBe('MODEL');
    expect(rows[0]!.label).toBe('claude-opus-4');
    expect(rows[0]!.detail).toContain('12 messages');
    expect(rows[1]!.meta).toContain('8,412');
    expect(rows[1]!.detail).toContain('tool_use');
    expect(rows[0]!.tone).toBe('normal');
  });

  it('marks a non-zero shell exit as attention and a zero exit as normal', () => {
    const rows = buildTimeline([
      ev({ type: 'shell.exec', actor: 'tool', attrs: { command: 'npm test', cwd: '/work' } }),
      ev({ type: 'shell.result', actor: 'tool', attrs: { exit_code: 1, duration_ms: 4210 } }),
      ev({ type: 'shell.result', actor: 'tool', attrs: { exit_code: 0 } }),
    ]);
    expect(rows[0]!.kind).toBe('SHELL');
    expect(rows[0]!.label).toBe('npm test');
    expect(rows[1]!.tone).toBe('attention');
    expect(rows[1]!.detail).toContain('exit 1');
    expect(rows[2]!.tone).toBe('normal');
  });

  it('marks errors and divergences as attention', () => {
    const rows = buildTimeline([
      ev({ type: 'error', actor: 'harness', attrs: { message: 'ENOENT', code: 'ENOENT' } }),
      ev({ type: 'divergence', actor: 'orca', attrs: { level: 'major', rung: 3 } }),
    ]);
    expect(rows.map((r) => r.tone)).toEqual(['attention', 'attention']);
    expect(rows[0]!.label).toBe('ENOENT');
    expect(rows[1]!.kind).toBe('DIVERGE');
    expect(rows[1]!.label).toContain('major');
    expect(rows[1]!.detail).toContain('rung 3');
  });

  it('marks a failed tool result as attention', () => {
    const rows = buildTimeline([
      ev({ type: 'tool.call', actor: 'agent', attrs: { name: 'Read', id: 'call_1' } }),
      ev({ type: 'tool.result', actor: 'tool', attrs: { name: 'Read', error: 'no such file' } }),
      ev({ type: 'tool.result', actor: 'tool', attrs: { name: 'Read', ok: true } }),
    ]);
    expect(rows[0]!.label).toBe('Read');
    expect(rows[0]!.meta).toBe('call_1');
    expect(rows[1]!.tone).toBe('attention');
    expect(rows[2]!.tone).toBe('normal');
  });

  it('quiets derived and bookkeeping events', () => {
    const rows = buildTimeline([
      ev({ type: 'checkpoint' }),
      ev({ type: 'note', attrs: { text: 'loop detected' } }),
      ev({ type: 'fs.snapshot', attrs: { tree: 'tree_aaaa', files: 42 } }),
    ]);
    expect(rows.map((r) => r.tone)).toEqual(['quiet', 'quiet', 'quiet']);
    expect(rows[1]!.label).toBe('loop detected');
    expect(rows[2]!.label).toContain('tree_aaaa');
  });

  /**
   * The renderer and the writer have to agree on attribute names, and for filesystem events they
   * did not. `orca record` emits `{ path, status, insertions, deletions }` for fs.change and
   * `{ tree, changes, initial }` for fs.snapshot; the renderer read `added`, `removed` and
   * `files` — names nothing produces. Every FILE row therefore rendered with an empty detail and
   * never said whether the file was added, modified or deleted, and every SNAP row dropped its
   * change count.
   *
   * It survived because the tests below invented their own attribute shape and the renderer
   * agreed with the invention. So these cases use the writer's real payload, copied from
   * packages/cli/src/commands/record.ts, and are the reason the bug is now visible.
   */
  it('shows a failed tool result as failed', () => {
    // The writer emits `is_error`; the renderer checked `error` and `ok`, so a failed tool call
    // rendered with the word "ok" and a normal tone. Blank would have been bad; asserting that a
    // failure succeeded is worse, because the timeline is where you go to find the failure.
    const rows = buildTimeline([
      ev({ type: 'tool.result', attrs: { name: 'Bash', is_error: true } }),
      ev({ type: 'tool.result', attrs: { name: 'Read', is_error: false } }),
    ]);
    expect(rows[0]!.detail).not.toBe('ok');
    expect(rows[0]!.tone).toBe('attention');
    expect(rows[1]!.detail).toBe('ok');
    expect(rows[1]!.tone).toBe('normal');
  });

  it('renders the filesystem attributes orca record actually writes', () => {
    const rows = buildTimeline([
      ev({
        type: 'fs.change',
        attrs: { path: 'auth.ts', status: 'modified', insertions: 1, deletions: 1 },
      }),
      ev({
        type: 'fs.change',
        attrs: { path: 'new.ts', status: 'added', insertions: 12, deletions: 0 },
      }),
      ev({ type: 'fs.snapshot', attrs: { tree: 'cafebabe', changes: 3 } }),
    ]);
    expect(rows[0]!.label).toBe('auth.ts');
    expect(rows[0]!.detail).toContain('+1');
    expect(rows[0]!.detail).toContain('1');
    expect(rows[0]!.detail).toContain('modified');
    expect(rows[1]!.detail).toContain('added');
    expect(rows[2]!.detail).toContain('3');
  });

  it('summarises fs.change, mcp, route, fork and run events', () => {
    const rows = buildTimeline([
      ev({ type: 'fs.change', attrs: { files: 3, added: 12, removed: 4 } }),
      ev({ type: 'mcp.request', actor: 'gateway', attrs: { method: 'tools/call', server: 'fsx' } }),
      ev({
        type: 'mcp.response',
        actor: 'gateway',
        attrs: { method: 'tools/call', error: 'boom' },
      }),
      ev({ type: 'route.decision', actor: 'gateway', attrs: { model: 'haiku', reason: 'cheap' } }),
      ev({ type: 'fork', attrs: { child_run: 'run_ffff', from_seq: 7 } }),
      ev({ type: 'run.start', attrs: { adapter: 'claude-code' } }),
      ev({ type: 'run.end', attrs: { exit_code: 2 } }),
    ]);
    expect(rows[0]!.kind).toBe('FILE');
    expect(rows[0]!.label).toContain('3 files');
    expect(rows[0]!.detail).toContain('+12');
    expect(rows[1]!.label).toBe('tools/call');
    expect(rows[1]!.detail).toBe('fsx');
    expect(rows[2]!.tone).toBe('attention');
    expect(rows[3]!.kind).toBe('ROUTE');
    expect(rows[3]!.label).toBe('haiku');
    expect(rows[4]!.label).toContain('run_ffff');
    expect(rows[5]!.label).toBe('run started');
    expect(rows[6]!.label).toBe('run ended');
    expect(rows[6]!.tone).toBe('attention');
  });

  it('never emits undefined strings, whatever the attrs', () => {
    const rows = buildTimeline([
      ev({ type: 'model.request' }),
      ev({ type: 'tool.call' }),
      ev({ type: 'shell.exec' }),
      ev({ type: 'error' }),
    ]);
    for (const row of rows) {
      expect(typeof row.label).toBe('string');
      expect(typeof row.detail).toBe('string');
      expect(typeof row.meta).toBe('string');
      expect(row.label.length).toBeGreaterThan(0);
    }
  });

  it('truncates a very long label so one row cannot swamp the list', () => {
    const rows = buildTimeline([ev({ type: 'shell.exec', attrs: { command: 'x'.repeat(500) } })]);
    expect(rows[0]!.label.length).toBeLessThanOrEqual(120);
    expect(rows[0]!.label.endsWith('…')).toBe(true);
  });

  it('collapses newlines in labels so rows stay one line', () => {
    const rows = buildTimeline([
      ev({ type: 'shell.exec', attrs: { command: 'set -e\nnpm test\n' } }),
    ]);
    expect(rows[0]!.label).not.toContain('\n');
    expect(rows[0]!.label).toContain('npm test');
  });
});

describe('formatters', () => {
  it('formats durations compactly', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(842)).toBe('842ms');
    expect(formatDuration(9_400)).toBe('9.4s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(291_000)).toBe('4m 51s');
    expect(formatDuration(8_040_000)).toBe('2h 14m');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
  });

  it('carries seconds into minutes rather than printing 60s', () => {
    expect(formatDuration(119_600)).toBe('2m 0s');
    expect(formatDuration(3_599_800)).toBe('1h 0m');
  });

  it('formats bytes compactly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1_258_291)).toBe('1.2 MB');
    expect(formatBytes(20_481)).toBe('20 KB');
    expect(formatBytes(8 * 1024 * 1024)).toBe('8 MB');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('formats token counts with thousands separators', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(412)).toBe('412');
    expect(formatTokens(8412)).toBe('8,412');
    expect(formatTokens(1_234_567)).toBe('1,234,567');
    expect(formatTokens(Number.NaN)).toBe('—');
  });
});

describe('summarize', () => {
  it('computes counts, duration, usage and exit code', () => {
    const events = [
      ev({ type: 'run.start', turn: 0 }),
      ev({
        type: 'model.response',
        turn: 0,
        attrs: { usage: { input_tokens: 1000, output_tokens: 100 } },
      }),
      ev({ type: 'error', turn: 1, attrs: { message: 'boom' } }),
      ev({ type: 'divergence', turn: 1, attrs: { level: 'minor' } }),
      ev({
        type: 'model.response',
        turn: 2,
        attrs: { usage: { input: 500, output: 50 } },
      }),
      ev({ type: 'run.end', turn: 2, attrs: { exit_code: 0 } }),
    ];
    const s = summarize(manifest({ integrity: { events_sha256: 'x', blob_count: 4 } }), events);
    expect(s.runId).toBe('run_abc123');
    expect(s.adapter).toBe('claude-code@1.4.0');
    expect(s.eventCount).toBe(6);
    expect(s.turnCount).toBe(3);
    expect(s.errorCount).toBe(1);
    expect(s.divergenceCount).toBe(1);
    expect(s.totalUsage).toEqual({ input: 1500, output: 150 });
    expect(s.blobCount).toBe(4);
    expect(s.exitCode).toBe(0);
    // mono_us is authoritative for duration (spec §2.1): last event is seq 5 => 5s.
    expect(s.durationMs).toBe(5000);
  });

  it('prefers the manifest exit code and falls back to run.end', () => {
    expect(summarize(manifest({ exit_code: 3 }), []).exitCode).toBe(3);
    expect(summarize(manifest(), [ev({ type: 'run.end', attrs: { exit_code: 7 } })]).exitCode).toBe(
      7,
    );
    expect(summarize(manifest(), []).exitCode).toBe(null);
  });

  it('falls back to wall-clock duration when there are no events', () => {
    expect(summarize(manifest(), []).durationMs).toBe(291_000);
  });

  it('counts distinct blob digests when the manifest is silent', () => {
    const events = [
      ev({ type: 'model.request', payload: { $blob: 'sha256:aa', bytes: 10 } }),
      ev({ type: 'model.response', payload: { $blob: 'sha256:aa', bytes: 10 } }),
      ev({ type: 'tool.result', payload: { $blob: 'sha256:bb', bytes: 20 } }),
    ];
    expect(summarize(manifest(), events).blobCount).toBe(2);
  });

  it('reads usage from flat attrs as well as a usage object', () => {
    const events = [
      ev({ type: 'model.response', attrs: { input_tokens: 7, output_tokens: 3 } }),
      ev({ type: 'model.response', attrs: { usage: { prompt_tokens: 5, completion_tokens: 2 } } }),
    ];
    expect(summarize(manifest(), events).totalUsage).toEqual({ input: 12, output: 5 });
  });
});

describe('detectLoops', () => {
  /**
   * The detector this replaced asked only whether the filesystem tree had changed, and called
   * three turns on one tree a loop. Every one of these cases came back positive under it: a
   * question answered in prose, a plan discussed before the first edit, a run that simply had no
   * files to write. A finding that fires on almost every session is not a finding, so what is
   * checked here is the agent repeating itself.
   */
  const call = (turn: number, name: string, input: unknown = {}) =>
    ev({ type: 'tool.call', turn, actor: 'model', attrs: { name }, payload: input as never });
  const model = (turn: number) => ev({ type: 'model.request', turn, actor: 'agent' });
  const failure = (turn: number) =>
    ev({ type: 'tool.result', turn, actor: 'tool', attrs: { is_error: true } });

  it('finds the same call repeated three times', () => {
    resetSeq();
    const found = detectLoops([
      call(1, 'grep', { q: 'JWT' }),
      call(2, 'grep', { q: 'JWT' }),
      call(3, 'grep', { q: 'JWT' }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe('repeated-action');
    expect(found[0]!.repeats).toBe(3);
    expect(found[0]!.turns).toEqual([1, 2, 3]);
  });

  // Two of anything is a retry, and retries are how agents work.
  it('does not flag a call made twice', () => {
    resetSeq();
    expect(detectLoops([call(1, 'grep'), call(2, 'grep')])).toEqual([]);
  });

  it('finds a two-call cycle going round three times', () => {
    resetSeq();
    const found = detectLoops([
      call(1, 'edit'),
      call(1, 'test'),
      call(2, 'edit'),
      call(2, 'test'),
      call(3, 'edit'),
      call(3, 'test'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.repeats).toBe(3);
  });

  // Same tool, different arguments, is work — reading three files is not a loop.
  it('separates calls by their arguments, not only by tool name', () => {
    resetSeq();
    expect(
      detectLoops([
        call(1, 'read', { path: 'a' }),
        call(2, 'read', { path: 'b' }),
        call(3, 'read', { path: 'c' }),
      ]),
    ).toEqual([]);
  });

  it('finds turns that call the model and do nothing, once something has failed', () => {
    resetSeq();
    const found = detectLoops([call(1, 'test'), failure(1), model(2), model(3)]);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe('error-spin');
    expect(found[0]!.turns).toEqual([2, 3]);
  });

  /**
   * The false positive that made the old detector useless, in the shape it actually took: orca
   * snapshots the workspace before every model request, so a conversation that writes no files
   * produces a run of turns all carrying the same tree. That is what the tree-based detector
   * called a loop, and it is what answering a question looks like.
   */
  it('does not flag tool-less turns when nothing has failed', () => {
    resetSeq();
    const events = [
      snap(0, 'tree_a'),
      model(0),
      snap(1, 'tree_a'),
      model(1),
      snap(2, 'tree_a'),
      model(2),
      snap(3, 'tree_a'),
      model(3),
    ];
    expect(detectLoops(events)).toEqual([]);
  });

  it('does not flag a turn that did real work, even after a failure', () => {
    resetSeq();
    const found = detectLoops([failure(1), call(2, 'edit'), model(3), model(4)]);
    expect(found.map((l) => l.turns)).toEqual([[3, 4]]);
  });

  it('reports several independent loops in order', () => {
    resetSeq();
    const found = detectLoops([
      call(1, 'a'),
      call(2, 'a'),
      call(3, 'a'),
      call(4, 'b'),
      call(5, 'c'),
      call(6, 'c'),
      call(7, 'c'),
    ]);
    expect(found.map((l) => l.turns)).toEqual([
      [1, 2, 3],
      [5, 6, 7],
    ]);
  });
});

describe('buildTimeline depth', () => {
  /**
   * A harness that delegates runs the delegate's model and tool calls through the same proxy, so
   * they land in the same flat sequence as the parent's. Before this, a run that spawned an
   * Explore agent read as one stream with no line saying whose work it was — six Bash calls the
   * parent never made, indistinguishable from six the parent did.
   */
  const agentCall = (seq: number) =>
    ev({
      seq,
      type: 'tool.call',
      actor: 'model',
      attrs: { name: 'Agent', input: { subagent_type: 'Explore' } },
    });
  const agentResult = (seq: number, causes: number[]) =>
    ev({ seq, type: 'tool.result', actor: 'tool', causes, attrs: { name: 'Agent' } });
  const plain = (seq: number) => ev({ seq, type: 'model.request', actor: 'agent' });

  it('nests the work between a delegation and the result that closes it', () => {
    const rows = buildTimeline([
      plain(0),
      agentCall(1),
      plain(2),
      plain(3),
      agentResult(4, [1]),
      plain(5),
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 1, 1, 0]);
  });

  it('nests a delegation inside a delegation', () => {
    const rows = buildTimeline([
      agentCall(0),
      agentCall(1),
      plain(2),
      agentResult(3, [1]),
      plain(4),
      agentResult(5, [0]),
      plain(6),
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 1, 1, 0]);
  });

  // An ordinary tool call is not a delegation, however many of them there are.
  it('leaves a run with no delegation flat', () => {
    const rows = buildTimeline([
      plain(0),
      ev({
        seq: 1,
        type: 'tool.call',
        actor: 'model',
        attrs: { name: 'Bash', input: { command: 'ls' } },
      }),
      ev({ seq: 2, type: 'tool.result', actor: 'tool', causes: [1], attrs: { name: 'Bash' } }),
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 0]);
  });

  // A delegation whose result never arrived — the run was killed — must not swallow the rest.
  it('does not nest forever when the closing result is missing', () => {
    const rows = buildTimeline([agentCall(0), plain(1), plain(2)]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 0]);
  });
});
