import { MODEL_BASE_URL_VARS } from './contract.js';

/**
 * Adapters are the growth loop: they are how OrcaReplay reaches harnesses its maintainers have
 * never run. This returns file *contents* rather than writing them — the CLI owns the filesystem,
 * and data comes back testable, so the generated code is held to the same contract as the shipped
 * adapters instead of being hoped about.
 */

export interface ScaffoldFile {
  /** Path relative to packages/adapters, where a contributor would add the file. */
  path: string;
  contents: string;
}

export interface ScaffoldResult {
  files: ScaffoldFile[];
}

export interface ScaffoldOptions {
  /** Binary that launches the harness. Defaults to the adapter id. */
  command?: string;
  /** Variable the harness reads for its API origin. One of MODEL_BASE_URL_VARS. */
  baseUrlVar?: string;
  /** Credential the harness reads. Defaults to the base-url variable's provider. */
  apiKeyVar?: string;
  /** Path appended to the proxy url — OpenAI SDK clients want the version segment, others do not. */
  basePath?: string;
}

export function scaffoldAdapter(name: string, opts: ScaffoldOptions = {}): ScaffoldResult {
  const id = toId(name);
  if (id === '') {
    throw new Error(
      `adapter name '${name}' has no usable characters; ids are lowercase kebab-case, e.g. 'my-agent'`,
    );
  }
  const baseUrlVar = opts.baseUrlVar ?? 'OPENAI_BASE_URL';
  if (!(MODEL_BASE_URL_VARS as readonly string[]).includes(baseUrlVar)) {
    throw new Error(
      `${baseUrlVar} is not a variable the proxy speaks. Use one of ${MODEL_BASE_URL_VARS.join(', ')} — the proxy serves the Anthropic and OpenAI wire protocols, and a harness-specific variable is something you add alongside one of these, never instead of it`,
    );
  }
  const provider = baseUrlVar.split('_')[0] ?? 'OPENAI';
  const command = opts.command ?? id;
  const apiKeyVar = opts.apiKeyVar ?? `${provider}_API_KEY`;
  const basePath = opts.basePath ?? (provider === 'OPENAI' ? 'v1' : '');
  const constName = exportName(id);

  return {
    files: [
      {
        path: `src/${id}.ts`,
        contents: adapterSource({ id, constName, command, baseUrlVar, apiKeyVar, basePath }),
      },
      {
        path: `test/${id}.test.ts`,
        contents: testSource({ id, constName, command, baseUrlVar, apiKeyVar, basePath }),
      },
    ],
  };
}

interface Names {
  id: string;
  constName: string;
  command: string;
  baseUrlVar: string;
  apiKeyVar: string;
  basePath: string;
}

function adapterSource(n: Names): string {
  return `import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { hasBinary } from './detect.js';
import { passKey, proxyBase } from './env.js';

/**
 * TODO: confirm that ${n.command} really reads ${n.baseUrlVar} for its API origin, then record
 * what you verified in fixtures/harness/${n.id}.json. If the harness reads some other variable,
 * this adapter captures nothing and every run still looks exactly like it worked.
 */
export const ${n.constName}: Adapter = {
  id: '${n.id}',
  // harnessVersions: '>=1.0.0', // the range you actually tested against, once you have one

  async detect(_cwd: string): Promise<boolean> {
    return hasBinary('${n.command}');
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const env: Record<string, string> = { ${n.baseUrlVar}: ${proxyCall(n.basePath)} };
    passKey(env, ctx.env, '${n.apiKeyVar}');
    return { command: '${n.command}', args: [...ctx.userArgs], env };
  },
};
`;
}

function testSource(n: Names): string {
  return `import type { RecordContext } from '@orcareplay/plugin-api';
import { describe, expect, it } from 'vitest';
import { checkAdapterContract } from '../src/contract.js';
import { ${n.constName} } from '../src/${n.id}.js';

/**
 * Register the adapter in src/index.ts and src/registry.ts and record its wire contract in
 * fixtures/harness/${n.id}.json; test/contract.test.ts and test/harness-versions.test.ts then
 * cover it with no further opt-in. This file is for what only you can assert — the flags and
 * environment this particular harness needs.
 */

function ctx(over: Partial<RecordContext> = {}): RecordContext {
  return {
    runId: 'run_scaffold',
    cwd: '/work',
    proxyUrl: 'http://127.0.0.1:51733',
    runDir: '/work/.orca/runs/run_scaffold',
    userArgs: [],
    env: {},
    ...over,
  };
}

describe('${n.constName}', () => {
  it('satisfies the adapter contract', async () => {
    const result = await checkAdapterContract(${n.constName});
    expect(result.failed).toEqual([]);
  });

  it('points ${n.command} at the recording proxy', async () => {
    const launch = await ${n.constName}.prepare(ctx());
    expect(launch.command).toBe('${n.command}');
    expect(launch.env.${n.baseUrlVar}).toBe('${expectedBaseUrl(n.basePath)}');
  });

  it('passes a real key through, and substitutes a placeholder when there is none', async () => {
    const real = await ${n.constName}.prepare(ctx({ env: { ${n.apiKeyVar}: 'sk-real' } }));
    expect(real.env.${n.apiKeyVar}).toBe('sk-real');
    const none = await ${n.constName}.prepare(ctx());
    expect(none.env.${n.apiKeyVar}).toBe('orca-recorded');
  });

  it('resolves detect() rather than throwing, even for a path that does not exist', async () => {
    await expect(${n.constName}.detect('/nope/does/not/exist')).resolves.toBe(false);
  });
});
`;
}

function proxyCall(basePath: string): string {
  return basePath === '' ? 'proxyBase(ctx.proxyUrl)' : `proxyBase(ctx.proxyUrl, '${basePath}')`;
}

function expectedBaseUrl(basePath: string): string {
  return basePath === '' ? 'http://127.0.0.1:51733' : `http://127.0.0.1:51733/${basePath}`;
}

function toId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function exportName(id: string): string {
  const camel = id.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
  // An identifier cannot start with a digit, and a scaffold that emits code which will not parse
  // is worse than one that renames.
  const safe = /^[0-9]/.test(camel) ? `agent${camel[0]?.toUpperCase()}${camel.slice(1)}` : camel;
  return `${safe}Adapter`;
}
