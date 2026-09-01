import { execFile } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader } from '@orcareplay/core';
import { RunCa } from '@orcareplay/proxy';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { replayCommand } from '../src/commands/replay.js';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const IDE_PARENT = join(here, 'fixtures', 'ide-parent.mjs');
const PROXY_CALL = join(here, 'fixtures', 'proxy-call.mjs');

/**
 * A Grok bot, and any other agent whose origin is a string in its own source.
 *
 * Every capture mechanism orca had before this needed the agent's cooperation: a base-URL variable
 * it reads, or a `fetch` it inherits. A bot with `https://api.x.ai/v1` typed into it has neither,
 * and there are a great many of those — it is what someone writes in an afternoon, and it is what
 * the "grok bot" people ask about usually is.
 *
 * `--tls-intercept` was already able to record such a thing. What was missing was a way to say so:
 * `generic-openai` would have injected `OPENAI_BASE_URL` and repointed an agent that never asked,
 * and no test proved the intercept-only path worked end to end for an agent orca knows nothing
 * about. These are that proof, and they are deliberately end to end — a real child process, a real
 * CONNECT, real TLS, and a replay with the origin taken away.
 *
 * The bot's origin is written into its source by the test rather than read from the environment.
 * That is the property under test, so it is asserted directly: the generated source is checked to
 * contain no base-URL variable at all. A test cannot dial `api.x.ai`, so the literal is a local
 * address — the hostname was never the point, the absence of a redirect is.
 */
describe('end to end: an agent whose origin is hardcoded', () => {
  let workspace: string;
  let originDir: string;
  let originCa: RunCa;
  let xai: { port: number; calls: unknown[]; close: () => Promise<void> };
  let out: Output;
  let lines: string[];
  let botPath: string;

  /** An xAI-shaped origin: OpenAI chat completions, served over TLS, deterministic. */
  async function startXai(): Promise<typeof xai> {
    const calls: unknown[] = [];
    const issued = originCa.issue('127.0.0.1');
    const server = createHttpsServer({ key: issued.keyPem, cert: issued.certPem }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => void chunks.push(c));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          /* an unparseable body still gets a well-formed reply */
        }
        calls.push({ url: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-grok-1',
            object: 'chat.completion',
            created: 1,
            model: body.model ?? 'grok-4',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'rejecting tokens under 8 characters' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: (server.address() as AddressInfo).port,
      calls,
      close: () => new Promise<void>((resolve) => void server.close(() => resolve())),
    };
  }

  /**
   * The bot, with its origin baked in as a literal exactly as a real one has.
   *
   * It CONNECTs through `HTTPS_PROXY` by hand because Node's own client does not honour proxy
   * environment variables before v24 — the same reason the other TLS fixtures here do. That is not
   * a concession: a bot written against `curl`, `requests` or `httpx` gets this behaviour from its
   * HTTP library, and doing it by hand is what keeps this a test of orca rather than of Node.
   */
  function botSource(port: number): string {
    return `import { callThroughProxy } from ${JSON.stringify(PROXY_CALL)};
import { writeFileSync } from 'node:fs';

// Typed into the source, the way a real bot's origin usually is. Nothing below reads it from the
// environment, which is the whole reason this agent needs interception to be recorded at all.
const XAI_HOST = '127.0.0.1';
const XAI_PORT = ${port};
const XAI_PATH = '/v1/chat/completions';

const reply = await callThroughProxy({
  host: XAI_HOST,
  port: XAI_PORT,
  path: XAI_PATH,
  method: 'POST',
  body: JSON.stringify({
    model: 'grok-4',
    messages: [{ role: 'user', content: 'reject tokens shorter than 8 characters' }],
  }),
});

console.log('grok-bot: ' + JSON.parse(reply.body).choices[0].message.content);
if (process.env.ORCA_TEST_RESULT_OUT) {
  writeFileSync(process.env.ORCA_TEST_RESULT_OUT, JSON.stringify(reply, null, 2));
}
`;
  }

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-grokbot-'));
    originDir = await mkdtemp(join(tmpdir(), 'orca-grokorigin-'));
    originCa = await RunCa.create({ runDir: originDir });
    xai = await startXai();
    botPath = join(workspace, 'grok-bot.mjs');
    await writeFile(botPath, botSource(xai.port));

    lines = [];
    out = new Output({ write: (s) => void lines.push(s), isTTY: false });
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });

    // The origin is signed by a CA no machine trusts. Real interception verifies the origin it
    // re-encrypts to, so the proxy is told about that root the way a corporate one would be.
    process.env.ORCA_TLS_UPSTREAM_CA = originCa.certPath;
  });

  afterEach(async () => {
    delete process.env.ORCA_TLS_UPSTREAM_CA;
    delete process.env.ORCA_TEST_RESULT_OUT;
    await xai.close();
    await originCa.dispose();
    await rm(originDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  const record = (...extra: string[]) =>
    recordCommand(
      parseArgs([
        'record',
        'exec',
        '--tls-intercept',
        '--tls-hosts',
        `127.0.0.1:${xai.port}`,
        ...extra,
        '--',
        process.execPath,
        botPath,
      ]),
      out,
      workspace,
    );

  it('reads no base-url variable, which is what makes it need interception', async () => {
    const source = await readFile(botPath, 'utf8');
    expect(source).not.toMatch(/_BASE_URL|_API_BASE/);
    expect(source).toContain('/v1/chat/completions');
  });

  it('records the call as a model exchange, not as opaque traffic', async () => {
    const result = await record();

    expect(result.exitCode).toBe(0);
    // The assertion that matters. Intercepted bytes on a path no dialect claims land as `net.*`
    // and can never be replayed; the openai dialect claiming `/v1/chat/completions` is what makes
    // this a recording rather than a transcript.
    expect(result.modelExchanges).toBe(1);
    expect(lines.find((l) => l.includes('capture.empty'))).toBeUndefined();

    const events = await (await TraceReader.open(result.runDir)).events();
    expect(events.filter((e) => e.type === 'model.request')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'net.request')).toHaveLength(0);
  });

  it('never repoints the bot at a provider it did not choose', async () => {
    await record();
    // `exec` injects no origin, so the only reason the call was captured is that orca terminated
    // the TLS the bot established itself. An adapter that started setting OPENAI_BASE_URL here
    // would still make this test pass on exchange count — and would have changed where a bot with
    // its own OpenAI client sent its traffic. The origin's own call log is what proves it did not.
    expect(xai.calls).toHaveLength(1);
    expect((xai.calls[0] as { url: string }).url).toBe('/v1/chat/completions');
  });

  it('replays the bot offline, with the origin taken away', async () => {
    const result = await record();
    const before = xai.calls.length;
    await xai.close();

    const replay = await replayCommand(parseArgs(['replay', result.runId]), out, workspace);

    expect(replay.exitCode).toBe(0);
    expect(replay.matchedExact).toBe(1);
    expect(replay.unmatched).toBe(0);
    expect(xai.calls.length).toBe(before);
  });

  /**
   * Replaying an intercepted run without having to remember how it was recorded.
   *
   * Interception is two flags, and a replay that dropped them did not fail loudly — it started a
   * proxy with no interception, tunnelled the bot's CONNECT to an origin that was gone, and
   * reported `reused=0/1` as though the recording were at fault. The recording already knew: the
   * run writes a `tls_intercept` note naming the hosts it decrypted. Reading it back is what makes
   * `orca replay last` work on an intercepted run, which is the only thing anyone types.
   */
  it('re-establishes interception from the recording, with no flags repeated', async () => {
    const result = await record();
    await xai.close();
    lines.length = 0;

    const replay = await replayCommand(parseArgs(['replay', result.runId]), out, workspace);

    expect(replay.exitCode).toBe(0);
    // Minting a CA is never silent, even when orca decided on it rather than the operator.
    expect(lines.join('')).toContain('tls.intercepting');
    expect(lines.join('')).toContain(`127.0.0.1:${xai.port}`);
  });

  it('still lets the operator refuse, and says why the replay then cannot match', async () => {
    const result = await record();
    await xai.close();
    lines.length = 0;

    const replay = await replayCommand(
      parseArgs(['replay', result.runId, '--no-tls-intercept']),
      out,
      workspace,
    );

    expect(lines.join('')).not.toContain('tls.intercepting');
    expect(replay.matchedExact).toBe(0);
  });

  /**
   * Codex-in-the-IDE, and the reason it is not above the ceiling.
   *
   * The editor spawns the agent, so orca never gets to build that process's environment. It does
   * not need to: the editor inherits the capture and passes it on. This is the same property the
   * gateway test pins for base-URL variables, checked here for the interception half — `HTTPS_PROXY`
   * and the run CA have to survive the same hop, and nothing guarantees that but a test.
   */
  it('reaches an agent two processes down, which is how an IDE spawns one', async () => {
    const result = await recordCommand(
      parseArgs([
        'record',
        'exec',
        '--tls-intercept',
        '--tls-hosts',
        `127.0.0.1:${xai.port}`,
        '--',
        process.execPath,
        IDE_PARENT,
        botPath,
      ]),
      out,
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.modelExchanges).toBe(1);
    expect(xai.calls).toHaveLength(1);
  });

  it('replays the IDE-spawned agent offline too', async () => {
    const result = await recordCommand(
      parseArgs([
        'record',
        'exec',
        '--tls-intercept',
        '--tls-hosts',
        `127.0.0.1:${xai.port}`,
        '--',
        process.execPath,
        IDE_PARENT,
        botPath,
      ]),
      out,
      workspace,
    );
    await xai.close();

    const replay = await replayCommand(parseArgs(['replay', result.runId]), out, workspace);

    expect(replay.exitCode).toBe(0);
    expect(replay.matchedExact).toBe(1);
    expect(replay.unmatched).toBe(0);
  });
});
