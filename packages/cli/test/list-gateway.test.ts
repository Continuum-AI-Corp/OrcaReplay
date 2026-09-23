import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceWriter } from '@orcareplay/core';
import { parseArgs } from '../src/args.js';
import { Output, stripAnsi, type LogEntry } from '../src/out.js';
import { listCommand } from '../src/commands/inspect.js';
import { pullCommand, pushCommand } from '../src/commands/sync.js';
import { writeConfig } from '../src/config.js';

/**
 * `orca list --remote`, against a gateway stood up in-process.
 *
 * The same shape as the push and pull tests and for the same reason: what a command talking to a
 * gateway gets wrong is the wire — which path, which query, which header carries the key, what a
 * 4xx body means — and a stubbed fetch asserts only that the code calls the function the test
 * already believes it calls.
 *
 * Why the command exists at all: `pull` takes an id and cannot default one, because "last" means
 * nothing for a run this machine has never seen. Until this, the only place to read that id was
 * the gateway's console in a browser — so the terminal could push a run but could not discover
 * one, and a run the gateway recorded ITSELF (most of them) was not reachable from here at all.
 */
describe('orca list --remote', () => {
  let home: string;
  let server: Server;
  let url: string;
  let out: Output;
  let lines: string[];
  let logs: LogEntry[];
  let received: { method: string; path: string; auth?: string; apiKey?: string }[];
  let reply: { status: number; body: string };

  /**
   * A LISTING ITEM CAPTURED FROM A REAL GATEWAY, FIELD FOR FIELD.
   *
   * The first version of this fixture was written from the mapping rather than from a response,
   * so it carried `created_at` and an outcome of `ok` — neither of which the gateway sends. The
   * tests passed against the invention and the STARTED column was empty against the real thing.
   * A fixture a person made up tests only that the code agrees with the person.
   */
  const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    run_key: 'run_67a7ce30bd6a',
    source: 'upload',
    client_app: 'claude-code',
    turns: 5,
    tool_calls: 3,
    models: ['claude-opus-5'],
    layers: ['model', 'fs'],
    outcome: 'exit 0',
    bytes: 201620,
    ...over,
  });

  const holding = (...items: Record<string, unknown>[]): string =>
    JSON.stringify({ success: true, data: { items } });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orca-list-home-'));
    lines = [];
    logs = [];
    out = new Output({
      write: (l) => void lines.push(l),
      sink: (e) => void logs.push(e),
      isTTY: false,
    });
    received = [];
    reply = { status: 200, body: holding(item()) };
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received.push({
          method: req.method ?? '',
          path: req.url ?? '',
          auth: req.headers.authorization,
          apiKey: req.headers['x-api-key'] as string | undefined,
        });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    await rm(home, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    XDG_CONFIG_HOME: home,
    ORCA_GATEWAY_URL: url,
    ORCA_GATEWAY_KEY: 'sk-replay-test',
    ...extra,
  });

  const text = (): string => stripAnsi(lines.join('\n'));

  it('asks the gateway on the path push already posts to, and prints what it holds', async () => {
    await listCommand(parseArgs(['list', '--remote']), out, home, env());

    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe('GET');
    expect(received[0]!.path).toBe('/api/replay/runs?limit=20');

    const rendered = text();
    expect(rendered).toContain('RUN');
    expect(rendered).toContain('run_67a7ce30bd6a');
    expect(rendered).toContain('upload');
    expect(rendered).toContain('claude-code');
    expect(rendered).toContain('claude-opus-5');
    // Reported outright by the listing, and the column that says what is IN a run.
    expect(rendered).toContain('LAYERS');
    expect(rendered).toContain('model,fs');
    // `outcome` is the run's exit status as a string — not a status word this invented.
    expect(rendered).toContain('exit 0');
    // The listing exists to be acted on, and pull is the only thing to do with a run not here yet.
    expect(rendered).toContain('orca pull <run>');
  });

  /**
   * Passed through, not reimplemented. Filtering locally would page the gateway for runs only to
   * throw them away, and `--limit` would then mean something different from what the console means
   * by it.
   */
  it('forwards --limit and --source to the gateway rather than filtering here', async () => {
    reply = {
      status: 200,
      body: holding(item(), item({ run_key: 'run_second', source: 'gateway' })),
    };
    await listCommand(
      parseArgs(['list', '--remote', '--source', 'gateway', '--limit', '3']),
      out,
      home,
      env(),
    );

    const query = new URL(`${url}${received[0]!.path}`).searchParams;
    expect(query.get('limit')).toBe('3');
    expect(query.get('source')).toBe('gateway');
    // Whatever the gateway answered is what is shown — the filtering is its job, not a second one
    // done again here.
    expect(text()).toContain('run_second');
  });

  it('omits source entirely when it was not asked for, rather than guessing one', async () => {
    await listCommand(parseArgs(['list', '--remote']), out, home, env());
    expect(received[0]!.path).not.toContain('source');
  });

  /** The same rule push is held to: the key goes in headers, and never to a terminal. */
  it('sends the key as a header and never prints it', async () => {
    await listCommand(parseArgs(['list', '--remote']), out, home, env());

    expect(received[0]!.auth).toBe('Bearer sk-replay-test');
    expect(received[0]!.apiKey).toBe('sk-replay-test');
    expect(received[0]!.path).not.toContain('sk-replay-test');
    expect(text()).not.toContain('sk-replay-test');
    for (const entry of logs) expect(JSON.stringify(entry)).not.toContain('sk-replay-test');
  });

  it('refuses to list without a key rather than listing anonymously', async () => {
    await expect(
      listCommand(parseArgs(['list', '--remote']), out, home, {
        XDG_CONFIG_HOME: home,
        ORCA_GATEWAY_URL: url,
      }),
    ).rejects.toThrow(/key/i);
    // Not "sent without the header" — not sent at all.
    expect(received).toHaveLength(0);
  });

  it('explains a refused listing instead of printing an empty table', async () => {
    reply = {
      status: 403,
      body: JSON.stringify({ success: false, message: 'key lacks the replay scope' }),
    };
    await expect(listCommand(parseArgs(['list', '--remote']), out, home, env())).rejects.toThrow(
      /replay scope/,
    );
    expect(text()).not.toContain('RUN');
  });

  it('says the gateway is holding nothing rather than printing a headed empty table', async () => {
    reply = { status: 200, body: holding() };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());
    expect(text()).toContain('holding no runs');
    expect(text()).not.toContain('RUN ');
  });

  /**
   * A gateway recording has no client app, a run may carry no model list, and TODAY'S LISTING
   * CARRIES NO TIMESTAMP AT ALL — a captured response is
   * `{run_key,source,client_app,turns,tool_calls,models,layers,outcome,bytes}`. An empty cell
   * reads as a rendering fault, and `1970-01-01` for a field that was never sent reads as a
   * fact — the wrong one.
   */
  it('marks what the gateway did not report instead of rendering it as something', async () => {
    reply = {
      status: 200,
      body: holding(item({ client_app: '', models: [], outcome: '', layers: [] })),
    };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());

    const row =
      text()
        .split('\n')
        .find((l) => l.includes('run_67a7ce30bd6a')) ?? '';
    expect(row).not.toContain('1970');
    // STARTED, APP, LAYERS, MODELS and OUTCOME — five cells the gateway left unsaid.
    expect(row.match(/—/g) ?? []).toHaveLength(5);
    // What it DID report is still reported.
    expect(row).toContain('run_67a7ce30bd6a');
    expect(row).toContain('upload');
  });

  /**
   * THE FIELD THE MAPPING GUESSED.
   *
   * `created_at` is in no captured response: the detail endpoint's `session` object carries
   * `first_ts`/`last_ts`, and the listing item carries no timestamp. The console has a Started
   * column, so a deployment may well fill one — under whichever of the three names. Reading all
   * of them is the difference between a column that works everywhere and one that worked nowhere.
   */
  it.each(['started_at', 'created_at', 'first_ts'])('dates a run from %s', async (key) => {
    reply = { status: 200, body: holding(item({ [key]: 1_789_459_407 })) };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());
    expect(text()).toContain('2026-09-15 08:03');
  });

  it('counts tool calls and names the layers, both straight from the listing', async () => {
    reply = {
      status: 200,
      body: holding(item({ tool_calls: 9, layers: ['model', 'route', 'shell'] })),
    };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());

    const row =
      text()
        .split('\n')
        .find((l) => l.includes('run_67a7ce30bd6a')) ?? '';
    expect(text()).toContain('TOOLS');
    expect(row).toContain('model,route,shell');
    expect(row.split(/\s\s+/)).toContain('9');
  });

  /** Same listing endpoint, a different host named for this one invocation. */
  it('honours --gateway as an override of which host, not as the switch', async () => {
    await writeConfig(
      { gateway: { url: 'https://gateway.example.internal', url_source: 'named' } },
      { XDG_CONFIG_HOME: home },
    );
    await listCommand(parseArgs(['list', '--remote', '--gateway', url]), out, home, {
      XDG_CONFIG_HOME: home,
      ORCA_GATEWAY_KEY: 'sk-replay-test',
    });
    expect(received).toHaveLength(1);
  });

  /**
   * THE LISTING IS WHERE A RUN ID COMES FROM, SO A ROW IN IT IS A CLAIM.
   *
   * `client_app` is not the operator's string alone — the gateway derives it from request headers
   * under its own Client App Identification rules, so anyone who can route traffic through the
   * workspace chooses part of what this prints. A newline in it used to split one row into two,
   * and the invented second row carried a run key that `orca pull` would then be asked for.
   */
  it('cannot be made to print a run the gateway did not list', async () => {
    const forged = `cc\nrun_deadbeefcafe0123456789ab  2026-09-20 10:00  gateway  trusted`;
    reply = { status: 200, body: holding(item({ client_app: forged })) };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());

    const body = text()
      .trim()
      .split('\n')
      .filter((l) => l.includes('run_'));
    // One item in, one line out — and the forged key is visible as text in a cell, not as a row.
    expect(body).toHaveLength(1);
    expect(body[0]).toContain('run_67a7ce30bd6a');
    expect(body[0]).toContain('\\x0a');
  });

  it('cannot rewrite a row after printing it, or reach for the terminal', async () => {
    const ESC_C = String.fromCharCode(27);
    reply = {
      status: 200,
      body: holding(
        item({
          outcome: `exit 0${String.fromCharCode(13)}exit 137`,
          client_app: `${ESC_C}[2J${ESC_C}[Hgotcha`,
        }),
      ),
    };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());

    expect(text()).not.toContain(ESC_C);
    expect(text()).not.toContain(String.fromCharCode(13));
    expect(text()).toContain('\\x0d');
    expect(text()).toContain('\\x1b[2J');
  });

  it('leaves the local listing alone when --remote is not given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-list-local-'));
    try {
      const run = await TraceWriter.create(join(dir, '.orca', 'runs'), {
        adapter: { id: 'claude-code', version: '0.0.0' },
        argv: ['claude-code'],
        cwd: dir,
        orcaVersion: '0.0.0',
      });
      await run.close(0);

      await listCommand(parseArgs(['list']), out, dir, env());

      // No network at all, and the local columns — not the gateway's.
      expect(received).toHaveLength(0);
      expect(text()).toContain(run.runId);
      expect(text()).toContain('FROM');
      expect(text()).not.toContain('OUTCOME');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * THE MESSAGE HAS TO NAME WHAT IS ACTUALLY AT STAKE.
 *
 * `resolveGateway` is shared by push, pull and list, and both of its refusals were written for
 * push alone. Told that "a run carries source, shell output and workspace snapshots", someone who
 * asked for a LISTING is being warned about a disclosure they are not making — and a message that
 * is wrong once stops being read. The rules are identical for all three; only the reason differs,
 * so only the sentence does.
 */
describe('gateway refusals name the operation they are refusing', () => {
  let home: string;
  let workspace: string;
  let out: Output;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orca-refusal-home-'));
    workspace = await mkdtemp(join(tmpdir(), 'orca-refusal-'));
    out = new Output({ write: () => {}, isTTY: false });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  const setupDefault = async (): Promise<NodeJS.ProcessEnv> => {
    await writeConfig(
      { gateway: { url: 'https://api.orcarouter.ai', url_source: 'default', api_key: 'sk-x' } },
      { XDG_CONFIG_HOME: home },
    );
    return { XDG_CONFIG_HOME: home };
  };

  const noKey = (): NodeJS.ProcessEnv => ({
    XDG_CONFIG_HOME: home,
    ORCA_GATEWAY_URL: 'https://gateway.example.internal',
  });

  const thrown = async (run: Promise<unknown>): Promise<string> => {
    try {
      await run;
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it('warns a push about the run, and a listing only about the key', async () => {
    const env = await setupDefault();

    const push = await thrown(pushCommand(parseArgs(['push', 'last']), out, workspace, env));
    expect(push).toMatch(/not a destination you named/);
    expect(push).toMatch(/shell output and workspace snapshots/);

    const list = await thrown(listCommand(parseArgs(['list', '--remote']), out, workspace, env));
    expect(list).toMatch(/not a destination you named/);
    expect(list).toMatch(/Your key goes there\./);
    // The listing sends no run, so it must not claim to.
    expect(list).not.toMatch(/workspace snapshots/);

    const pull = await thrown(pullCommand(parseArgs(['pull', 'run_x']), out, workspace, env));
    expect(pull).toMatch(/written into this machine/);
    expect(pull).not.toMatch(/workspace snapshots/);
  });

  it('names the operation in the refusal to go unauthenticated', async () => {
    expect(await thrown(pushCommand(parseArgs(['push', 'last']), out, workspace, noKey()))).toMatch(
      /A push needs a key/,
    );
    expect(
      await thrown(listCommand(parseArgs(['list', '--remote']), out, workspace, noKey())),
    ).toMatch(/Listing needs a key/);
    expect(
      await thrown(pullCommand(parseArgs(['pull', 'run_x']), out, workspace, noKey())),
    ).toMatch(/A pull needs a key/);
  });
});
