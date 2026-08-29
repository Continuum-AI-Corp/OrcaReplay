import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, parseArgs } from '../src/index.js';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-shim-cli-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
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
});
