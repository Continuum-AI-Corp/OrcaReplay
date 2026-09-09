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
import { recordCommand } from '../src/commands/record.js';
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

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-cred-'));
    model = await startFakeModel();
    out = new Output({ write: () => {}, isTTY: false });
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
});
