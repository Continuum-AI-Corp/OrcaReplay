import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { Output, type LogEntry } from '../src/out.js';
import { pullCommand, pushCommand } from '../src/commands/sync.js';
import { main } from '../src/main.js';

/**
 * A gateway credential never reaches the terminal, from push or pull either.
 *
 * `config.ts` states the promise: "nothing ever prints it back". `orca setup` keeps it by hand —
 * it prints the gateway as `recordableOrigin(url) ?? '(unprintable)'` and wraps its own two fetch
 * failures in `withoutCredentials`. push/pull were NEW SINKS for the same value and simply did not
 * (orcacode-review), so the promise held for one command and not for the two added beside it.
 *
 * Both shapes here are ordinary, storable configurations rather than exotica: `unusableOrigin`'s
 * doc calls `https://user:pw@gw` sanitisable and deliberately admits it, and
 * `upstream-visible.test.ts` calls `https://gw.example/v1?key=…` "a query-authenticated gateway".
 * `orca setup` stores either.
 *
 * THE KEY MATTERS TO THE TEST, not just to the command. The first version of this file passed
 * `--gateway` with no credential configured, so push refused at "no API key for this gateway"
 * before it ever built a request — and every assertion below held against the UNFIXED code. A
 * homed key (env key's home is ORCA_GATEWAY_URL, see resolveGateway) is what carries execution as
 * far as undici, which is what puts the URL into an exception: "Request cannot be constructed from
 * a URL that includes credentials: …".
 *
 * Asserted on what is PRINTED, never on the text a command throws. Sanitising happens where the
 * message is rendered, so the raw exception legitimately still carries the URL — asserting on it
 * would demand a fix in the wrong place and fail against the right one.
 */
describe('push and pull never print the gateway credential', () => {
  const SECRET = 'hunter2SUPERSECRET';
  const runId = 'run_abc123';
  let workspace: string;
  let home: string;
  let out: Output;
  let logs: LogEntry[];
  let written: string[];
  let server: Server;
  let localUrl: string;

  const shapes = [
    { what: 'userinfo', url: `https://someone:${SECRET}@gw.example` },
    { what: 'a query key', url: `https://gw.example/v1?key=${SECRET}` },
  ];

  const envFor = (url: string): NodeJS.ProcessEnv => ({
    XDG_CONFIG_HOME: home,
    ORCA_GATEWAY_URL: url,
    ORCA_GATEWAY_KEY: 'sk-test-key',
  });

  /** Every byte this command could put in front of a human or into a CI log. */
  const everythingPrinted = (): string =>
    [...written, ...logs.map((e) => JSON.stringify(e))].join('\n');

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-cred-'));
    home = await mkdtemp(join(tmpdir(), 'orca-cred-home-'));
    logs = [];
    written = [];
    out = new Output({
      write: (s: string) => void written.push(s),
      sink: (e) => void logs.push(e),
      isTTY: false,
    });
    const dir = join(workspace, '.orca', 'runs', runId);
    await mkdir(join(dir, 'blobs', 'ab'), { recursive: true });
    await writeFile(
      join(dir, 'manifest.json'),
      `${JSON.stringify({ run_id: runId, schema_version: '0.1.0' }, null, 2)}\n`,
    );
    await writeFile(join(dir, 'events.jsonl'), '{"seq":1,"type":"run.start"}\n');
    await writeFile(join(dir, 'blobs', 'ab', 'abcdef'), Buffer.from([1, 2, 3]));

    // A gateway that ANSWERS, so push reaches its success line. The leak on that line is the one
    // that fires on every green run of the README's own `orca push last` recipe, and no amount of
    // testing the failure path reaches it.
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { run_key: runId } }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const addr = server.address();
    localUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  /*
  THE GUARD'S OWN GUARD: prove the command really reached the network, so a future change that
  makes it refuse earlier turns this suite red instead of quietly making it vacuous again — which
  is precisely how the first version of these tests passed against the bug.
  */
  it('reaches undici with the credentialed URL, which is what puts it in an error at all', async () => {
    let thrown = '(did not throw)';
    await pushCommand(parseArgs(['push', runId]), out, workspace, envFor(shapes[0]!.url)).catch(
      (err) => void (thrown = String(err instanceof Error ? err.message : err)),
    );
    expect(thrown).toContain('URL that includes credentials');
  });

  it.each(shapes)('push prints nothing carrying the credential: $what', async ({ url }) => {
    await pushCommand(parseArgs(['push', runId]), out, workspace, envFor(url)).catch(
      () => undefined,
    );
    expect(everythingPrinted()).not.toContain(SECRET);
  });

  it.each(shapes)('pull prints nothing carrying the credential: $what', async ({ url }) => {
    await pullCommand(parseArgs(['pull', 'run_def456']), out, workspace, envFor(url)).catch(
      () => undefined,
    );
    expect(everythingPrinted()).not.toContain(SECRET);
  });

  /*
  AND THROUGH main(), which is where a failure actually becomes output — the sink the fix is
  installed at, covering the plain rendering and the `--json` document a CI job keeps.
  */
  it.each(shapes)('main() renders the failure without it: $what', async ({ url }) => {
    const chunks: string[] = [];
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const saved = { ...process.env };
    Object.assign(process.env, envFor(url));
    process.stdout.write = ((s: string) => (
      chunks.push(String(s)),
      true
    )) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => (
      chunks.push(String(s)),
      true
    )) as typeof process.stderr.write;
    try {
      await main(['push', runId], workspace);
      await main(['push', runId, '--json'], workspace);
      await main(['push', runId, '--verbose'], workspace);
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect(chunks.join('')).toContain('push.failed');
    expect(chunks.join(''), 'the credential reached stdout/stderr').not.toContain(SECRET);
  });
  /*
  THE SUCCESS LINE IS NOT EXEMPT, and it is the only sink a failing-path test can never reach.
  A query-authenticated gateway is sent as configured (upstream-visible.test.ts asserts exactly
  that), so the push succeeds and `push.done` names the URL — in the terminal, in --json, and in
  the CI log of the README's own recipe, on every green run.
  */
  it('push.done names the gateway through recordableOrigin', async () => {
    const url = `${localUrl}/v1?key=${SECRET}`;
    await pushCommand(parseArgs(['push', runId]), out, workspace, {
      XDG_CONFIG_HOME: home,
      ORCA_GATEWAY_URL: url,
      ORCA_GATEWAY_KEY: 'sk-test-key',
    });
    const done = logs.find((e) => e.event === 'push.done');
    expect(done, 'the push did not reach its success line, so this asserts nothing').toBeDefined();
    expect(JSON.stringify(done)).not.toContain(SECRET);
    expect(everythingPrinted()).not.toContain(SECRET);
  });
});
