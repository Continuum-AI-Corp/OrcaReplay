import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader } from '@orcareplay/core';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand, distinctOrigins } from '../src/commands/record.js';
import { showCommand, upstreamsIn } from '../src/commands/inspect.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, 'fixtures', 'fake-agent.mjs');

/**
 * Where did the traffic go.
 *
 * The trace recorded what was sent and what came back, and never who answered — and `orca record`
 * printed `proxy=http://127.0.0.1:PORT`, which is orca's own address, not the model's. So the
 * question asked first of a recording that looks wrong could not be answered from the recording:
 * a gateway left behind in `~/.orca/config.json` redirects every run on the machine, and nothing
 * anywhere said so.
 *
 * Three surfaces, because the answer is wanted at three moments: on the line printed as the run
 * starts, in the trace, and in `orca show` when someone comes back to it later.
 */
describe('a run says where its traffic went', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-upstream-'));
    model = await startFakeModel();
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
    process.env.FAKE_AGENT_TURNS = '2';
    delete process.env.FAKE_AGENT_CWD;
  });

  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  async function record() {
    const args = parseArgs([
      'record',
      'generic-openai',
      '--upstream-anthropic',
      model.url,
      '--',
      'node',
      FAKE_AGENT,
    ]);
    return recordCommand(args, out, workspace);
  }

  it('prints the upstream as the run starts, beside the proxy that is not it', async () => {
    await record();
    const recording = lines.find((l) => l.includes('recording'));

    expect(recording, 'no recording line was printed at all').toBeDefined();
    // Both, and the point is the pair: `proxy` is where the agent calls, `upstream` is where that
    // call goes on to, and printing only the first is what made a redirected run look ordinary.
    expect(recording).toMatch(/proxy=http:\/\/127\.0\.0\.1:\d+/);
    expect(recording).toContain(`upstream=${model.url}`);
  });

  it('records on each exchange which origin answered it', async () => {
    const result = await record();
    const reader = await TraceReader.open(result.runDir);
    const responses = (await reader.events()).filter((e) => e.type === 'model.response');

    expect(responses.length).toBeGreaterThan(0);
    for (const response of responses) {
      expect(response.attrs?.['upstream'], `seq ${response.seq} does not say who answered`).toBe(
        model.url,
      );
    }
  });

  it('answers it in orca show, where someone comes back to the run later', async () => {
    const result = await record();
    lines.length = 0;
    await showCommand(parseArgs(['show', result.runId]), out, workspace);

    expect(lines.join('')).toContain(`upstream ${model.url}`);
  });
});

/**
 * `resolveUpstream` writes one entry per dialect, and `openai` and `openai-responses` always carry
 * the same value — so the raw map renders one gateway twice on a line meant to be read at a glance.
 */
describe('distinctOrigins', () => {
  it('collapses the dialects that share an origin', () => {
    expect(
      distinctOrigins({
        openai: 'https://gw.example',
        'openai-responses': 'https://gw.example',
        anthropic: 'https://gw.example',
      }),
    ).toEqual(['https://gw.example']);
  });

  it('keeps a run that really does reach two places as two', () => {
    // Naming one dialect's origin leaves the other on whatever was configured before it, which is
    // exactly the case the line exists to make visible.
    expect(
      distinctOrigins({
        openai: 'http://127.0.0.1:4000',
        'openai-responses': 'http://127.0.0.1:4000',
        anthropic: 'https://gw.example',
      }),
    ).toEqual(['http://127.0.0.1:4000', 'https://gw.example']);
  });

  it('says nothing when nothing was configured', () => {
    // Not `['default']` or an empty string: each dialect has its own vendor default, so there is
    // no single value to print, and `upstream=` on every ordinary run would train people to skip
    // the line. The trace still records the resolved origin per exchange.
    expect(distinctOrigins(undefined)).toEqual([]);
  });
});

describe('upstreamsIn', () => {
  it('reads the origins off the responses, first seen first', () => {
    expect(
      upstreamsIn([
        { type: 'model.response', attrs: { upstream: 'https://a.example' } },
        { type: 'model.request', attrs: {} },
        { type: 'model.response', attrs: { upstream: 'https://b.example' } },
        { type: 'model.response', attrs: { upstream: 'https://a.example' } },
      ]),
    ).toEqual(['https://a.example', 'https://b.example']);
  });

  it('is empty for a trace recorded before orca wrote this down', () => {
    // Which is why `orca show` prints no line at all rather than "upstream unknown": absence here
    // is an old trace, and a run that reached nothing has no model.response to read anyway.
    expect(upstreamsIn([{ type: 'model.response', attrs: { model: 'x' } }])).toEqual([]);
  });
});
