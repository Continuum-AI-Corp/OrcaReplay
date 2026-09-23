import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceWriter } from '@orcareplay/core';
import { parseArgs } from '../src/args.js';
import { Output, stripAnsi, type LogEntry } from '../src/out.js';
import { listCommand } from '../src/commands/inspect.js';
import { main } from '../src/main.js';
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
   * A LISTING ITEM CAPTURED FROM A REAL GATEWAY, FIELD FOR FIELD — an older deployment, which
   * sends nine fields and no timestamp.
   *
   * The first version of this fixture was written from the mapping rather than from a response,
   * and carried an outcome of `ok`, which no deployment sends. A fixture a person made up tests
   * only that the code agrees with the person. (It also carried `created_at`, and a later comment
   * here claimed no gateway sends that. Production does — see `prodItem` — and saying otherwise
   * was the same mistake one level up: a claim about every deployment, from a capture of one.)
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

  /**
   * A LISTING ITEM IN THE SHAPE PRODUCTION SENDS — all twenty-eight fields, read through the
   * gateway's own console on 2026-09-23. Timings are production's: this row's first event and the
   * gateway storing it (the push) are 103 seconds apart, which is what decides the STARTED
   * column. Account identifiers are replaced; the shape and types are not.
   */
  const prodItem = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    agent_id: 0,
    bytes: 2598,
    carried_bytes: 0,
    carried_bytes_expire_at: 0,
    client_app: 'generic-openai',
    completion_tokens: 12,
    created_at: 1_789_459_407 + 103,
    expire_at: 1_789_459_407 + 103 + 2_592_001,
    findings_at: 1_789_459_407 + 103,
    first_ts: 1_789_459_407,
    id: 1,
    last_ts: 1_789_459_407 + 1,
    layers: ['model', 'fs'],
    max_expire_at: 0,
    models: ['m'],
    outcome: 'exit 0',
    prompt_id: 0,
    prompt_tokens: 9,
    quota: 0,
    run_key: 'run_3d9e61a07b52',
    source: 'upload',
    stats_from_preview: false,
    token_id: 1,
    tool_calls: 0,
    turns: 1,
    updated_at: 1_789_459_407 + 103,
    user_id: 1,
    workspace_id: 1,
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
    // For a pushed run `outcome` is its exit; a gateway recording reports `end_turn` or `error`.
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

  /**
   * A ROW THAT IS NOT A RUN IS NOT A ROW.
   *
   * `items` was mapped straight through, so `null` in it read `run_key` off nothing and the user
   * got `Cannot read properties of null (reading 'run_key')` with orca's name on it. A string or
   * a number in there fared no better: every field came out empty and the reader was shown a run
   * with no id, which is a run they cannot pull. Counted rather than dropped in silence — a
   * gateway sending these is broken, and the count is the only evidence the reader gets.
   */
  it('skips entries that are not runs instead of reading fields off them', async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        success: true,
        data: { items: [null, 'a string', 42, [], { run_key: '' }, { run_key: 'run_abc123' }] },
      }),
    };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());

    const rows = text()
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('run_'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('run_abc123');
    expect(logs.map((l) => l.event)).toContain('list.skipped');
    expect(logs.find((l) => l.event === 'list.skipped')?.fields['entries']).toBe(5);
  });

  /**
   * A 2xx THAT IS NOT JSON IS SOMEBODY ELSE ANSWERING. `refusal` already says as much about error
   * bodies — "a proxy in between may answer instead of the gateway" — and the success path had no
   * such thought, so a captive portal's login page surfaced as `Unexpected token '<'`, which
   * reads as a bug in orca rather than as the network fact it is.
   */
  it('names a proxy or portal rather than reporting a JSON parse error', async () => {
    reply = { status: 200, body: '<html><body>502 Bad Gateway</body></html>' };
    const failed = await listCommand(parseArgs(['list', '--remote']), out, home, env()).catch(
      (e: Error) => e.message,
    );
    expect(failed).toContain('not JSON');
    expect(failed).toMatch(/proxy|portal/);
    expect(failed).not.toContain('Unexpected token');
  });

  /** The shape `orca gc --keep` refuses, for the same reason: a count has to be one. */
  it.each([['0'], ['-1'], ['2.5']])('refuses --limit %s rather than asking for it', async (n) => {
    await expect(
      listCommand(parseArgs(['list', '--remote', '--limit', n]), out, home, env()),
    ).rejects.toThrow(/--limit needs a whole number/);
    expect(received).toHaveLength(0);
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

  /**
   * `--json` IS A SECOND SINK FOR THE SAME COMMAND, NOT A DIFFERENT COMMAND.
   *
   * `jsonMain` read `orca.list()` and never looked at `--remote`, so
   * `orca list --remote --json` ran the LOCAL listing: from a directory with no runs it emitted
   * `[]` and exited 0, telling a script the gateway holds nothing while the same command without
   * `--json` printed what it holds. A wrong answer, in silence, to the reader least able to
   * notice — the one that is not a person.
   */
  describe('--json asks the same question the terminal does', () => {
    const emitted: string[] = [];
    let stdout: typeof process.stdout.write;
    let stderr: typeof process.stderr.write;

    beforeEach(() => {
      emitted.length = 0;
      stdout = process.stdout.write.bind(process.stdout);
      stderr = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((c: string) => {
        emitted.push(String(c));
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
    });

    afterEach(() => {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    });

    const run = async (argv: string[]): Promise<{ code: number; doc: unknown }> => {
      const keep = { ...process.env };
      Object.assign(process.env, env());
      try {
        const code = await main(argv, home);
        return { code, doc: JSON.parse(emitted.join('')) };
      } finally {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, keep);
      }
    };

    it('emits the gateway runs rather than an empty local listing', async () => {
      const { code, doc } = await run(['list', '--remote', '--json']);
      expect(code).toBe(0);
      expect(Array.isArray(doc)).toBe(true);
      expect(doc).toHaveLength(1);
      expect((doc as { runKey: string }[])[0]!.runKey).toBe('run_67a7ce30bd6a');
      expect((doc as { layers: string[] }[])[0]!.layers).toEqual(['model', 'fs']);
      expect(received).toHaveLength(1);
    });

    it('forwards the listing flags from the json path too', async () => {
      await run(['list', '--remote', '--source', 'gateway', '--limit', '2', '--json']);
      const q = new URL(`${url}${received[0]!.path}`).searchParams;
      expect(q.get('source')).toBe('gateway');
      expect(q.get('limit')).toBe('2');
    });

    /**
     * The plain path refuses both of these before anything runs, over a comment saying a flag the
     * command does not have is an instruction that would be silently ignored. `--json` returned
     * above that comment, so it ignored them — `orca show --worktre --json` did the opposite of
     * what was typed and said nothing.
     */
    it.each([
      [['list', '--bogus', '--json'], /unknown flag --bogus/],
      [['list', '--remote', 'stray', '--json'], /unexpected argument/],
      [['list', '--remote', '--source', 'gatway', '--json'], /--source is gateway or upload/],
      [['list', '--limit', '3', '--json'], /asks the gateway, and nothing here does/],
    ])('refuses %j as the terminal would', async (argv, expected) => {
      const { code, doc } = await run(argv as string[]);
      expect(code).toBe(1);
      expect((doc as { error: { message: string } }).error.message).toMatch(expected as RegExp);
      // Refused BEFORE the request, not after it.
      expect(received).toHaveLength(0);
    });
  });

  /**
   * A FLAG THAT ASKS THE GATEWAY, WHEN NOTHING ASKS THE GATEWAY.
   *
   * Adding `--gateway`, `--source` and `--limit` to `list`'s allowlist let them past
   * `assertKnownFlags` unconditionally, and then the local listing ran and dropped them. The worst
   * of the three: `orca list --gateway <url>` printed THIS directory's runs to someone who had just
   * named a host, which reads as that host's answer.
   *
   * Driven through `main()`, because that is where flags are judged — a command function trusts the
   * arguments it is handed, which is why calling `listCommand` directly would pass against the bug.
   */
  describe('a flag that asks the gateway needs --remote', () => {
    let printed: string[];
    let stdout: typeof process.stdout.write;
    let stderr: typeof process.stderr.write;

    beforeEach(() => {
      printed = [];
      stdout = process.stdout.write.bind(process.stdout);
      stderr = process.stderr.write.bind(process.stderr);
      const grab = ((c: string) => {
        printed.push(String(c));
        return true;
      }) as typeof process.stdout.write;
      process.stdout.write = grab;
      process.stderr.write = grab;
    });

    afterEach(() => {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    });

    const run = async (argv: string[]): Promise<number> => {
      const keep = { ...process.env };
      Object.assign(process.env, env());
      try {
        return await main(argv, home);
      } finally {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, keep);
      }
    };

    it.each([
      [['--gateway', 'http://127.0.0.1:1']],
      [['--source', 'gateway']],
      [['--limit', '3']],
      // Wrong for a reason that has nothing to do with `abc`, and that is the reason worth giving.
      [['--limit', 'abc']],
    ])('refuses %j without --remote instead of ignoring it', async (extra) => {
      const code = await run(['list', ...(extra as string[])]);
      expect(code).toBe(1);
      expect(stripAnsi(printed.join(''))).toMatch(
        /asks the gateway, and nothing here does: add --remote/,
      );
      // Refused before anything was asked of anyone.
      expect(received).toHaveLength(0);
    });

    it('names every orphan at once rather than one per attempt', async () => {
      await run(['list', '--source', 'gateway', '--limit', '3']);
      expect(stripAnsi(printed.join(''))).toMatch(/--source, --limit ask the gateway/);
    });

    it('still lets them through with --remote', async () => {
      const code = await run(['list', '--remote', '--source', 'gateway', '--limit', '3']);
      expect(code).toBe(0);
      expect(received).toHaveLength(1);
    });
  });

  /**
   * Seconds, milliseconds and microseconds do not overlap across the years a run can have started
   * in, so the magnitude says which one arrived. Before: a millisecond value rendered as the year
   * 58675, and a microsecond one made `toISOString` throw and took the whole listing down.
   */
  it.each([
    ['seconds', 1_789_459_407],
    ['milliseconds', 1_789_459_407_000],
    ['microseconds', 1_789_459_407_000_000],
  ])('reads a start time given in %s', async (_unit, value) => {
    reply = { status: 200, body: holding(item({ started_at: value })) };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());
    expect(text()).toContain('2026-09-15 08:03');
  });

  /** `-1` is not 1969 and `1e300` is not a date: neither is a start time, so neither is shown as one. */
  it.each([
    ['a negative number', -1],
    ['a number no date can hold', 1e300],
    ['a start before this product existed', 86_400],
  ])('shows no start time for %s', async (_what, value) => {
    reply = { status: 200, body: holding(item({ started_at: value })) };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());
    const row =
      text()
        .split('\n')
        .find((l) => l.includes('run_67a7ce30bd6a')) ?? '';
    expect(row).not.toMatch(/19[67][0-9]-/);
    expect(row.split(/\s\s+/)[1]).toBe('—');
  });

  it('falls through a start time nobody could believe to one they could', async () => {
    reply = { status: 200, body: holding(item({ started_at: -1, first_ts: 1_789_459_407 })) };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());
    expect(text()).toContain('2026-09-15 08:03');
  });

  /** `null` is valid JSON with no properties, and reading `.data` off it crashed the listing. */
  it('reads a null body as holding nothing rather than as a crash', async () => {
    reply = { status: 200, body: 'null' };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());
    expect(text()).toContain('holding no runs');
  });

  /**
   * THE RUN'S START, NOT THE PUSH.
   *
   * `created_at` is when the gateway stored the row; for a pushed run that is the push, and in
   * production it trails the run's first event by as long as you waited. Preferring it printed
   * the push as STARTED — and the same run showed two start times, one in `orca list` and another
   * in `orca list --remote`.
   */
  it('dates a pushed run from its first event, not from the push', async () => {
    reply = { status: 200, body: holding(prodItem()) };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());
    const row =
      text()
        .split('\n')
        .find((l) => l.includes('run_3d9e61a07b52')) ?? '';
    expect(row).toContain('2026-09-15 08:03');
    expect(row).not.toContain('08:05');
  });

  it('renders a gateway recording the way production reports one', async () => {
    reply = {
      status: 200,
      body: holding(
        prodItem({
          run_key: 'run_8c14f2e9a07d3b6150e2c49a',
          source: 'gateway',
          client_app: 'Unknown',
          layers: ['model', 'route'],
          models: ['deepseek/deepseek-v4-flash-free'],
          outcome: 'end_turn',
          created_at: 1_789_459_407 + 3,
        }),
      ),
    };
    await listCommand(parseArgs(['list', '--remote']), out, home, env());
    const row =
      text()
        .split('\n')
        .find((l) => l.includes('run_8c14f2e9a07d3b6150e2c49a')) ?? '';
    expect(row).toMatch(
      /gateway\s+Unknown\s+1\s+0\s+model,route\s+deepseek\/deepseek-v4-flash-free\s+end_turn/,
    );
  });

  /**
   * Production answers an unknown `source` with 200 and no items, so a typo printed "the gateway
   * is holding no runs" to someone whose gateway held forty-five: a slip at the keyboard, reported
   * as a fact about the server.
   */
  it.each([['gatway'], ['uploads'], ['all']])(
    'refuses --source %s before asking',
    async (value) => {
      const failed = await listCommand(
        parseArgs(['list', '--remote', '--source', value]),
        out,
        home,
        env(),
      ).catch((e: Error) => e.message);
      expect(failed).toMatch(/--source is gateway or upload/);
      expect(received).toHaveLength(0);
    },
  );

  it('sends the source the gateway knows, whatever its case', async () => {
    await listCommand(parseArgs(['list', '--remote', '--source', 'Gateway']), out, home, env());
    expect(new URL(`${url}${received[0]!.path}`).searchParams.get('source')).toBe('gateway');
  });

  it('says a filter matched nothing, rather than that the gateway holds nothing', async () => {
    reply = { status: 200, body: holding() };
    await listCommand(parseArgs(['list', '--remote', '--source', 'upload']), out, home, env());
    expect(text()).toContain('holding no upload runs');
    expect(text()).toContain('drop --source');
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
