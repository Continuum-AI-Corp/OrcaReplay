import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecordContext } from '@orcareplay/plugin-api';
import { decodeForwardPath } from '@orcareplay/proxy';
import { checkAdapterContract, formatContractResult } from '../src/contract.js';
import { hasOrigin, mcodeAdapter, redirected } from '../src/mcode.js';
import { defaultAdapters } from '../src/registry.js';

/**
 * MiniMax Code is the first harness orca captures by moving the agent's *data directory* rather
 * than a base-URL variable or the transport. Its origin lives in a config file, and its HTTP
 * client is Node's `fetch`, which consults no proxy variable — so neither of the two routes that
 * came before it reaches this one.
 */
const LF = '\n';
const PROXY = 'http://127.0.0.1:44100';

describe('the mcode adapter', () => {
  let root: string;
  let ctx: RecordContext;

  const CONFIG = [
    'logLevel: info',
    'defaultModel: custom_provider:gw/minimax-m3',
    'custom_provider:',
    '  gw:',
    '    name: gw',
    '    kind: custom',
    '    options:',
    '      apiKey: sk-live-must-not-be-copied',
    '      baseURL: https://gateway.example/v1',
    '    models:',
    '      minimax-m3: {}',
    '  second:',
    '    options:',
    '      apiKey: sk-live-second-key',
    '      baseURL: https://other.example/v1',
    '',
  ].join('\n');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-mcode-'));
    await mkdir(join(root, 'work'), { recursive: true });
    await mkdir(join(root, 'run'), { recursive: true });
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(root, 'home', 'config.yaml'), CONFIG, 'utf8');
    ctx = {
      runId: 'run_test',
      cwd: join(root, 'work'),
      runDir: join(root, 'run'),
      proxyUrl: 'http://127.0.0.1:44100',
      userArgs: [],
      // Both spellings are read; the test drives the one MCode's own docs use.
      env: { MINIMAX_DATA_DIR: join(root, 'home') },
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes the adapter contract', async () => {
    const result = await checkAdapterContract(mcodeAdapter);
    expect(result.ok, formatContractResult(result)).toBe(true);
  });

  it('is registered under the names a user types', () => {
    const registry = defaultAdapters();
    for (const name of ['mcode', 'minimax-code', 'minimaxcode'])
      expect(registry.get(name).id).toBe('mcode');
  });

  it('points the agent at a data directory of its own', async () => {
    const launch = await mcodeAdapter.prepare(ctx);
    expect(launch.command).toBe('mcode');
    // Inside the run, not beside the operator's file. MCode writes to its own config on startup —
    // on a real run it put two lines back — so an adapter that edited `~/.minimax/config.yaml`
    // would be handing the agent its own file to fight over, and a killed run never restores it.
    expect(launch.env['MINIMAX_DATA_DIR']).toBe(join(ctx.runDir, 'mcode-data'));
    expect(launch.tempFiles).toEqual([join(ctx.runDir, 'mcode-data', 'config.yaml')]);
  });

  it('carries every provider through the proxy naming where it was headed', async () => {
    await mcodeAdapter.prepare(ctx);
    const written = await readFile(join(ctx.runDir, 'mcode-data', 'config.yaml'), 'utf8');
    const bases = [...written.matchAll(/baseURL:\s*(\S+)/g)].map((m) => m[1]!);

    // Every one, not the first. With several configured, rewriting one leaves the rest aimed at
    // their real origins and a run on any of those is simply missing from the trace.
    expect(bases).toHaveLength(2);
    const decoded = bases.map((base) => decodeForwardPath(new URL(base).pathname));
    expect(decoded.map((d) => d?.base)).toEqual([
      'https://gateway.example/v1',
      'https://other.example/v1',
    ]);
  });

  it('does not copy a credential into the run directory', async () => {
    await mcodeAdapter.prepare(ctx);
    const written = await readFile(join(ctx.runDir, 'mcode-data', 'config.yaml'), 'utf8');
    // §7. The file lands inside the trace directory, so the key does not travel with it — orca
    // supplies the real one for the origin it forwards to. Without that the gateway answers 401,
    // and the prompt is captured anyway, because it is in the request.
    expect(written).not.toContain('sk-live-must-not-be-copied');
    expect(written).not.toContain('sk-live-second-key');
    expect([...written.matchAll(/apiKey:\s*(\S+)/g)].map((m) => m[1])).toEqual([
      'orca-recorded',
      'orca-recorded',
    ]);
  });

  it('takes the key out however the config spells it', () => {
    // Caught in review. The first version anchored the value to the end of the line, so
    // `apiKey: sk-live-… # rotate me` matched nothing and the live key was written into the
    // generated config — while `baseURL` on another line still matched, so the file was written
    // anyway. That file lands in the run directory, and `capture.mjs` copies the whole run into
    // `capture/<model>/trace/` without scrubbing it, so the key would have left with the capture.
    // The same anchor missed `api_key:`.
    const spellings = [
      '      apiKey: sk-live-plain',
      '      apiKey: sk-live-commented # rotate me',
      '      api_key: sk-live-snake',
      '      api-key: sk-live-dash',
      '      apiKey: "sk-live-quoted"',
      "      apiKey: 'sk-live-single'   # note",
      '      APIKEY: sk-live-upper',
    ].join(LF);

    const out = redirected(
      `${spellings}${LF}      baseURL: https://gateway.example/v1${LF}`,
      PROXY,
    );
    expect(out).not.toContain('sk-live-');
    // Seven keys in, seven placeholders out — not six with one line quietly skipped.
    expect([...out.matchAll(/orca-recorded/g)]).toHaveLength(7);
    // Quoting and the comment are the operator's, and survive.
    expect(out).toContain('apiKey: "orca-recorded"');
    expect(out).toContain('# rotate me');
  });

  it('moves an origin however the config spells it', () => {
    const out = redirected(
      [
        '      baseURL: https://one.example/v1',
        '      baseURL: https://two.example/v1 # primary',
        '      base_url: https://three.example/v1',
        '      baseURL: "https://four.example/v1"',
        '',
      ].join(LF),
      PROXY,
    );
    const bases = [...out.matchAll(/base[_-]?url:\s*"?(\S+?)"?(?:\s|$)/gi)].map((m) => m[1]!);
    expect(bases.map((base) => decodeForwardPath(new URL(base).pathname)?.base)).toEqual([
      'https://one.example/v1',
      'https://two.example/v1',
      'https://three.example/v1',
      'https://four.example/v1',
    ]);
  });

  it('does not mistake a neighbouring field for a credential', () => {
    // The rewrite is narrow on purpose: it changes the two fields it knows and nothing else, so a
    // value that merely looks key-shaped is left as the operator wrote it.
    const out = redirected(`      notAKey: sk-not-a-credential-field${LF}`, PROXY);
    expect(out).toContain('notAKey: sk-not-a-credential-field');
  });

  it('launches untouched when the only origin line has no value', () => {
    // `hasOrigin` has to agree with the rewriter about what counts, or the adapter writes a config
    // that redirects nothing and reports the run as captured.
    expect(hasOrigin(`      baseURL:${LF}      apiKey: sk-live-x${LF}`)).toBe(false);
    expect(hasOrigin(`      baseURL: https://gateway.example/v1${LF}`)).toBe(true);
  });

  it('leaves everything it did not need to change alone', () => {
    const out = redirected(CONFIG, 'http://127.0.0.1:44100');
    const changed = CONFIG.split('\n').filter((line, i) => line !== out.split('\n')[i]);
    // Rewritten as text on purpose: a YAML round-trip would reformat comments, quoting and key
    // order in a file orca did not write.
    expect(changed).toHaveLength(4);
    expect(out).toContain('defaultModel: custom_provider:gw/minimax-m3');
    expect(out).toContain('      minimax-m3: {}');
  });

  it('launches untouched when there is no provider to redirect', async () => {
    // The built-in `minimax_oauth` login is not redirectable — MCode restores its own origin over
    // whatever the config says. A redirect aimed at a provider that is not there would be a
    // captured run talking to the wrong host; an untouched launch plus orca's empty-capture
    // warning is the truer answer.
    await writeFile(join(root, 'home', 'config.yaml'), 'logLevel: info\n', 'utf8');
    const launch = await mcodeAdapter.prepare(ctx);
    expect(launch.env).toEqual({});
    expect(launch.tempFiles).toBeUndefined();
  });

  it('launches untouched when there is no config at all', async () => {
    await rm(join(root, 'home', 'config.yaml'));
    const launch = await mcodeAdapter.prepare(ctx);
    expect(launch.env).toEqual({});
  });

  it('passes the user their own arguments', async () => {
    ctx.userArgs = ['exec', '--prompt-mode', 'coding', 'fix the auth test'];
    const launch = await mcodeAdapter.prepare(ctx);
    expect(launch.args).toEqual(['exec', '--prompt-mode', 'coding', 'fix the auth test']);
  });
});
