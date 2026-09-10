import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceReader, listRuns } from '@orcareplay/core';
import { parseArgs } from '../src/args.js';
import { Output } from '../src/out.js';
import { recordCommand } from '../src/commands/record.js';
import { replayCommand } from '../src/commands/replay.js';
import { startFakeModel } from './fixtures/fake-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, 'fixtures', 'fake-agent.mjs');

/**
 * No event attribute may carry a URL with a credential in it.
 *
 * This test exists because of how the bug it guards was found: in review, not in testing. A field
 * naming the origin that answered each call was added, verified four ways — the value is right on
 * every route, it follows the request rather than the configuration, both human surfaces show it —
 * and every one of those checks asked *is this value correct*. None asked *what else could be in
 * it*. The configured gateway comes from `orca setup --gateway`, which accepts any URL, so
 * `https://user:pw@gw.example` and `https://gw.example?key=…` went into the trace verbatim.
 *
 * The redactor did not catch it, and reasonably so: it works on payloads derived from the incoming
 * request, and this value came from configuration. The terminal guard did not catch it either — it
 * matches known key *shapes* (`sk-`, `ghp_`, `AKIA…`) and field *names* (`key`, `token`, `secret`),
 * and an arbitrary password inside a URL under a field called `upstream` is neither.
 *
 * So this is deliberately not a test of that field. It walks every attribute of every event and
 * fails on the *shape* — a URL carrying userinfo or a query — whatever the field is called and
 * whenever it was added. The next field sourced from configuration rather than from the wire is
 * the one it is really for.
 *
 * `CONTRIBUTING.md` states the rule; this is the part that cannot be forgotten.
 */
describe('a trace carries no credential-bearing URL, in any attribute', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startFakeModel>>;
  let out: Output;
  let lines: string[];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-cred-'));
    model = await startFakeModel();
    lines = [];
    out = new Output({ write: (l) => void lines.push(l), isTTY: false });
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

  /** Every scalar reachable from an event's attrs, with the path that led to it. */
  function scalars(value: unknown, at = 'attrs'): Array<{ at: string; value: string }> {
    if (typeof value === 'string') return [{ at, value }];
    if (value === null || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap((v, i) => scalars(v, `${at}[${i}]`));
    return Object.entries(value).flatMap(([k, v]) => scalars(v, `${at}.${k}`));
  }

  /** A URL with userinfo or a query — the two places a key rides in a configured origin. */
  function looksLikeCredentialUrl(value: string): boolean {
    if (!/^https?:\/\//.test(value)) return false;
    try {
      const url = new URL(value);
      return url.username !== '' || url.password !== '' || url.search !== '';
    } catch {
      return false;
    }
  }

  it('when the gateway URL carries its key in userinfo', async () => {
    const secret = 'PASSWORD-IN-USERINFO';
    // The fake model is a plain origin; the credential is injected the way `orca setup` would have
    // left it, which is the route that produced the bug.
    const gateway = model.url.replace('http://', `http://someone:${secret}@`);
    const args = parseArgs([
      'record',
      'generic-openai',
      '--upstream-anthropic',
      gateway,
      '--',
      'node',
      FAKE_AGENT,
    ]);
    const result = await recordCommand(args, out, workspace);

    const reader = await TraceReader.open(result.runDir);
    const events = await reader.events();
    expect(events.length).toBeGreaterThan(0);

    const offenders = events.flatMap((e) =>
      scalars(e.attrs).filter((s) => looksLikeCredentialUrl(s.value)),
    );
    expect(
      offenders.map((o) => o.at),
      `these attributes carry a credential-bearing URL: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
    // And the specific secret, in case a future shape slips past the structural check above.
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('when it carries it in the query', async () => {
    const secret = 'TOKEN-IN-QUERY';
    const gateway = `${model.url}?key=${secret}`;
    const args = parseArgs([
      'record',
      'generic-openai',
      '--upstream-anthropic',
      gateway,
      '--',
      'node',
      FAKE_AGENT,
    ]);
    const result = await recordCommand(args, out, workspace);

    const reader = await TraceReader.open(result.runDir);
    const events = await reader.events();
    const offenders = events.flatMap((e) =>
      scalars(e.attrs).filter((s) => looksLikeCredentialUrl(s.value)),
    );
    expect(
      offenders.map((o) => o.at),
      `these attributes carry a credential-bearing URL: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  /**
   * The fork path — the blind spot in the two cases above, and where this class of leak came back.
   *
   * A record run never substitutes a model, so `forkModel` stays undefined and `route.decision` is
   * never emitted. The two cases above were written against exactly this bug and could not see it
   * for that reason alone. On a fork orca *is* the gateway, and the decision it emits names the
   * origin it chose — the resolved upstream, verbatim. `buildExchange` puts that same value through
   * `recordableOrigin` before it reaches a trace; the `onRoute` payload did not, and replay writes
   * `attrs: { ...decision }` unchanged.
   *
   * Both shapes are forked, because they fail differently and only one of them is loud: undici
   * rejects userinfo at request time, so that fork errors out — after the decision is appended —
   * while a `?key=` gateway is an ordinary working configuration whose fork succeeds with the key
   * written into the trace. Every run in the workspace is scanned rather than the returned fork id,
   * because a fork that throws never returns one.
   */
  const forkGateways = [
    {
      what: 'userinfo',
      secret: 'PASSWORD-ON-A-FORK',
      of: (url: string, secret: string) => url.replace('http://', `http://someone:${secret}@`),
    },
    {
      what: 'a query',
      secret: 'TOKEN-ON-A-FORK',
      of: (url: string, secret: string) => `${url}?key=${secret}`,
    },
  ];

  it.each(forkGateways)(
    'when a fork routes through a gateway carrying its key in $what',
    async ({ secret, of }) => {
      const gateway = of(model.url, secret);
      // Recorded through a clean origin, so anything found below can only have come from the fork.
      await recordCommand(
        parseArgs([
          'record',
          'generic-openai',
          '--upstream-anthropic',
          model.url,
          '--',
          'node',
          FAKE_AGENT,
        ]),
        out,
        workspace,
      );
      await replayCommand(
        parseArgs([
          'replay',
          'last',
          '--from',
          '1',
          '--model',
          'gpt-5.2',
          '--upstream-anthropic',
          gateway,
          '--upstream-openai',
          gateway,
        ]),
        out,
        workspace,
      ).catch(() => undefined);

      const offenders: Array<{ at: string; value: string }> = [];
      let routes = 0;
      let scanned = 0;
      for (const { runId, dir } of await listRuns(workspace)) {
        const events = await (await TraceReader.open(dir)).events();
        scanned += events.length;
        for (const event of events) {
          if (event.type === 'route.decision') routes += 1;
          offenders.push(
            ...scalars(event.attrs, `${runId} ${event.type}.attrs`).filter((s) =>
              looksLikeCredentialUrl(s.value),
            ),
          );
        }
      }

      // The field is stripped, not deleted: a fork's trace still has to say where the call went,
      // and "sanitised it away" would pass the check above just as well as sanitising it.
      const origins = [];
      for (const { dir } of await listRuns(workspace)) {
        for (const event of await (await TraceReader.open(dir)).events()) {
          if (event.type === 'route.decision')
            origins.push((event.attrs as { origin?: unknown }).origin);
        }
      }
      expect(origins.length).toBeGreaterThan(0);
      for (const origin of origins) {
        expect(String(origin), 'the route still has to name where it went').toContain('127.0.0.1');
      }

      expect(scanned, 'no events to scan').toBeGreaterThan(0);
      // Without this the case can pass by never having forked at all.
      expect(
        routes,
        `the fork emitted no route.decision, so this proves nothing: ${JSON.stringify(lines)}`,
      ).toBeGreaterThan(0);
      expect(
        offenders.map((o) => o.at),
        `these attributes carry a credential-bearing URL: ${JSON.stringify(offenders)}`,
      ).toEqual([]);
      expect(
        JSON.stringify(
          await Promise.all(
            (await listRuns(workspace)).map(async (r) => (await TraceReader.open(r.dir)).events()),
          ),
        ),
        'the secret itself reached a trace',
      ).not.toContain(secret);
    },
  );
});
