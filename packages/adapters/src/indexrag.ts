import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, Launch, RecordContext } from '@orcareplay/plugin-api';
import { forwardBasePath } from '@orcareplay/proxy';
import { applyNamedBaseUrls, passKey, passThrough, proxyBase, readEnv } from './env.js';

/**
 * IndexRAG — a retrieval pipeline rather than a conversational agent.
 *
 * It is the first adapter for a harness of this shape, and the shape is what makes it worth
 * having its own rather than running it under `generic-openai`. Three things are different:
 *
 * **Two model origins in one run.** Chat (extraction, bridging, answering) reads
 * `OPENAI_BASE_URL`; embeddings read `INDEXRAG_EMBEDDING_BASE_URL` and may point at a completely
 * different provider — a dedicated embedding vendor, or a local Ollama. Orca's upstream map is
 * keyed by wire dialect, so no `--upstream-*` can express "the same dialect at two origins"; the
 * second one is redirected through `/forward/`, which carries its own destination on the request.
 *
 * **The product is not the working tree.** What a run produces is `cache/` and `vector_store/`,
 * both on the first two lines of IndexRAG's own `.gitignore`. Without `artifacts.capture` a
 * recording holds every call that built an index and no trace of the index.
 *
 * **It resumes.** Run again over a finished cache and it asks nothing at all — which on replay
 * means a recording that reproduces perfectly by doing nothing. `artifacts.resetBeforeReplay`
 * puts the workspace back to where the recording began.
 *
 * Nothing here is IndexRAG-specific except the names: the same three declarations describe
 * LlamaIndex, Microsoft GraphRAG and LightRAG, which is why they are declarations rather than
 * code.
 */
export const indexRagAdapter: Adapter = {
  id: 'indexrag',
  harnessVersions: '>=0.1.0 <0.2',
  capture: 'env',

  /**
   * The source tree, not an installed package.
   *
   * IndexRAG's wheel does not carry `indexrag/aku/prompts/*.md`, so a `pip install`ed copy cannot
   * extract anything — and the pipeline this adapter drives is run from a checkout in every
   * documented usage. Two files rather than one: a directory called `indexrag` is a common enough
   * name that a single probe would claim someone else's workspace.
   */
  async detect(cwd: string): Promise<boolean> {
    try {
      return (
        existsSync(join(cwd, 'indexrag', 'aku', 'extractor.py')) &&
        existsSync(join(cwd, 'scripts', 'build_kb.py'))
      );
    } catch {
      return false;
    }
  },

  async prepare(ctx: RecordContext): Promise<Launch> {
    const env: Record<string, string> = {
      // Three `openai.OpenAI()` call sites — extraction, bridging, answer generation — and
      // langchain's default embedding path, which reads the second spelling.
      OPENAI_BASE_URL: proxyBase(ctx.proxyUrl, 'v1'),
      OPENAI_API_BASE: proxyBase(ctx.proxyUrl, 'v1'),
    };
    passKey(env, ctx.env, 'OPENAI_API_KEY');
    // No `ANTHROPIC_*`: every stage speaks OpenAI, and inventing an Anthropic credential is how
    // a harness that picks its provider from what it can see picks a different one under
    // recording. See the contract's `no-invented-keys`.

    // The second origin. Redirected without its original target it would be forwarded to the chat
    // upstream — a model that endpoint has never heard of, with the embedding provider's key on
    // it; left alone it bypasses orca entirely and not even a `net.*` pair reaches the trace.
    //
    // Read from the environment *or* from the project's own `.env`, because that is where
    // IndexRAG documents it: `indexrag/config.py` loads `.env` from the working directory before
    // anything reads configuration, and `.env.example` is the file people copy. An adapter that
    // only looked at `ctx.env` would leave the variable unset here, let Python pick the real
    // origin up a moment later, and record nothing of the embedding half — the silent capture gap
    // this whole file exists to close. The environment still wins, exactly as it does in
    // `config.py`.
    const embedding =
      readEnv(ctx.env, 'INDEXRAG_EMBEDDING_BASE_URL') ??
      dotEnv(ctx.cwd)['INDEXRAG_EMBEDDING_BASE_URL'];
    if (embedding !== undefined) {
      env.INDEXRAG_EMBEDDING_BASE_URL = proxyBase(ctx.proxyUrl, forwardBasePath(embedding));
    }
    passThrough(env, ctx.env, 'INDEXRAG_EMBEDDING_API_KEY');
    passThrough(env, ctx.env, 'INDEXRAG_EMBEDDING_PROVIDER');
    passThrough(env, ctx.env, 'INDEXRAG_EMBEDDING_MODEL');
    passThrough(env, ctx.env, 'INDEXRAG_LLM_MODEL');
    // A harness the author has not met is the normal case even inside one project: someone
    // pointing a rerank service or a second gateway somewhere still gets a way to name it.
    applyNamedBaseUrls(env, ctx.env, ctx.proxyUrl);

    // A command the user spelled out wins. `orca record indexrag -- python -m benchmarks.evaluate
    // --dataset mini` records exactly that one stage, which is what someone debugging the query
    // half wants; anything starting with `-` is an argument to the pipeline, not a program.
    const [first, ...rest] = ctx.userArgs;
    if (first !== undefined && first !== '' && !first.startsWith('-')) {
      return { command: first, args: rest, env };
    }

    // Otherwise: the whole pipeline, as one recorded run. `orca record` launches one process and
    // IndexRAG's stages are four of them, so the stages are driven in-process from a script
    // written into the run directory — which the contract's `no-foreign-paths` allows precisely
    // so an adapter can do this reproducibly.
    const driver = join(ctx.runDir, DRIVER_FILENAME);
    await writeFile(driver, PIPELINE_DRIVER, 'utf8');
    return { command: 'python', args: [driver, ...ctx.userArgs], env, tempFiles: [driver] };
  },

  artifacts: {
    // The index, the caches it is built from, and the corpus it is built *of*. IndexRAG's
    // `.gitignore` excludes all three — `vector_store/`, `cache/` and `dataset/` are its first
    // three data lines — so without this a recording holds every call the run made and neither
    // its input nor its output.
    //
    // `dataset` is the one that looks optional and is not. A replay in the recording's own
    // directory finds it already there, which is why this was easy to miss; a replay anywhere
    // else — `--worktree`, another machine — starts with no documents to chunk and reproduces
    // nothing, `reused=0/11 exit=2`, over a recording that was perfectly good. It is the input
    // the run read, and a recording that cannot be read without the reader's own disk is not a
    // recording. The cost is real for a large corpus, and `--no-fs` is the way to decline it.
    capture: ['cache', 'vector_store', 'dataset', 'test_results_*.json'],
    // Whole directories, never "the valid parts". IndexRAG's resume skips by `chunk_id`, and the
    // cache holds `success: false` entries in the same shape as successes — so keeping what looks
    // valid promotes the previous run's failures to completed work, which is a worse wrong answer
    // than the one being fixed.
    resetBeforeReplay: ['cache', 'vector_store'],
    concurrencyFlag: { flag: '--concurrency', serialValue: '1' },
  },
};

const DRIVER_FILENAME = 'drive_indexrag.py';

/**
 * The project's own `.env`, read the way `indexrag/config.py` reads it.
 *
 * Only for looking things up — nothing here is copied into the child, which would turn a file
 * Python is about to read for itself into a second, diverging source of truth. What it is for is
 * the one variable orca has to know *before* the harness starts: the embedding origin, which
 * decides whether that half of the run is captured at all.
 *
 * Deliberately the same small parser: `KEY=VALUE`, `#` comments, optional surrounding quotes, an
 * optional `export ` prefix. An unreadable or absent file is not an error — it is the ordinary
 * case for someone who configured everything through their shell.
 */
function dotEnv(cwd: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(join(cwd, '.env'), 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    const key = line
      .slice(0, at)
      .trim()
      .replace(/^export\s+/, '');
    let value = line.slice(at + 1).trim();
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === '"' || value[0] === "'")
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '' && value !== '') out[key] = value;
  }
  return out;
}

/**
 * The pipeline, as one process.
 *
 * `runpy` rather than four subprocesses: `orca record` launches one child and watches it, so four
 * children would be four recordings or none. Running the stages in-process keeps them in one
 * trace, in order, with the filesystem snapshots between turns showing the cache and the index
 * appearing.
 *
 * The arguments it accepts are the ones that change what the run *does*. Everything else is
 * IndexRAG's own default, because an adapter that re-declares a harness's defaults is an adapter
 * that goes stale the first time one of them changes.
 */
const PIPELINE_DRIVER = `"""Drive IndexRAG's stages as one recorded run.

Written by the OrcaReplay 'indexrag' adapter into the run directory. Not part of IndexRAG.
"""

import argparse
import runpy
import sys
from pathlib import Path

# The stages are 'scripts.*' and 'benchmarks.*', which resolve against the working directory --
# and sys.path[0] is this script's directory, not the workspace, because that is how Python
# starts a file by path. Without this every stage fails on 'No module named scripts'.
sys.path.insert(0, str(Path.cwd()))

parser = argparse.ArgumentParser(prog="drive_indexrag")
parser.add_argument("--data-dir", required=True, help="Directory with the .txt documents")
parser.add_argument("--suffix", default=None, help="Cache file suffix")
parser.add_argument("--concurrency", type=int, default=None)
parser.add_argument("--model", default=None, help="Chat model for extraction and bridging")
parser.add_argument("--kb-type", default="indexrag", choices=["indexrag", "naive"])
parser.add_argument("--top-k", type=int, default=None)
parser.add_argument("--skip-eval", action="store_true", help="Index only; do not answer questions")
args = parser.parse_args()

data_dir = Path(args.data_dir)
dataset = data_dir.parent.name
suffix = f"_{args.suffix}" if args.suffix else ""
cache = Path("cache") / f"{dataset}{suffix}_faqs.json"
bridging = cache.with_name(f"{cache.stem}_bridging.json")

shared = []
if args.concurrency is not None:
    shared += ["--concurrency", str(args.concurrency)]
model = ["--model", args.model] if args.model else []


def stage(module, *argv):
    print(f"\\n=== {module} ===", flush=True)
    sys.argv = [module, *argv]
    runpy.run_module(module, run_name="__main__")


stage("scripts.extract_akus", "--data-dir", str(data_dir),
      *(["--suffix", args.suffix] if args.suffix else []), *shared, *model)
stage("scripts.generate_bridging", "--cache", str(cache), *shared, *model)

build = ["--data-dir", str(data_dir), "--kb-type", args.kb_type, "--cache", str(cache)]
if bridging.exists():
    build += ["--bridging", str(bridging)]
stage("scripts.build_kb", *build)

questions = data_dir.parent / "questions.json"
if not args.skip_eval and questions.exists():
    stage("benchmarks.evaluate", "--dataset", dataset, "--kb-type", args.kb_type,
          *(["--top-k", str(args.top_k)] if args.top_k is not None else []),
          *(["--llm-model", args.model] if args.model else []))
elif not args.skip_eval:
    print(f"\\nno {questions}; indexed but not evaluated", flush=True)
`;
