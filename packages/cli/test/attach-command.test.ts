import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader } from '@orcareplay/core';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { attachCommand } from '../src/commands/attach.js';
import { replayCommand } from '../src/commands/replay.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);

/**
 * `orca attach` — a recording session for an agent orca did not start.
 *
 * The command holds a proxy open, prints what to export, and records whatever arrives until it is
 * told to stop. That makes it the answer for an agent in a sandbox, on a VPS, or in someone's CI:
 * places where there is no process for orca to spawn and therefore no environment for it to build.
 *
 * These tests stand in for the sandbox with an ordinary `fetch` from this process. The distance
 * does not change anything that could break — what matters is that the run is driven entirely from
 * the outside, and that the trace it leaves behind replays like any other.
 */
describe('orca attach', () => {
  let workspace: string;
  let out: Output;
  let lines: string[];
  let model: Awaited<ReturnType<typeof startFakeModel>>;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-attach-'));
    model = await startFakeModel();
    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
  });
  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  /** Runs an attach session, handing the caller the live proxy url to drive it with. */
  function session(
    argv: string[],
    drive: (proxyUrl: string) => Promise<void>,
  ): ReturnType<typeof attachCommand> {
    let release: () => void = () => {};
    const until = new Promise<void>((resolve) => (release = resolve));
    return attachCommand(
      parseArgs(['attach', '--upstream-anthropic', model.url, ...argv]),
      out,
      workspace,
      {
        until,
        onReady: (info) => {
          void drive(info.proxyUrl).finally(release);
        },
      },
    );
  }

  it('prints the block to paste, pointed at the address it is reachable on', async () => {
    await session(['--for', 'claude'], async () => {});
    const printed = lines.join('');
    expect(printed).toContain('export ANTHROPIC_BASE_URL=');
    expect(printed).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
  });

  it('refuses a wildcard bind with no advertised host, rather than printing an unusable url', async () => {
    await expect(session(['--bind', '0.0.0.0'], async () => {})).rejects.toThrow(/--advertise/);
  });

  /**
   * The refusal has to happen before anything is created, not merely before anything is printed.
   * Validating only in the default-port path meant `--port` skipped the check entirely: the run
   * directory, the trace and (with --tls-intercept) a private key were all created for a session
   * that was about to throw.
   */
  it('refuses a wildcard bind before it creates a run, whatever the port', async () => {
    await expect(session(['--bind', '0.0.0.0', '--port', '18771'], async () => {})).rejects.toThrow(
      /--advertise/,
    );
    const runs = await readdir(join(workspace, '.orca', 'runs')).catch(() => []);
    expect(runs).toEqual([]);
  });

  /**
   * A session nobody can connect to is the failure this command exists to prevent, and the empty
   * block is the one form of it orca can see coming: `exec` sets no variables, so with no
   * interception either there is literally nothing for the operator to paste.
   */
  it('says so when there is nothing to paste, instead of printing an empty block', async () => {
    await session([], async () => {});
    expect(lines.join('')).toContain('attach.nothing_to_set');
  });

  /**
   * Some adapters instrument by writing a file into the run directory and naming it in the
   * environment — the fetch hook is the live example. Those paths exist on this machine and not in
   * the sandbox, so printing them yields a block that runs cleanly and instruments nothing.
   */
  it('flags an instruction that names a file only this machine has', async () => {
    await session(['--for', 'node'], async () => {});
    expect(lines.join('')).toContain('attach.local_path');
  });

  it('advertises the host the operator names, not the one it bound', async () => {
    await session(
      ['--for', 'claude', '--bind', '0.0.0.0', '--advertise', 'host.docker.internal'],
      async () => {},
    );
    expect(lines.join('')).toContain('http://host.docker.internal:');
  });

  it('records what an agent it never launched sends, and writes a trace', async () => {
    const result = await session(['--for', 'claude'], async (proxyUrl) => {
      await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          messages: [{ role: 'user', content: 'hello from the sandbox' }],
        }),
      });
    });

    expect(result.modelExchanges).toBe(1);
    const events = await (await TraceReader.open(result.runDir)).events();
    expect(events.filter((e) => e.type === 'model.request')).toHaveLength(1);
  });

  /**
   * Replaying a run whose agent is somewhere else.
   *
   * `orca replay` launches the agent, which is the right thing for a run orca recorded by
   * launching it — and impossible for one that came from a sandbox, where the agent may not exist
   * on this machine at all. So replay attaches too: the proxy serves the recording, the operator
   * points the same remote agent at it, and no model is called.
   *
   * Asserting on `reused` rather than on `unmatched` is deliberate. A replay nothing ever connects
   * to reports zero unmatched requests, because zero requests arrived — an assertion that passes
   * for a session that did nothing at all.
   */
  it('serves a recording back to an agent it does not launch', async () => {
    const recorded = await session(['--for', 'claude'], async (proxyUrl) => {
      await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          messages: [{ role: 'user', content: 'hello from the sandbox' }],
        }),
      });
    });

    let body = '';
    const replayed = await session(['--replay', recorded.runId], async (proxyUrl) => {
      const res = await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          messages: [{ role: 'user', content: 'hello from the sandbox' }],
        }),
      });
      body = await res.text();
    });

    expect(replayed.reused).toBe(1);
    expect(replayed.unmatched).toBe(0);
    // A replay session reports what it served, not a recording it did not make.
    expect(lines.join('')).toContain('info served');
    expect(lines.join('')).toContain('reused=1/1');
    // Served from the trace, so the model this test stood up was never called a second time.
    expect(model.calls).toHaveLength(1);
    expect(body).toContain('editing auth.ts');
  });

  /**
   * A replay session has to hand the operator something to paste, and `exec` — the honest default
   * when orca does not know what will connect — sets nothing at all. For a replay it does know:
   * the trace records which adapter made the recording, so the variables that agent reads are the
   * variables it will read again.
   */
  it('takes the agent from the recording, so the block is not empty', async () => {
    const recorded = await session(['--for', 'claude'], async (proxyUrl) => {
      await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          messages: [{ role: 'user', content: 'x' }],
        }),
      });
    });
    lines.length = 0;

    await session(['--replay', recorded.runId], async () => {});

    expect(lines.join('')).toContain('export ANTHROPIC_BASE_URL=');
  });

  it('still lets --for override the agent the recording names', async () => {
    const recorded = await session(['--for', 'claude'], async (proxyUrl) => {
      await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          messages: [{ role: 'user', content: 'x' }],
        }),
      });
    });
    lines.length = 0;

    await session(['--replay', recorded.runId, '--for', 'generic-openai'], async () => {});

    expect(lines.join('')).toContain('export OPENAI_BASE_URL=');
  });

  /**
   * A replay session that could not answer the agent has to be detectable by a script, not only
   * by a human reading the log — CI is exactly where a sandbox replay runs.
   */
  it('reports a request the recording could not answer', async () => {
    const recorded = await session(['--for', 'claude'], async (proxyUrl) => {
      await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          messages: [{ role: 'user', content: 'x' }],
        }),
      });
    });

    const replayed = await session(['--replay', recorded.runId], async (proxyUrl) => {
      // A question the recording never held an answer for.
      await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          messages: [{ role: 'user', content: 'something else entirely' }],
        }),
      });
    });

    expect(replayed.unmatched).toBeGreaterThan(0);
    expect(replayed.exitCode).toBe(1);
  });

  it('exits zero for a session that served everything it was asked for', async () => {
    const recorded = await session(['--for', 'claude'], async (proxyUrl) => {
      await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          messages: [{ role: 'user', content: 'x' }],
        }),
      });
    });
    const replayed = await session(['--replay', recorded.runId], async (proxyUrl) => {
      await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          messages: [{ role: 'user', content: 'x' }],
        }),
      });
    });
    expect(replayed.exitCode).toBe(0);
  });

  it('exits zero for a recording session, which cannot fail by being stopped', async () => {
    const result = await session(['--for', 'claude'], async () => {});
    expect(result.exitCode).toBe(0);
  });

  it('says the recording is being served, not recorded, so nothing looks like a fresh run', async () => {
    const recorded = await session(['--for', 'claude'], async (proxyUrl) => {
      await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          messages: [{ role: 'user', content: 'x' }],
        }),
      });
    });
    lines.length = 0;
    await session(['--replay', recorded.runId], async () => {});
    expect(lines.join('')).toContain('egress=blocked');
  });

  it('says so plainly when the session ended having captured nothing', async () => {
    const result = await session([], async () => {});
    expect(result.modelExchanges).toBe(0);
    expect(lines.join('')).toContain('capture.empty');
  });
});
