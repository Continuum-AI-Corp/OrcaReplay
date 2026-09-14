import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecordContext } from '@orcareplay/plugin-api';
import { decodeForwardPath } from '@orcareplay/proxy';
import { checkAdapterContract, formatContractResult } from '../src/contract.js';
import { indexRagAdapter } from '../src/indexrag.js';
import { defaultAdapters } from '../src/registry.js';

/**
 * The first adapter for a pipeline rather than a conversational agent.
 *
 * Three things are different from every adapter before it, and each has a test here: two model
 * origins in one run, a product that lives outside the tracked working tree, and a harness that
 * resumes from that product rather than redoing the work.
 */
describe('the indexrag adapter', () => {
  let root: string;
  let ctx: RecordContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-indexrag-'));
    await mkdir(join(root, 'work'), { recursive: true });
    await mkdir(join(root, 'run'), { recursive: true });
    ctx = {
      runId: 'run_test',
      cwd: join(root, 'work'),
      runDir: join(root, 'run'),
      proxyUrl: 'http://127.0.0.1:44100',
      userArgs: [],
      env: {},
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes the adapter contract', async () => {
    const result = await checkAdapterContract(indexRagAdapter);
    expect(result.ok, formatContractResult(result)).toBe(true);
  });

  it('is registered under the name a user types', () => {
    expect(defaultAdapters().get('indexrag').id).toBe('indexrag');
  });

  describe('detect', () => {
    /** The two files the detector looks for, in a directory shaped like the source tree. */
    async function sourceTree(dir: string): Promise<void> {
      await mkdir(join(dir, 'indexrag', 'aku'), { recursive: true });
      await mkdir(join(dir, 'scripts'), { recursive: true });
      await writeFile(join(dir, 'indexrag', 'aku', 'extractor.py'), '', 'utf8');
      await writeFile(join(dir, 'scripts', 'build_kb.py'), '', 'utf8');
    }

    it('claims the source tree', async () => {
      await sourceTree(ctx.cwd);
      expect(await indexRagAdapter.detect(ctx.cwd)).toBe(true);
    });

    it('declines an empty directory', async () => {
      expect(await indexRagAdapter.detect(ctx.cwd)).toBe(false);
    });

    it('declines a directory that has only half of it', async () => {
      // A directory called `indexrag` is a common enough name to be someone else's; both files
      // have to be there before this adapter claims a workspace it would then launch python in.
      await mkdir(join(ctx.cwd, 'indexrag', 'aku'), { recursive: true });
      await writeFile(join(ctx.cwd, 'indexrag', 'aku', 'extractor.py'), '', 'utf8');
      expect(await indexRagAdapter.detect(ctx.cwd)).toBe(false);
    });

    it('declines a path that does not exist rather than throwing', async () => {
      expect(await indexRagAdapter.detect(join(root, 'nowhere'))).toBe(false);
    });
  });

  describe('the two model origins', () => {
    it('points the chat half at the proxy under /v1', async () => {
      const launch = await indexRagAdapter.prepare(ctx);
      expect(launch.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:44100/v1');
      // langchain's own embedding client reads the other spelling, so both are set.
      expect(launch.env.OPENAI_API_BASE).toBe('http://127.0.0.1:44100/v1');
    });

    /**
     * The second origin keeps its destination. Orca's upstream map is keyed by wire dialect, so
     * "chat at a gateway, embeddings at a dedicated provider" cannot be expressed by any
     * `--upstream-*`; the request has to carry its own address or the proxy has to guess, and
     * guessing sent the embedding provider's key to `api.openai.com`.
     */
    it('redirects the embedding origin through a forward path that names it', async () => {
      const launch = await indexRagAdapter.prepare({
        ...ctx,
        env: { INDEXRAG_EMBEDDING_BASE_URL: 'https://maas.example/v1' },
      });
      const value = launch.env.INDEXRAG_EMBEDDING_BASE_URL!;
      expect(value.startsWith('http://127.0.0.1:44100/forward/')).toBe(true);
      expect(decodeForwardPath(new URL(value).pathname)?.base).toBe('https://maas.example/v1');
    });

    it('leaves the embedding origin alone when the user set none', async () => {
      const launch = await indexRagAdapter.prepare(ctx);
      expect(launch.env.INDEXRAG_EMBEDDING_BASE_URL).toBeUndefined();
    });

    it('carries the embedding credential without inventing one', async () => {
      expect((await indexRagAdapter.prepare(ctx)).env.INDEXRAG_EMBEDDING_API_KEY).toBeUndefined();
      const carried = await indexRagAdapter.prepare({
        ...ctx,
        env: { INDEXRAG_EMBEDDING_API_KEY: 'ak-real' },
      });
      expect(carried.env.INDEXRAG_EMBEDDING_API_KEY).toBe('ak-real');
    });

    it('sets no Anthropic variables — every stage speaks OpenAI', async () => {
      const launch = await indexRagAdapter.prepare(ctx);
      expect(Object.keys(launch.env).filter((k) => k.startsWith('ANTHROPIC_'))).toEqual([]);
    });
  });

  describe('what it launches', () => {
    it('drives the whole pipeline when the user passed only flags', async () => {
      const launch = await indexRagAdapter.prepare({
        ...ctx,
        userArgs: ['--data-dir', 'dataset/mini/documents'],
      });
      expect(launch.command).toBe('python');
      expect(launch.args[0]).toBe(join(ctx.runDir, 'drive_indexrag.py'));
      expect(launch.args.slice(1)).toEqual(['--data-dir', 'dataset/mini/documents']);
      // Written where the contract allows scratch, and declared so the run can clean it up.
      expect(launch.tempFiles).toEqual([launch.args[0]]);
      const driver = await readFile(launch.args[0]!, 'utf8');
      expect(driver).toContain('scripts.extract_akus');
      expect(driver).toContain('scripts.generate_bridging');
      expect(driver).toContain('scripts.build_kb');
      expect(driver).toContain('benchmarks.evaluate');
    });

    it('runs one stage when the user named a command', async () => {
      // What someone debugging the query half wants: record the answering stage on its own.
      const launch = await indexRagAdapter.prepare({
        ...ctx,
        userArgs: ['python', '-m', 'benchmarks.evaluate', '--dataset', 'mini'],
      });
      expect(launch.command).toBe('python');
      expect(launch.args).toEqual(['-m', 'benchmarks.evaluate', '--dataset', 'mini']);
      expect(launch.tempFiles).toBeUndefined();
    });

    it('drives the pipeline when the user passed nothing at all', async () => {
      const launch = await indexRagAdapter.prepare(ctx);
      expect(launch.command).toBe('python');
      expect(launch.args).toEqual([join(ctx.runDir, 'drive_indexrag.py')]);
    });
  });

  describe('its artifacts', () => {
    it('captures the index, the caches, and the corpus its .gitignore excludes', () => {
      expect(indexRagAdapter.artifacts?.capture).toContain('cache');
      expect(indexRagAdapter.artifacts?.capture).toContain('vector_store');
      // The input, not just the output. Without it a replay anywhere but the recording's own
      // directory starts with no documents and reproduces nothing.
      expect(indexRagAdapter.artifacts?.capture).toContain('dataset');
    });

    it('never resets the corpus, which is input rather than product', () => {
      expect(indexRagAdapter.artifacts?.resetBeforeReplay).not.toContain('dataset');
    });

    /**
     * Everything reset must also be captured, or a replay deletes something the safety snapshot
     * never took a copy of — which is the operator's index gone for good.
     */
    it('resets nothing it does not also capture', () => {
      const captured = new Set(indexRagAdapter.artifacts?.capture ?? []);
      for (const path of indexRagAdapter.artifacts?.resetBeforeReplay ?? []) {
        expect(captured.has(path), `${path} is reset but never captured`).toBe(true);
      }
    });

    it('names the flag that would serialise the pipeline, without applying it', () => {
      expect(indexRagAdapter.artifacts?.concurrencyFlag).toEqual({
        flag: '--concurrency',
        serialValue: '1',
      });
      // Declared, never imposed: clamping concurrency would change the run being replayed.
      expect(indexRagAdapter.replayArgs).toBeUndefined();
    });
  });
});
