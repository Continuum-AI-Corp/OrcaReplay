import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader, deriveCheckpoints, resolveRunSelector } from '@orcareplay/core';
import { validateEvent } from '@orcareplay/schema';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { replayCommand } from '../src/commands/replay.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const MCP_AGENT = join(here, 'fixtures', 'mcp-agent.mjs');

/** A minimal stdio MCP server: one JSON-RPC reply per line it is given. */
const ECHO_SERVER = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');
  }
});
`;

/**
 * MCP capture, end to end.
 *
 * The shim has always written a `ts` on every frame; the recorder's own record type omitted the
 * field, so it was parsed off disk and thrown away on the same line — and every MCP event landed in
 * the trace stamped with the moment the file was drained, carrying the final turn number. That was
 * fixed alongside the identical bug in shell capture, but only the shell half was ever tested, so
 * this half could have regressed in silence.
 */
describe('mcp capture', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-mcp-e2e-'));
    model = await startFakeModel();
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });

    await writeFile(join(workspace, 'echo-server.mjs'), ECHO_SERVER);
    await writeFile(
      join(workspace, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          echo: { command: process.execPath, args: [join(workspace, 'echo-server.mjs')] },
        },
      }),
    );
  });

  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  async function record(configPath = join(workspace, 'mcp.json')) {
    return recordCommand(
      parseArgs([
        'record',
        'generic-openai',
        '--upstream-anthropic',
        model.url,
        '--mcp-config',
        configPath,
        '--no-shell',
        '--',
        'node',
        MCP_AGENT,
      ]),
      out,
      workspace,
    );
  }

  it('records the JSON-RPC the agent exchanged with the server', async () => {
    const result = await record();
    const events = await (await TraceReader.open(result.runDir)).events();
    const mcp = events.filter((e) => e.type === 'mcp.request' || e.type === 'mcp.response');

    expect(mcp.length, `no mcp events in:\n${lines.join('\n')}`).toBeGreaterThanOrEqual(2);
    for (const event of mcp) expect(validateEvent(event).valid).toBe(true);
    expect(mcp.some((e) => e.type === 'mcp.request')).toBe(true);
    expect(mcp.some((e) => e.type === 'mcp.response')).toBe(true);
    expect(JSON.stringify(mcp)).toContain('tools/list');
    // The server's own name from the agent's config. It arrived undefined for every frame while
    // the recorder read a field called `server` off a record the shim writes as `name`.
    for (const event of mcp) expect(event.attrs?.server, JSON.stringify(event.attrs)).toBe('echo');
  });

  it('timestamps a call when it happened, not when the frames file was drained', async () => {
    const result = await record();
    const events = await (await TraceReader.open(result.runDir)).events();
    const request = events.find((e) => e.type === 'mcp.request');
    const runEnd = events.find((e) => e.type === 'run.end');
    expect(request, 'no mcp.request was recorded').toBeDefined();

    // The agent sits for 400ms after the call, so a drain-time stamp lands within a few
    // milliseconds of `run.end` while a real one is clear of it by that margin.
    expect(Date.parse(runEnd!.ts) - Date.parse(request!.ts)).toBeGreaterThan(300);
    expect(runEnd!.mono_us - request!.mono_us).toBeGreaterThan(300_000);
  });

  describe('replay and fork', () => {
    // Replay and fork launch the same agent the recording did, so they share its blind spot: with
    // no config the harness talks to servers orca cannot see, or — for one that requires the
    // variable — does not start at all. Found by building a demo: replaying a working recording
    // exited 2 with `matched=0` for a reason that had nothing to do with the recording.
    it('re-instruments MCP from what the recording used, with no flag', async () => {
      const recorded = await record();
      const result = await replayCommand(parseArgs(['replay', 'last']), out, workspace);

      expect(result.exitCode, `the agent must still run:\n${lines.join('\n')}`).toBe(0);
      expect(result.matchedExact).toBeGreaterThan(0);

      const traceDir = (await resolveRunSelector(workspace, result.traceRunId!)).dir;
      const events = await (await TraceReader.open(traceDir)).events();
      const mcp = events.filter((e) => e.type.startsWith('mcp.'));
      expect(mcp.length, 'the replay discovered these calls; they exist nowhere else').toBe(2);
      expect(mcp[0]!.attrs?.server).toBe('echo');
      expect(recorded.runDir).not.toBe(traceDir);
    });

    it('records which config the recording used, since argv cannot carry it', async () => {
      // `manifest.argv` holds the agent's own arguments and `--mcp-config` is orca's, so without
      // this note a replay has no way to find the source config at all.
      const recorded = await record();
      const events = await (await TraceReader.open(recorded.runDir)).events();
      const note = events.find((e) => e.type === 'note' && e.attrs?.rule === 'mcp_instrumented');
      expect(note, 'no mcp_instrumented note').toBeDefined();
      expect(note!.attrs?.source).toBe(join(workspace, 'mcp.json'));
    });

    it('captures MCP past the fork point too', async () => {
      await record();
      const checkpoints = deriveCheckpoints(
        await (await TraceReader.open((await resolveRunSelector(workspace, 'last')).dir)).events(),
      );
      const result = await replayCommand(
        parseArgs([
          'replay',
          'last',
          '--from',
          String(checkpoints[0]!.seq),
          '--model',
          'claude-haiku-4-5',
          '--upstream-anthropic',
          model.url,
        ]),
        out,
        workspace,
      );

      const forkDir = (await resolveRunSelector(workspace, result.forkRunId!)).dir;
      const events = await (await TraceReader.open(forkDir)).events();
      const mcp = events.filter((e) => e.type.startsWith('mcp.'));
      expect(mcp.length, `no mcp events in the fork:\n${lines.join('\n')}`).toBe(2);
      for (const event of mcp) expect(validateEvent(event).valid).toBe(true);
    });

    it('says so rather than silently dropping the layer when the config has moved', async () => {
      // The config lives *outside* the workspace here, because exact replay restores the recorded
      // tree over the working directory — deleting a file that was in the snapshot just brings it
      // back, which is the restore working correctly and would make this test pass for the wrong
      // reason.
      const elsewhere = await mkdtemp(join(tmpdir(), 'orca-mcp-cfg-'));
      const configPath = join(elsewhere, 'mcp.json');
      await writeFile(configPath, await readFile(join(workspace, 'mcp.json'), 'utf8'));
      await record(configPath);
      await rm(elsewhere, { recursive: true, force: true });
      // Only what the replay said: the recording legitimately printed `mcp.instrumented`, and
      // asserting over both would check the wrong half of the session.
      lines.length = 0;

      await replayCommand(parseArgs(['replay', 'last']), out, workspace);

      const printed = lines.join('');
      expect(printed).toContain('mcp.source_missing');
      expect(printed, 'a dropped capture layer must not read as a quiet success').not.toContain(
        'mcp.instrumented',
      );
    });
  });

  it('attributes a call to the turn it happened during', async () => {
    // The agent calls the server between two model turns, so there is a right answer and a wrong
    // one: turn 1, not the final turn every frame used to claim.
    const result = await record();
    const events = await (await TraceReader.open(result.runDir)).events();
    const request = events.find((e) => e.type === 'mcp.request');
    const turns = events.filter((e) => e.type === 'model.request').map((e) => e.turn);

    expect(turns.length, 'the fixture must drive more than one turn').toBeGreaterThan(1);
    expect(request!.turn).toBe(1);
    expect(request!.turn, 'not the last turn, which is what the drain used to assign').not.toBe(
      Math.max(...turns),
    );
  });
});
