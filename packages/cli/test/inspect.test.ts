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
      expect(text()).toMatch(/RUN\s+CREATED\s+DIR/);
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
