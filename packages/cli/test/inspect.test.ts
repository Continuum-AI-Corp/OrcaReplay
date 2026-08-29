import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceWriter } from '@orcareplay/core';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { stripAnsi } from '../src/out.js';
import {
  checkpointsCommand,
  exportCommand,
  listCommand,
  showCommand,
} from '../src/commands/inspect.js';

describe('orca show — the DETAIL column', () => {
  /**
   * `show` rendered each row's `meta` and dropped its `detail`, so the column showed token counts
   * for a model response and nothing at all for everything else. The casualties were the facts the
   * capture layers exist to record: a shell command's exit code — named in the shell shim's own
   * docstring as the thing the model never sees — appeared as an empty cell next to its duration,
   * and a tool call and its result rendered as two identical rows.
   */
  async function showEvents(events: { type: string; attrs: Record<string, unknown> }[]) {
    const dir = await mkdtemp(join(tmpdir(), 'orca-show-detail-'));
    const writer = await TraceWriter.create(join(dir, '.orca', 'runs'), {
      adapter: { id: 'claude-code', version: '0.0.0' },
      argv: ['claude-code'],
      cwd: dir,
      orcaVersion: '0.0.0',
    });
    for (const e of events) {
      await writer.append({ type: e.type as never, actor: 'agent', turn: 1, attrs: e.attrs });
    }
    await writer.close(0);
    const lines: string[] = [];
    const out = new Output({ write: (l) => void lines.push(l), isTTY: false });
    await showCommand(parseArgs(['show', writer.runId]), out, dir);
    await rm(dir, { recursive: true, force: true });
    return stripAnsi(lines.join('\n'));
  }

  it('shows the exit code of a shell command, not only its duration', async () => {
    const text = await showEvents([
      { type: 'shell.exec', attrs: { command: 'npm test', cwd: '/w' } },
      { type: 'shell.result', attrs: { command: 'npm test', exit_code: 1, duration_ms: 4200 } },
    ]);
    expect(text).toContain('exit 1');
    expect(text).toContain('4.2s');
  });

  it('tells a tool call apart from its result', async () => {
    const text = await showEvents([
      { type: 'tool.call', attrs: { name: 'Bash', summary: 'run the tests' } },
      { type: 'tool.result', attrs: { name: 'Bash', error: 'exit 1' } },
    ]);
    expect(text).toContain('run the tests');
    expect(text).toContain('exit 1');
  });

  it('keeps the token counts it already showed', async () => {
    const text = await showEvents([
      {
        type: 'model.response',
        attrs: {
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          input_tokens: 1200,
          output_tokens: 40,
        },
      },
    ]);
    expect(text).toContain('end_turn');
    expect(text).toContain('1,200 in');
    expect(text).toContain('40 out');
  });
});

describe('orca list — fork provenance', () => {
  /**
   * `orca compare --models a,b,c` leaves four runs in the directory: the parent and one fork per
   * model. Listing them as four unrelated ids makes the output of the tool's headline command
   * unreadable the moment you come back to it.
   */
  it('shows which run each fork came from', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-list-fork-'));
    try {
      const parent = await TraceWriter.create(join(dir, '.orca', 'runs'), {
        adapter: { id: 'claude-code', version: '0.0.0' },
        argv: ['claude-code'],
        cwd: dir,
        orcaVersion: '0.0.0',
      });
      await parent.close(0);
      const child = await TraceWriter.create(join(dir, '.orca', 'runs'), {
        adapter: { id: 'claude-code', version: '0.0.0' },
        argv: ['claude-code'],
        cwd: dir,
        orcaVersion: '0.0.0',
        parentRun: parent.runId,
        forkPoint: 4,
      });
      await child.close(0);

      const lines: string[] = [];
      const out = new Output({ write: (l) => void lines.push(l), isTTY: false });
      await listCommand(parseArgs(['list']), out, dir);

      const text = stripAnsi(lines.join('\n'));
      expect(text).toContain('FROM');
      // The child's row names the parent; the parent's row has nothing in that column.
      const childRow = text.split('\n').find((l) => l.includes(child.runId)) ?? '';
      const parentRow = text.split('\n').find((l) => l.startsWith(parent.runId)) ?? '';
      expect(childRow).toContain(`${parent.runId}@4`);
      expect(parentRow).not.toContain('@');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('orca show — fork provenance', () => {
  /**
   * A forked run read on its own is unintelligible without its parent: the timeline opens
   * mid-conversation, the filesystem is a worktree that no longer exists, and nothing on screen
   * says which run or which checkpoint it came from. `orca list` does not show it either, so the
   * only way to find out was to cat the manifest — for the feature the whole tool is named after.
   */
  it('names the parent run and fork point at the top of a forked run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-show-fork-'));
    try {
      const parent = await TraceWriter.create(join(dir, '.orca', 'runs'), {
        adapter: { id: 'claude-code', version: '0.0.0' },
        argv: ['claude-code'],
        cwd: dir,
        orcaVersion: '0.0.0',
      });
      await parent.close(0);

      const child = await TraceWriter.create(join(dir, '.orca', 'runs'), {
        adapter: { id: 'claude-code', version: '0.0.0' },
        argv: ['claude-code'],
        cwd: dir,
        orcaVersion: '0.0.0',
        parentRun: parent.runId,
        forkPoint: 4,
        forkModel: 'claude-haiku-4-5-20251001',
      });
      await child.close(0);

      const lines: string[] = [];
      const out = new Output({ write: (l) => void lines.push(l), isTTY: false });
      await showCommand(parseArgs(['show', child.runId]), out, dir);

      const text = lines.join('\n');
      expect(text).toContain(parent.runId);
      expect(text).toContain('4');
      expect(text).toContain('claude-haiku-4-5-20251001');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('says nothing about provenance for a run that was recorded, not forked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-show-plain-'));
    try {
      const writer = await TraceWriter.create(join(dir, '.orca', 'runs'), {
        adapter: { id: 'claude-code', version: '0.0.0' },
        argv: ['claude-code'],
        cwd: dir,
        orcaVersion: '0.0.0',
      });
      await writer.close(0);

      const lines: string[] = [];
      const out = new Output({ write: (l) => void lines.push(l), isTTY: false });
      await showCommand(parseArgs(['show', writer.runId]), out, dir);

      expect(lines.join('\n')).not.toContain('forked from');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('inspect commands', () => {
  let cwd: string;
  let lines: string[];
  let out: Output;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-inspect-'));
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const text = () => stripAnsi(lines.join(''));

  async function makeRun(): Promise<string> {
    const writer = await TraceWriter.create(join(cwd, '.orca', 'runs'), {
      adapter: { id: 'claude-code' },
      argv: ['claude'],
      cwd,
      orcaVersion: '0.1.0',
    });
    await writer.append({ type: 'run.start', actor: 'orca', turn: 0 });
    await writer.append({
      type: 'fs.snapshot',
      actor: 'orca',
      turn: 1,
      attrs: { tree: 'a'.repeat(40) },
    });
    await writer.append({
      type: 'model.request',
      actor: 'agent',
      turn: 1,
      attrs: { model: 'claude-opus-5', messages: 2 },
    });
    await writer.append({
      type: 'model.response',
      actor: 'model',
      turn: 1,
      attrs: {
        model: 'claude-opus-5',
        input_tokens: 1000,
        output_tokens: 500,
        stop_reason: 'end_turn',
      },
    });
    await writer.append({
      type: 'error',
      actor: 'orca',
      turn: 1,
      attrs: { kind: 'test_failure', failed: 1 },
    });
    await writer.append({ type: 'run.end', actor: 'orca', turn: 1, attrs: { exit_code: 1 } });
    await writer.close(1);
    return writer.runDir;
  }

  describe('list', () => {
    it('says how to record one when there are no runs, instead of printing nothing', async () => {
      await listCommand(parseArgs(['list']), out, cwd);
      expect(text()).toContain('no runs recorded yet');
      expect(text()).toContain('orca record');
    });

    it('lists a recorded run with its id and directory', async () => {
      const runDir = await makeRun();
      await listCommand(parseArgs(['list']), out, cwd);
      expect(text()).toContain(runDir);
      expect(text()).toMatch(/RUN\s+CREATED\s+FROM\s+DIR/);
    });
  });

  describe('show', () => {
    it('renders one row per event with its sequence number', async () => {
      await makeRun();
      await showCommand(parseArgs(['show', 'last']), out, cwd);
      const rendered = text();
      expect(rendered).toMatch(/SEQ\s+KIND/);
      expect(rendered).toContain('MODEL');
      expect(rendered).toContain('ERROR');
    });

    it('reports token usage and a cost for a known model', async () => {
      await makeRun();
      await showCommand(parseArgs(['show', 'last']), out, cwd);
      expect(text()).toContain('input=1000');
      expect(text()).toMatch(/cost=\$\d/);
    });

    it('shows the run id and exit code in the header', async () => {
      await makeRun();
      await showCommand(parseArgs(['show', 'last']), out, cwd);
      expect(text()).toMatch(/run_[0-9a-f]+/);
      expect(text()).toContain('exit 1');
    });
  });

  describe('checkpoints', () => {
    it('lists forkable points and the command to use one', async () => {
      await makeRun();
      await checkpointsCommand(parseArgs(['checkpoints', 'last']), out, cwd);
      const rendered = text();
      expect(rendered).toMatch(/SEQ\s+TURN\s+TREE/);
      expect(rendered).toContain('orca replay last --from');
    });

    it('explains the likely cause when a run has none', async () => {
      const writer = await TraceWriter.create(join(cwd, '.orca', 'runs'), {
        adapter: { id: 'claude-code' },
        argv: ['claude'],
        cwd,
        orcaVersion: '0.1.0',
      });
      await writer.append({ type: 'run.start', actor: 'orca', turn: 0 });
      await writer.close(0);

      await checkpointsCommand(parseArgs(['checkpoints', 'last']), out, cwd);
      expect(text()).toContain('no checkpoints');
      expect(text()).toContain('--no-fs');
    });
  });

  describe('export', () => {
    it('states what is about to leave the machine before writing it', async () => {
      await makeRun();
      await exportCommand(parseArgs(['export', 'last', '-o', 'out.html']), out, cwd);
      const rendered = text();
      expect(rendered).toContain('about to write');
      expect(rendered).toContain('redaction is best-effort');
    });

    it('writes a single self-contained file with no external references', async () => {
      await makeRun();
      await exportCommand(parseArgs(['export', 'last', '-o', 'out.html']), out, cwd);

      const html = await readFile(join(cwd, 'out.html'), 'utf8');
      expect(html.toLowerCase()).toContain('<!doctype html>');
      // The single-file constraint is the whole growth mechanic; assert it, do not assume it.
      const external = [...html.matchAll(/(?:src|href)="([^"]*)"/g)]
        .map((m) => m[1] ?? '')
        .filter((url) => /^https?:\/\//.test(url));
      expect(external).toEqual([]);
      expect(html).toContain('Recorded with OrcaReplay');
    });

    it('reports the path and size it wrote', async () => {
      await makeRun();
      await exportCommand(parseArgs(['export', 'last', '-o', 'out.html']), out, cwd);
      expect(text()).toMatch(/exported path=\S+out\.html bytes=\d+/);
    });
  });

  describe('run selection', () => {
    it('fails with an actionable message when no run exists', async () => {
      await expect(showCommand(parseArgs(['show', 'last']), out, cwd)).rejects.toThrow(
        /record one first|no runs/i,
      );
    });

    it('rejects a run id that is not shaped like one, rather than walking the filesystem', async () => {
      await expect(
        showCommand(parseArgs(['show', '../../etc/passwd']), out, cwd),
      ).rejects.toThrow();
    });
  });
});
