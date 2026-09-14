import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A frame the reader keeps has to be one the drain can actually write.
 *
 * `readShellFrames` keeps a torn frame deliberately: a command that really ran must not vanish
 * from the trace because the line recording it lost its tail to a concurrent append. That is only
 * the right call if the consumer can take it — the claim is that it degrades a field rather than
 * failing, dropping `occurredAt` and stamping the events from the drain's own clock.
 *
 * Asserted rather than reasoned about, because the reader and the consumer live in different
 * packages and the last two rounds of this were exactly the two of them disagreeing about which
 * fields are load-bearing. The frame is planted through `installShellShim` so it is the real
 * `record` path that reads it, and it is the shape a real tear produces: everything from
 * `startedAt` onwards gone.
 */
const planted = vi.hoisted(() => ({ line: '' }));
vi.mock('@orcareplay/shell-shim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcareplay/shell-shim')>();
  return {
    ...actual,
    installShellShim: async (options: Parameters<typeof actual.installShellShim>[0]) => {
      const shim = await actual.installShellShim(options);
      // After the install, so this is what the drain finds; the shim only ever appends.
      if (planted.line !== '') await writeFile(shim.framesPath, `${planted.line}\n`, 'utf8');
      return shim;
    },
  };
});
import { parseArgs } from '../src/args.js';
import { recordCommand } from '../src/commands/record.js';
import { Output } from '../src/out.js';

interface Row {
  type: string;
  ts: string;
  attrs?: Record<string, unknown>;
}

describe('a torn shell frame, through the drain that writes it', () => {
  const exec = promisify(execFile);
  let workspace: string;

  beforeEach(async () => {
    planted.line = '';
    workspace = await mkdtemp(join(tmpdir(), 'orca-frames-'));
    await exec('git', ['init', '-q'], { cwd: workspace });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: workspace });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  /** One recorded run, and the events it wrote. */
  async function record(): Promise<Row[]> {
    const agent = join(workspace, 'agent.mjs');
    await writeFile(agent, "console.log('GOT: done');\n");
    const result = await recordCommand(
      parseArgs(['record', 'generic-openai', '--', process.execPath, agent]),
      new Output({ write: () => {}, isTTY: false }),
      workspace,
    );
    const events = join(workspace, '.orca', 'runs', result.runId, 'events.jsonl');
    return (await readFile(events, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Row);
  }

  it('reaches the trace as both its events, stamped from the drain', async () => {
    planted.line = '{"name":"sh","argv":["-c","npm test"],"cwd":"/tmp","exitCode":1,"signal":null}';

    const rows = await record();
    const ran = rows.find((row) => row.type === 'shell.exec');
    const result = rows.find((row) => row.type === 'shell.result');

    expect(ran, 'a command the agent ran is missing from the trace').toBeDefined();
    expect(result, 'the command is there and its result is not').toBeDefined();
    expect(ran!.attrs!['argv']).toEqual(['sh', '-c', 'npm test']);
    expect(result!.attrs!['exit_code'], 'the exit code only the shim can see was lost').toBe(1);
    // Degraded, not failed: no instant came off the frame, so both events carry the drain's.
    expect(Number.isNaN(Date.parse(result!.ts)), 'the event has no usable timestamp').toBe(false);
  }, 60_000);
});
