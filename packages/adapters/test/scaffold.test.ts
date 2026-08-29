import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Adapter } from '@orcareplay/plugin-api';
import { checkAdapterContract, scaffoldAdapter } from '../src/index.js';
import type { ScaffoldFile } from '../src/index.js';

/**
 * The scaffold is the growth loop: adapters are how OrcaReplay reaches agents its maintainers have
 * never run. So the generated code is held to the same contract as the shipped adapters — a
 * starting point that fails the guard on its first run teaches the contributor to ignore it.
 */

const SCRATCH = new URL('../.scaffold-scratch/', import.meta.url);

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function file(files: ScaffoldFile[], path: string): string {
  const found = files.find((f) => f.path === path);
  if (found === undefined) throw new Error(`no generated file at ${path}, got: ${paths(files)}`);
  return found.contents;
}

function paths(files: ScaffoldFile[]): string {
  return files.map((f) => f.path).join(', ');
}

let loaded = 0;

/** Runs the generated adapter for real. Nothing about it is rewritten except where src/ sits. */
async function loadGenerated(source: string, id: string): Promise<Adapter> {
  const relocated = source
    .replaceAll("'./detect.js'", "'../src/detect.js'")
    .replaceAll("'./env.js'", "'../src/env.js'");
  const target = new URL(`${id}-${(loaded += 1)}.ts`, SCRATCH);
  writeFileSync(target, relocated);
  const mod: Record<string, unknown> = await import(pathToFileURL(fileURLToPath(target)).href);
  const adapter = Object.values(mod).find(
    (value): value is Adapter =>
      typeof value === 'object' && value !== null && 'id' in value && 'prepare' in value,
  );
  if (adapter === undefined) throw new Error(`generated module exported no adapter: ${paths([])}`);
  return adapter;
}

describe('scaffoldAdapter', () => {
  it('generates an adapter and its test, at the paths a contributor would add them', () => {
    const { files } = scaffoldAdapter('my-agent');
    expect(files.map((f) => f.path)).toEqual(['src/my-agent.ts', 'test/my-agent.test.ts']);
  });

  it('turns a human name into a contract-legal id', () => {
    const { files } = scaffoldAdapter('  My Agent CLI  ');
    expect(paths(files)).toContain('src/my-agent-cli.ts');
    expect(file(files, 'src/my-agent-cli.ts')).toContain("id: 'my-agent-cli'");
    expect(file(files, 'src/my-agent-cli.ts')).toContain('export const myAgentCliAdapter: Adapter');
  });

  it('refuses a name with nothing usable in it, rather than emitting a broken id', () => {
    expect(() => scaffoldAdapter('!!!')).toThrow(/name/i);
  });

  it('leaves no placeholder unreplaced in any generated file', () => {
    for (const generated of [scaffoldAdapter('my-agent'), scaffoldAdapter('Zed', { command: 'z' })])
      for (const f of generated.files) {
        expect(f.contents, f.path).not.toMatch(/__[A-Z0-9_]+__/);
        expect(f.contents, f.path).not.toContain('${');
        expect(f.contents, f.path).not.toMatch(/<(?:name|id|adapter|agent|command|var)>/i);
        expect(f.contents, f.path).not.toContain('undefined');
      }
  });

  it('leaves exactly one TODO, naming the one thing only the contributor can check', () => {
    const source = file(scaffoldAdapter('my-agent').files, 'src/my-agent.ts');
    expect(source.match(/TODO/g)).toHaveLength(1);
    expect(source).toContain('OPENAI_BASE_URL');
    expect(source.slice(source.indexOf('TODO'))).toMatch(/reads|variable/i);
  });

  it('is deterministic, so regenerating never produces a spurious diff', () => {
    expect(scaffoldAdapter('my-agent')).toEqual(scaffoldAdapter('my-agent'));
  });

  it('generates an adapter that passes the contract as-is', async () => {
    const { files } = scaffoldAdapter('my-agent');
    const adapter = await loadGenerated(file(files, 'src/my-agent.ts'), 'my-agent');
    const result = await checkAdapterContract(adapter);
    expect(result.failed).toEqual([]);
    expect(result.adapter).toBe('my-agent');
  });

  it('generates an adapter that redirects to the proxy it is handed', async () => {
    const { files } = scaffoldAdapter('my-agent');
    const adapter = await loadGenerated(file(files, 'src/my-agent.ts'), 'my-agent');
    const launch = await adapter.prepare({
      runId: 'run_1',
      cwd: '/work',
      proxyUrl: 'http://127.0.0.1:51733',
      runDir: '/work/.orca/runs/run_1',
      userArgs: ['--task', 'x'],
      env: {},
    });
    expect(launch.command).toBe('my-agent');
    expect(launch.args).toEqual(['--task', 'x']);
    expect(launch.env['OPENAI_BASE_URL']).toBe('http://127.0.0.1:51733/v1');
    expect(launch.env['OPENAI_API_KEY']).toBe('orca-recorded');
  });

  it('generates a detect that resolves rather than throwing', async () => {
    const { files } = scaffoldAdapter('my-agent');
    const adapter = await loadGenerated(file(files, 'src/my-agent.ts'), 'my-agent');
    await expect(adapter.detect('/nope/does/not/exist')).resolves.toBe(false);
  });

  it('follows an Anthropic-protocol harness, key and base path included', async () => {
    const { files } = scaffoldAdapter('my-claude', { baseUrlVar: 'ANTHROPIC_BASE_URL' });
    const source = file(files, 'src/my-claude.ts');
    expect(source).toContain('ANTHROPIC_BASE_URL: proxyBase(ctx.proxyUrl)');
    expect(source).toContain("passKey(env, ctx.env, 'ANTHROPIC_API_KEY')");
    const adapter = await loadGenerated(source, 'my-claude');
    const result = await checkAdapterContract(adapter);
    expect(result.failed).toEqual([]);
  });

  it('takes the command when the binary is not named after the adapter', () => {
    const source = file(
      scaffoldAdapter('my-agent', { command: 'magent' }).files,
      'src/my-agent.ts',
    );
    expect(source).toContain("hasBinary('magent')");
    expect(source).toContain("command: 'magent'");
  });

  it('refuses a base-url variable the proxy does not speak', () => {
    // The proxy speaks the Anthropic and OpenAI wire protocols; a harness-specific variable is
    // additive, never a replacement, and an adapter that only sets one captures nothing.
    expect(() => scaffoldAdapter('my-agent', { baseUrlVar: 'MYAGENT_BASE_URL' })).toThrow(
      /ANTHROPIC_BASE_URL|OPENAI_BASE_URL/,
    );
  });

  it('generates a test that runs the contract and names the adapter', () => {
    const contents = file(scaffoldAdapter('my-agent').files, 'test/my-agent.test.ts');
    expect(contents).toContain("from '../src/my-agent.js'");
    expect(contents).toContain('checkAdapterContract');
    expect(contents).toContain('myAgentAdapter');
    expect(contents).toContain('fixtures/harness/my-agent.json');
  });
});
