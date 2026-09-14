import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, MCP_RECORD_START, objectsOnLine, parseArgs } from '../src/index.js';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-shim-cli-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The splitter both readers of a capture share, tested where it lives.
 *
 * Several servers append to one file and each record is one write, so a short write leaves part of
 * a record with no newline behind it and the next server's bytes land on the end. Skipping such a
 * line threw away whatever on it was complete.
 */
describe('objectsOnLine', () => {
  const record = { ts: '2026-09-12T00:00:00.000Z', name: 'fs', raw: '{"a":1}' };
  const whole = JSON.stringify(record);

  it('returns the one record an ordinary line holds', () => {
    expect(objectsOnLine(whole, MCP_RECORD_START)).toEqual([record]);
  });

  it('returns a record whose fields are in some other order, having never looked for one', () => {
    // The ordinary line parses, so the anchor is not consulted. A record written by something that
    // ordered its fields differently, or that has no `ts` at all, is still a record on a line.
    const odd = '{"name":"fs","raw":"{}"}';
    expect(objectsOnLine(odd, MCP_RECORD_START)).toEqual([{ name: 'fs', raw: '{}' }]);
  });

  it('finds a record whose newline was lost, ahead of a stub too short to be an opening', () => {
    expect(objectsOnLine(`${whole}{"t`, MCP_RECORD_START)).toEqual([record]);
  });

  it('finds a record that landed after a fragment', () => {
    expect(
      objectsOnLine(`{"ts":"2026-09-12T00:00:00.000Z","name":"fs"${whole}`, MCP_RECORD_START),
    ).toEqual([record]);
  });

  /**
   * The reason the search is anchored rather than started at any `{`.
   *
   * A fragment that stops inside a string leaves an odd number of quotes behind it, and a brace
   * walk begun anywhere after that reads every quote on the wrong side: braces in the *complete*
   * record that follows are then counted as text, the walk returns a boundary past it, and the
   * record is skipped without ever being looked at. `{"ts":` cannot occur inside a JSON string —
   * the quotes in one are escaped — so a search anchored on it always starts outside.
   */
  it('finds a record behind a fragment that stopped inside a string', () => {
    expect(objectsOnLine(`{"ts":"2026-09-12${whole}`, MCP_RECORD_START)).toEqual([record]);
  });

  it('does not end a record at a brace inside the payload it carries', () => {
    // `raw` is the line a server said, kept as a string. A tool call whose argument is a lone `}`
    // puts an unmatched brace in it; read structurally, that ends the record early and the piece
    // that comes out does not parse — so the call would be missing from a trace that recorded it.
    const braced = { ts: 't', name: 'fs', raw: '{"q":"}"}' };
    expect(objectsOnLine(`${JSON.stringify(braced)}{"t`, MCP_RECORD_START)).toEqual([braced]);
  });

  it('does not take a balanced run of bytes that is not a record', () => {
    // Braces that close, and nothing `JSON.parse` accepts. The walk is a guess; the parse decides.
    expect(objectsOnLine('{"ts":"a"}}{', MCP_RECORD_START)).toEqual([{ ts: 'a' }]);
    expect(objectsOnLine('{"ts":,}{"x', MCP_RECORD_START)).toEqual([]);
  });

  it('has nothing to return for a fragment on its own', () => {
    expect(objectsOnLine('{"ts":"2026-09-12T00:00:00.000Z","name":"fs"', MCP_RECORD_START)).toEqual(
      [],
    );
  });
});

describe('parseArgs', () => {
  it('splits shim options from the server command line', () => {
    const parsed = parseArgs(['--name', 'fs', '--out', '/tmp/mcp.jsonl', '--', 'npx', '-y', 'srv']);
    expect(parsed).toEqual({
      name: 'fs',
      out: '/tmp/mcp.jsonl',
      command: 'npx',
      args: ['-y', 'srv'],
    });
  });

  it('makes --out optional', () => {
    expect(parseArgs(['--name', 'fs', '--', 'srv']).out).toBeUndefined();
  });

  it('leaves the server argv alone, flags and all', () => {
    const parsed = parseArgs(['--name', 'fs', '--', 'srv', '--name', 'inner', '--out', 'x']);
    expect(parsed.args).toEqual(['--name', 'inner', '--out', 'x']);
  });

  it('says what is missing when --name is absent', () => {
    expect(() => parseArgs(['--', 'srv'])).toThrow(/--name/);
  });

  it('says what is missing when the -- separator is absent', () => {
    expect(() => parseArgs(['--name', 'fs', 'srv'])).toThrow(/--/);
  });

  it('says what is missing when no command follows --', () => {
    expect(() => parseArgs(['--name', 'fs', '--'])).toThrow(/command/i);
  });

  it('names an unknown flag and shows the usage', () => {
    expect(() => parseArgs(['--nmae', 'fs', '--', 'srv'])).toThrow(/--nmae/);
  });

  it('rejects --name with no value', () => {
    expect(() => parseArgs(['--name'])).toThrow(/--name/);
  });
});

describe('main', () => {
  // Exits when stdin ends, without process.exit: an explicit exit can drop queued pipe writes.
  const server =
    'process.stdin.on("data", () => {});' +
    'process.stdout.write("{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"result\\":{\\"ok\\":true}}\\n");';

  it('records observed frames as JSON lines and forwards the exit code', async () => {
    const out = join(scratch, 'mcp.jsonl');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const seen: Buffer[] = [];
    stdout.on('data', (c: Buffer) => seen.push(Buffer.from(c)));

    const done = main(['--name', 'fs', '--out', out, '--', process.execPath, '-e', server], {
      stdin,
      stdout,
      stderr,
    });
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    stdin.end();
    expect(await done).toBe(0);
    // The reader's recovery is anchored on this, so the writer has to keep producing it.
    const firstLine = readFileSync(out, 'utf8').split('\n')[0]!;
    expect(
      firstLine.startsWith(MCP_RECORD_START),
      `a record now starts \`${firstLine.slice(0, 12)}\``,
    ).toBe(true);

    const lines = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      name: 'fs',
      dir: 'in',
      kind: 'request',
      method: 'tools/list',
      id: 1,
    });
    expect(lines[1]).toMatchObject({ name: 'fs', dir: 'out', kind: 'response', id: 1 });
    expect(typeof lines[0].ts).toBe('string');
    expect(lines[0].raw).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(Buffer.concat(seen).toString('utf8')).toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n',
    );
  });

  it('appends to an existing capture file rather than truncating it', async () => {
    const out = join(scratch, 'mcp.jsonl');
    for (const round of [1, 2]) {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const done = main(
        ['--name', `s${round}`, '--out', out, '--', process.execPath, '-e', server],
        {
          stdin,
          stdout,
          stderr,
        },
      );
      stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      stdin.end();
      await done;
    }
    const names = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).name);
    expect(names).toEqual(['s1', 's1', 's2', 's2']);
  });

  it('warns but keeps serving when the capture file cannot be opened', async () => {
    const out = join(scratch, 'no-such-dir', 'mcp.jsonl');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const warnings: Buffer[] = [];
    stderr.on('data', (c: Buffer) => warnings.push(Buffer.from(c)));

    const done = main(['--name', 'fs', '--out', out, '--', process.execPath, '-e', server], {
      stdin,
      stdout,
      stderr,
    });
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    stdin.end();
    expect(await done).toBe(0);
    expect(Buffer.concat(warnings).toString('utf8')).toMatch(/mcp\.jsonl/);
  });

  it('runs without --out, capturing nothing', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const done = main(['--name', 'fs', '--', process.execPath, '-e', 'process.exit(3)'], {
      stdin,
      stdout,
      stderr,
    });
    expect(await done).toBe(3);
  });

  it('answers from a recording that has a line which is not a frame', async () => {
    // There was no `--replay` test at all, which is how this reader escaped the rule the other
    // readers of this same file got. Several shims share one capture, so an interleaved write can
    // leave a line that parses to `null` — and this reader cast straight through and read
    // `record.name`, so the shim died with `Cannot read properties of null (reading 'name')`
    // *before serving a single recorded answer*. A torn line at record time then made the whole
    // recording unreplayable, which is the asymmetry worth closing.
    const recorded = join(scratch, 'recorded.jsonl');
    const base = { ts: '2026-09-12T00:00:00.000Z', name: 'fs', id: 1, method: 'tools/list' };
    const request = {
      ...base,
      dir: 'in',
      kind: 'request',
      raw: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    };
    const response = {
      ...base,
      dir: 'out',
      kind: 'response',
      raw: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    };
    // The three bad lines are interleaved with the good pair, not merely appended, because a reader
    // that stopped at the first one would otherwise still look correct.
    writeFileSync(
      recorded,
      ['null', JSON.stringify(request), '7', JSON.stringify(response), '[1,2]', ''].join('\n'),
      'utf8',
    );

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const seen: Buffer[] = [];
    const errors: Buffer[] = [];
    stdout.on('data', (c: Buffer) => seen.push(Buffer.from(c)));
    stderr.on('data', (c: Buffer) => errors.push(Buffer.from(c)));

    const done = main(
      ['--name', 'fs', '--out', join(scratch, 'mcp.jsonl'), '--replay', recorded, '--', 'unused'],
      { stdin, stdout, stderr },
    );
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    stdin.end();

    expect(await done, Buffer.concat(errors).toString()).toBe(0);
    expect(Buffer.concat(seen).toString(), 'the recorded answer must still be served').toContain(
      '"ok":true',
    );
  });

  /**
   * The same tear one level in: a record whose `raw` is not an object.
   *
   * The case above is a capture *line* that is not a frame record, and `isMcpFrameRecord` turns
   * those away. This is a line that is a perfectly good record — `name` a string, `raw` a string —
   * carrying a payload that is not a message. The recorder writes them: `toFrame` keeps any line
   * that parses to a non-object as `{ raw, kind: 'unknown' }`, so a bare `null` from a server
   * becomes `raw: "null"`, and `toRecord` puts it in the capture verbatim.
   *
   * `JSON.parse` does not throw on it, so it went past the guard that exists for torn lines and was
   * cast to `JsonRpcMessage`. `indexFrames` then read `message.id` off `null` — and `runMock` calls
   * `indexFrames` before it serves anything, so one such line anywhere in the recording killed the
   * whole replay at startup, every MCP server in the run with it. Recording tolerated it and replay
   * did not, which is the asymmetry this reader was fixed for.
   */
  /**
   * The same short write, in the file several servers share.
   *
   * Each record is one write on the sink, so a torn one leaves a prefix and the next server's whole
   * record lands on the end of it. Skipping that line threw away the complete record too — and here
   * that record is the *request*, which is what ties a recorded answer to the question asked, so
   * losing it leaves the replay with nothing to say.
   */
  /**
   * And the other way round here too: the record that matters is complete, and what follows it is
   * too short to be recognised as a boundary by anything but the end of the record itself.
   */
  it('answers from a recording whose request lost only its newline', async () => {
    const recorded = join(scratch, 'recorded.jsonl');
    const base = { ts: '2026-09-12T00:00:00.000Z', name: 'fs', id: 1, method: 'tools/list' };
    const request = JSON.stringify({
      ...base,
      dir: 'in',
      kind: 'request',
      raw: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    const response = JSON.stringify({
      ...base,
      dir: 'out',
      kind: 'response',
      raw: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    });
    // Three bytes of the next record, which is fewer than its opening is long.
    writeFileSync(recorded, [`${request}{"t`, response, ''].join('\n'), 'utf8');

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const seen: Buffer[] = [];
    const errors: Buffer[] = [];
    stdout.on('data', (c: Buffer) => seen.push(Buffer.from(c)));
    stderr.on('data', (c: Buffer) => errors.push(Buffer.from(c)));

    const done = main(
      ['--name', 'fs', '--out', join(scratch, 'mcp.jsonl'), '--replay', recorded, '--', 'unused'],
      { stdin, stdout, stderr },
    );
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    stdin.end();

    expect(await done, Buffer.concat(errors).toString()).toBe(0);
    expect(
      Buffer.concat(seen).toString(),
      'a complete request was lost to the bytes written after it, so the replay had no answer',
    ).toContain('"ok":true');
  });

  it('answers from a recording whose first record was glued onto a fragment', async () => {
    const recorded = join(scratch, 'recorded.jsonl');
    const base = { ts: '2026-09-12T00:00:00.000Z', name: 'fs', id: 1, method: 'tools/list' };
    const fragment = '{"ts":"2026-09-12T00:00:00.000Z","name":"fs","dir":"out","kind":"unknown"';
    const request = JSON.stringify({
      ...base,
      dir: 'in',
      kind: 'request',
      raw: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    const response = JSON.stringify({
      ...base,
      dir: 'out',
      kind: 'response',
      raw: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    });
    writeFileSync(recorded, [`${fragment}${request}`, response, ''].join('\n'), 'utf8');

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const seen: Buffer[] = [];
    const errors: Buffer[] = [];
    stdout.on('data', (c: Buffer) => seen.push(Buffer.from(c)));
    stderr.on('data', (c: Buffer) => errors.push(Buffer.from(c)));

    const done = main(
      ['--name', 'fs', '--out', join(scratch, 'mcp.jsonl'), '--replay', recorded, '--', 'unused'],
      { stdin, stdout, stderr },
    );
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    stdin.end();

    expect(await done, Buffer.concat(errors).toString()).toBe(0);
    expect(
      Buffer.concat(seen).toString(),
      'the record glued to a fragment was dropped with it, so the replay had no answer',
    ).toContain('"ok":true');
  });

  it('answers from a recording whose frames include one that is not a message', async () => {
    const recorded = join(scratch, 'recorded.jsonl');
    const base = { ts: '2026-09-12T00:00:00.000Z', name: 'fs' };
    const record = (over: Record<string, unknown>) => JSON.stringify({ ...base, ...over });
    // Each of the three is what a different non-object line looks like once recorded, and they are
    // interleaved so that stopping at the first still fails.
    writeFileSync(
      recorded,
      [
        record({ dir: 'out', kind: 'unknown', raw: 'null' }),
        record({
          dir: 'in',
          kind: 'request',
          id: 1,
          method: 'tools/list',
          raw: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        }),
        record({ dir: 'out', kind: 'unknown', raw: '"a log line"' }),
        record({
          dir: 'out',
          kind: 'response',
          id: 1,
          raw: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
        }),
        record({ dir: 'in', kind: 'unknown', raw: '[1,2]' }),
        '',
      ].join('\n'),
      'utf8',
    );

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const seen: Buffer[] = [];
    const errors: Buffer[] = [];
    stdout.on('data', (c: Buffer) => seen.push(Buffer.from(c)));
    stderr.on('data', (c: Buffer) => errors.push(Buffer.from(c)));

    const done = main(
      ['--name', 'fs', '--out', join(scratch, 'mcp.jsonl'), '--replay', recorded, '--', 'unused'],
      { stdin, stdout, stderr },
    );
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    stdin.end();

    expect(await done, Buffer.concat(errors).toString()).toBe(0);
    expect(Buffer.concat(seen).toString(), 'the recorded answer must still be served').toContain(
      '"ok":true',
    );
  });

  /**
   * And the same line arriving from the client rather than out of the recording. `runMock` parsed
   * it, cast it, and read `message.id` — inside a `'line'` handler, where a throw takes the process
   * down rather than costing one frame.
   */
  it('ignores a client line that is not a message, and keeps answering', async () => {
    const recorded = join(scratch, 'recorded.jsonl');
    const base = { ts: '2026-09-12T00:00:00.000Z', name: 'fs', id: 1, method: 'tools/list' };
    writeFileSync(
      recorded,
      [
        JSON.stringify({
          ...base,
          dir: 'in',
          kind: 'request',
          raw: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        }),
        JSON.stringify({
          ...base,
          dir: 'out',
          kind: 'response',
          raw: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const seen: Buffer[] = [];
    const errors: Buffer[] = [];
    stdout.on('data', (c: Buffer) => seen.push(Buffer.from(c)));
    stderr.on('data', (c: Buffer) => errors.push(Buffer.from(c)));

    const done = main(
      ['--name', 'fs', '--out', join(scratch, 'mcp.jsonl'), '--replay', recorded, '--', 'unused'],
      { stdin, stdout, stderr },
    );
    // Before the real question, so a crash here costs the answer that follows it.
    stdin.write('null\n');
    stdin.write('42\n');
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    stdin.end();

    expect(await done, Buffer.concat(errors).toString()).toBe(0);
    expect(Buffer.concat(seen).toString(), 'the recorded answer must still be served').toContain(
      '"ok":true',
    );
  });
});
