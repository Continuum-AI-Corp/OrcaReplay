import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecordContext } from '@orcareplay/plugin-api';
import { decodeForwardPath } from '@orcareplay/proxy';
import { checkAdapterContract, formatContractResult } from '../src/contract.js';
import { hasOrigin, mcodeAdapter, redirected, rewriteIsTrustworthy } from '../src/mcode.js';
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
        'custom_provider:',
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
    const custom = (body: string) => `custom_provider:${LF}  gw:${LF}    options:${LF}${body}`;
    expect(hasOrigin(custom(`      baseURL:${LF}      apiKey: sk-live-x${LF}`))).toBe(false);
    expect(hasOrigin(custom(`      baseURL: https://gateway.example/v1${LF}`))).toBe(true);
    // A built-in provider's origin is not one this adapter can move, so it does not count.
    expect(
      hasOrigin(
        `provider:${LF}  minimax_api:${LF}    options:${LF}      baseURL: https://agent.minimaxi.com/v1${LF}`,
      ),
    ).toBe(false);
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

  it('writes no config when there is no provider to redirect', async () => {
    // The built-in `minimax_oauth` login is not redirectable — MCode restores its own origin over
    // whatever the config says. A redirect aimed at a provider that is not there would be a
    // captured run talking to the wrong host; an untouched launch plus orca's empty-capture
    // warning is the truer answer.
    await writeFile(join(root, 'home', 'config.yaml'), 'logLevel: info\n', 'utf8');
    const launch = await mcodeAdapter.prepare(ctx);
    // Isolated all the same: the data directory always moves, so a replay cannot fall back
    // onto the operator's own config and go live. See the test below.
    expect(launch.env['MINIMAX_DATA_DIR']).toBe(join(ctx.runDir, 'mcode-data'));
    expect(launch.tempFiles).toBeUndefined();
  });

  it('writes no config when every origin belongs to a built-in provider', async () => {
    // Caught in review. Asking only "is there a `baseURL` line" said yes to a stock install, where
    // the only ones are the built-in providers'. The adapter then wrote a redirected config for a
    // run that records nothing — MCode restores those origins over whatever the file says — and
    // left a 14 MB copy of its data directory inside the trace to show for it.
    await writeFile(
      join(root, 'home', 'config.yaml'),
      [
        'logLevel: info',
        'provider:',
        '  minimax_api:',
        '    options:',
        '      apiKey: sk-live-built-in',
        '      baseURL: https://agent.minimaxi.com/mavis/api/v1/llm/v1',
        '',
      ].join(LF),
      'utf8',
    );

    const launch = await mcodeAdapter.prepare(ctx);
    // Isolated all the same: the data directory always moves, so a replay cannot fall back
    // onto the operator's own config and go live. See the test below.
    expect(launch.env['MINIMAX_DATA_DIR']).toBe(join(ctx.runDir, 'mcode-data'));
    expect(launch.tempFiles).toBeUndefined();
  });

  it('moves a custom origin, leaves a built-in one, and takes the key out of both', async () => {
    // The mixed config, which is what a machine with a gateway configured actually looks like.
    // Origins split by section — the built-in one is MCode's to decide and it takes it back on
    // startup — but keys do not: this file lands in the run directory and `capture.mjs` copies
    // that directory into `capture/<model>/trace/` without scrubbing it.
    await writeFile(
      join(root, 'home', 'config.yaml'),
      [
        'custom_provider:',
        '  gw:',
        '    options:',
        '      apiKey: sk-live-custom',
        '      baseURL: https://gateway.example/v1',
        'provider:',
        '  minimax_api:',
        '    options:',
        '      apiKey: sk-live-built-in',
        '      baseURL: https://agent.minimaxi.com/mavis/api/v1/llm/v1',
        '',
      ].join(LF),
      'utf8',
    );

    await mcodeAdapter.prepare(ctx);
    const written = await readFile(join(ctx.runDir, 'mcode-data', 'config.yaml'), 'utf8');

    expect(written).not.toContain('sk-live-custom');
    expect(written).not.toContain('sk-live-built-in');
    expect([...written.matchAll(/apiKey:\s*(\S+)/g)].map((m) => m[1])).toEqual([
      'orca-recorded',
      'orca-recorded',
    ]);
    expect(written).toContain('baseURL: https://agent.minimaxi.com/mavis/api/v1/llm/v1');
    const moved = /baseURL: (http:\/\/127[^\s]*)/.exec(written)?.[1];
    expect(decodeForwardPath(new URL(moved!).pathname)?.base).toBe('https://gateway.example/v1');
  });

  it('refuses to write a config it cannot prove is clean', async () => {
    // Caught in review. The rewrite was anchored to the start of a line, so a key written in a
    // flow map or as a list item went through untouched — while `hasOrigin` still said yes,
    // because another provider had an ordinary `baseURL`. The file was written with those keys in
    // it, into the run directory `capture.mjs` copies into `capture/<model>/trace/` unscrubbed.
    //
    // Keys are taken out by shape-independent pattern now. These shapes are still refused, for the
    // other half of the same promise: their *origins* cannot be moved, so a run on one of those
    // providers would be talking to its real host with nothing in the trace to say so.
    const configs = {
      'flow map': [
        'custom_provider:',
        '  b:',
        '    options: {apiKey: sk-live-x, baseURL: https://b.example/v1}',
      ],
      'list item': [
        'custom_provider:',
        '  c:',
        '    options:',
        '      - apiKey: sk-live-x',
        '      - baseURL: https://c.example/v1',
      ],
      // The value lives on the next line, where no field pattern reaches it. Replacing the `>`
      // would leave the key in the file under a field that now reads as clean.
      // Found while mutation-testing the gate, not reported: `apiKey:` alone puts the value
      // below as an indented scalar, which matched no pattern at all — so it was neither
      // scrubbed nor noticed, and went into the run directory whole.
      'value on the next line': [
        'custom_provider:',
        '  e:',
        '    options:',
        '      apiKey:',
        '        sk-live-x',
        '      baseURL: https://e.example/v1',
      ],
      // Review, a later round: with no space before it the comment strip leaves the `#` in
      // place, so the line parsed as a field whose value was `#rotated`.
      'value is a comment with no space': [
        'custom_provider:',
        '  g:',
        '    options:',
        '      apiKey:#rotated',
        '        sk-live-x',
        '      baseURL: https://g.example/v1',
      ],
      // Review, this round: the `#` was captured as the value, so the same-line check
      // passed while the real key sat on the line below.
      'value is only a comment': [
        'custom_provider:',
        '  g:',
        '    options:',
        '      apiKey: # rotated',
        '        sk-live-x',
        '      baseURL: https://g.example/v1',
      ],
      'block scalar': [
        'custom_provider:',
        '  d:',
        '    options:',
        '      apiKey: >',
        '        sk-live-x',
        '      baseURL: https://d.example/v1',
      ],
      // The one that actually shipped: one provider orca can rewrite, one it cannot.
      'block and flow together': [
        'custom_provider:',
        '  a:',
        '    options:',
        '      apiKey: sk-live-a',
        '      baseURL: https://a.example/v1',
        '  b:',
        '    options: {apiKey: sk-live-x, baseURL: https://b.example/v1}',
      ],
    };

    for (const [shape, lines] of Object.entries(configs)) {
      await writeFile(join(root, 'home', 'config.yaml'), lines.join(LF) + LF, 'utf8');
      const launch = await mcodeAdapter.prepare(ctx);
      expect(launch.env['MINIMAX_DATA_DIR'], shape).toBe(join(ctx.runDir, 'mcode-data'));
      expect(launch.tempFiles, shape).toBeUndefined();
      await expect(
        readFile(join(ctx.runDir, 'mcode-data', 'config.yaml'), 'utf8'),
      ).rejects.toThrow();
    }
  });

  it('understands the one shape, quotes and comments and spellings included', () => {
    // What the allowlist accepts. Everything else is refused by the test above rather than
    // rewritten, so this is the whole of what the rewrite claims to handle.
    const out = redirected(
      [
        'custom_provider:',
        '  a:',
        '    options:',
        '      apiKey: sk-live-plain',
        '      apiKey: sk-live-commented # rotate me',
        '      api_key: sk-live-snake',
        '      api-key: sk-live-dash',
        '      APIKEY: sk-live-upper',
        '      apiKey: "sk-live-quoted"',
        "      apiKey: 'sk-live-single'   # note",
        // A quoted *name*, which review found neither the scrub nor the gate could see.
        '      "apiKey": sk-live-quoted-name',
        "      'api_key': sk-live-quoted-snake",
        '      # your apiKey goes above',
        '      baseURL: https://gateway.example/v1',
        '      "baseURL": https://quoted.example/v1',
        '',
      ].join(LF),
      PROXY,
    );

    expect(out).not.toContain('sk-live-');
    // Nine keys in, nine placeholders out — not eight with one line quietly skipped.
    expect([...out.matchAll(/orca-recorded/g)]).toHaveLength(9);
    // Quoting, spacing and comments are the operator's and survive.
    expect(out).toContain('apiKey: "orca-recorded"');
    expect(out).toContain("apiKey: 'orca-recorded'   # note");
    expect(out).toContain('"apiKey": orca-recorded');
    expect(out).toContain('# rotate me');
    // A comment that merely mentions the field is left alone rather than refused.
    expect(out).toContain('# your apiKey goes above');
    // Both origins move, including the one whose name is quoted.
    const moved = [...out.matchAll(/"?baseURL"?: (\S+)/g)].map((m) => m[1]!);
    expect(moved.map((base) => decodeForwardPath(new URL(base).pathname)?.base)).toEqual([
      'https://gateway.example/v1',
      'https://quoted.example/v1',
    ]);
  });

  it('does not mistake a field value that mentions a key for a key field', () => {
    // Caught by running the adapter against a real config after tightening the gate. Every
    // custom provider in one carries `authMode: api-key`, where `api-key` is the *value*. A scan
    // that looked anywhere on the line read it as a field it could not parse and refused the
    // whole config: a recording that should have captured six exchanges captured none. The colon
    // after the name is what tells a name from a value.
    const config = [
      'custom_provider:',
      '  gw:',
      '    options:',
      '      apiKey: sk-live-x',
      '      baseURL: https://gateway.example/v1',
      '      authMode: api-key',
      '',
    ].join(LF);

    expect(rewriteIsTrustworthy(config, PROXY)).toBe(true);
    const out = redirected(config, PROXY);
    expect(out).not.toContain('sk-live-x');
    expect(out).toContain('authMode: api-key');
  });

  it('does not refuse over a built-in origin it does not need to understand', async () => {
    // The scoping is deliberate. A built-in provider's origin is never rewritten — MCode takes
    // it back on startup — so its shape is none of this adapter's business, and refusing over it
    // would make an ordinary config uncaptured for no gain. Keys are the opposite: those are
    // refused wherever they are unreadable, because an unreadable key is one left on disk.
    await writeFile(
      join(root, 'home', 'config.yaml'),
      [
        'custom_provider:',
        '  gw:',
        '    options:',
        '      apiKey: sk-live-custom',
        '      baseURL: https://gateway.example/v1',
        'provider:',
        '  minimax_api:',
        '    options: {baseURL: https://agent.minimaxi.com/v1}',
        '',
      ].join(LF),
      'utf8',
    );

    await mcodeAdapter.prepare(ctx);
    const written = await readFile(join(ctx.runDir, 'mcode-data', 'config.yaml'), 'utf8');
    expect(written).not.toContain('sk-live-custom');
    expect(written).toContain('{baseURL: https://agent.minimaxi.com/v1}');
  });

  it('isolates the data directory even when it has nothing to write there', async () => {
    // Caught in review. `orca replay` calls this same `prepare`, with the operator's *current*
    // environment rather than the recorded one, so a config that has lost its custom provider
    // since the recording used to launch MCode untouched — on the real `~/.minimax`, against the
    // real gateway, with the real credential. Nothing reached the proxy, `unmatched` stayed at
    // zero, and the replay reported success: money spent, nothing recorded, quietly.
    //
    // An empty directory of orca's own is what stops it. Measured: MCode finds no provider and no
    // credential there and refuses to start — "Sign in to MiniMax to use Agent features" — without
    // making a call.
    for (const body of [
      // Nothing to redirect.
      'logLevel: info',
      // Something to redirect, written a way the rewrite will not touch.
      [
        'custom_provider:',
        '  b:',
        '    options: {apiKey: sk-live-x, baseURL: https://b.example/v1}',
      ].join(LF),
    ]) {
      await writeFile(join(root, 'home', 'config.yaml'), `${body}${LF}`, 'utf8');
      const launch = await mcodeAdapter.prepare(ctx);
      expect(launch.env['MINIMAX_DATA_DIR']).toBe(join(ctx.runDir, 'mcode-data'));
      // No config, so MCode starts with nothing rather than with the operator's own providers.
      expect(launch.tempFiles).toBeUndefined();
      await expect(
        readFile(join(ctx.runDir, 'mcode-data', 'config.yaml'), 'utf8'),
      ).rejects.toThrow();
    }
  });

  it('refuses an origin `/forward/` cannot carry, rather than aiming the run elsewhere', () => {
    // `forwardOrProxyBase` answers an origin the decoder will not take with orca's own default
    // upstream. For the env route that is a reasonable last resort; here it would send the run to
    // a host the operator never named, which this file's own comment calls worse than not
    // capturing. Userinfo, a query and a non-HTTP scheme are the three the decoder refuses.
    for (const origin of [
      'https://user:pw@gw.example/v1',
      'https://gw.example/v1?key=SECRET123',
      'ftp://gw.example/v1',
    ]) {
      const config = [
        'custom_provider:',
        '  gw:',
        '    options:',
        '      apiKey: sk-live-x',
        `      baseURL: ${origin}`,
        '',
      ].join(LF);
      expect(rewriteIsTrustworthy(config, PROXY), origin).toBe(false);
    }
  });

  it('rewrites a config with CRLF line endings', () => {
    // The carriage return belongs to the line ending, not to the value. Losing that made every
    // field on a Windows-written config unparseable, so the whole thing was refused and the run
    // captured nothing — a silent regression, because a stricter gate does not throw.
    const config = [
      'custom_provider:',
      '  gw:',
      '    options:',
      '      apiKey: sk-live-x',
      '      baseURL: https://gateway.example/v1',
      '',
    ].join('\r\n');

    expect(rewriteIsTrustworthy(config, PROXY)).toBe(true);
    const out = redirected(config, PROXY);
    expect(out).not.toContain('sk-live-x');
    expect(out).toContain('\r\n');
    const moved = /baseURL: (\S+?)\r/.exec(out)?.[1];
    expect(decodeForwardPath(new URL(moved!).pathname)?.base).toBe('https://gateway.example/v1');
  });

  it('empties the vendor environment so no other spelling can point elsewhere', async () => {
    // Caught in review. `configPath` reads either spelling of the data directory, but the launch
    // overrode only one — so an operator who had set `MAVIS_DATA_DIR` kept their real data
    // directory, with the real config, origin and credential, and the isolation bought nothing.
    //
    // Naming the spellings one at a time is how that happened, so this does not: MCode reads about
    // ninety `MAVIS_*` and `MINIMAX_*` variables, including three more data directories and four
    // credentials, and every one of them arrives empty.
    ctx.env = {
      PATH: 'kept',
      MAVIS_DATA_DIR: '/real/data',
      MAVIS_RUNTIME_DATA_DIR: '/real/runtime',
      MAVIS_ACCESS_TOKEN: 'tok',
      MINIMAX_API_KEY: 'sk-real',
      UNRELATED: 'kept',
    };

    const launch = await mcodeAdapter.prepare(ctx);
    const isolated = join(ctx.runDir, 'mcode-data');
    expect(launch.env['MINIMAX_DATA_DIR']).toBe(isolated);
    expect(launch.env['MAVIS_DATA_DIR']).toBe(isolated);
    expect(launch.env['MAVIS_RUNTIME_DATA_DIR']).toBe('');
    expect(launch.env['MAVIS_ACCESS_TOKEN']).toBe('');
    expect(launch.env['MINIMAX_API_KEY']).toBe('');
    // Only the vendor's namespace. The rest of the operator's environment is theirs.
    expect(launch.env['UNRELATED']).toBeUndefined();
    expect(launch.env['PATH']).toBeUndefined();
  });

  it('refuses a credential stored under a name it does not rewrite', () => {
    // The allowlist proves the two fields it understands. A provider that keeps its credential
    // under any other name would pass every check and be copied out verbatim, into the run
    // directory `capture.mjs` ships unscrubbed.
    //
    // Two nets, because one has a measured hole: orca's redactor catches an `sk-` token, a real
    // JWT, a long random string and an AWS key id, but not 32 hex characters — that string's
    // maximum Shannon entropy is exactly its threshold. So an opaque token of 24 characters or
    // more under a name this file does not rewrite is refused on shape instead.
    const withField = (line: string) =>
      [
        'custom_provider:',
        '  gw:',
        '    options:',
        '      apiKey: sk-live-x',
        '      baseURL: https://gateway.example/v1',
        line,
        '',
      ].join(LF);

    // Every section, not just the custom one — scoping this to `custom_provider:` contradicted
    // the rule a few lines up that keys come out of all of them, and review found the gap:
    // `provider:` carrying `authSecret: <32 hex>` passed everything, because the redactor
    // cannot see 32 hex characters either.
    for (const built of [
      [
        'provider:',
        '  minimax_api:',
        '    options:',
        '      authSecret: b8e793df1a6e4b1088eeaa608388afc9',
      ],
      ['rootToken: b8e793df1a6e4b1088eeaa608388afc9'],
    ]) {
      const config = [
        'custom_provider:',
        '  gw:',
        '    options:',
        '      apiKey: sk-live-x',
        '      baseURL: https://gateway.example/v1',
        ...built,
        '',
      ].join(LF);
      expect(rewriteIsTrustworthy(config, PROXY), built[0]).toBe(false);
    }

    for (const line of [
      '      token: sk-live-AbCdEf0123456789XyZ',
      '      secret: b8e793df1a6e4b1088eeaa608388afc9',
      '      apiToken: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c',
    ]) {
      expect(rewriteIsTrustworthy(withField(line), PROXY), line).toBe(false);
    }

    // And an ordinary provider block is not refused over the fields it really carries.
    for (const line of [
      '      authMode: api-key',
      '      enabled: true',
      '      name: gw',
      '      api: openai-completions',
    ]) {
      expect(rewriteIsTrustworthy(withField(line), PROXY), line).toBe(true);
    }
  });

  it('writes no config when there is none to read', async () => {
    await rm(join(root, 'home', 'config.yaml'));
    const launch = await mcodeAdapter.prepare(ctx);
    expect(launch.env['MINIMAX_DATA_DIR']).toBe(join(ctx.runDir, 'mcode-data'));
  });

  it('passes the user their own arguments', async () => {
    ctx.userArgs = ['exec', '--prompt-mode', 'coding', 'fix the auth test'];
    const launch = await mcodeAdapter.prepare(ctx);
    expect(launch.args).toEqual(['exec', '--prompt-mode', 'coding', 'fix the auth test']);
  });
});
