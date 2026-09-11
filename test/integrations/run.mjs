#!/usr/bin/env node
/**
 * Record a real framework, kill the origin, replay offline, assert the numbers.
 *
 * Each check answers one question: does `orca record` actually capture this, and does the
 * recording still reproduce with nothing to talk to. The second half is why the origin is stopped
 * before the replay — a replay that reached the network would fail here by construction rather
 * than by assertion.
 *
 *   node test/integrations/run.mjs               # all of them
 *   node test/integrations/run.mjs litellm       # one
 *   node test/integrations/run.mjs --require-all # a skip is a failure, which is what CI wants
 */
import { execFile, spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const cli = join(root, 'packages', 'cli', 'dist', 'cli.js');

/**
 * The corpus.
 *
 * `needs` is the import that has to resolve for the check to mean anything; without it the check
 * is skipped rather than failed, so a contributor who has not installed every framework can still
 * run the suite. CI installs them, which is what turns a skip there into a failure.
 */
const CHECKS = [
  {
    id: 'openai-sdk',
    what: 'the official Python SDK, configured only by the environment',
    run: ['python', 'agents/openai_sdk.py'],
    needs: 'openai',
    exchanges: 1,
  },
  {
    id: 'openai-async',
    what: 'AsyncOpenAI, which the OpenAI Agents SDK builds on',
    run: ['python', 'agents/openai_async.py'],
    needs: 'openai',
    exchanges: 1,
  },
  {
    id: 'anthropic-sdk',
    what: 'the Anthropic SDK reaching /v1/messages',
    run: ['python', 'agents/anthropic_sdk.py'],
    needs: 'anthropic',
    exchanges: 1,
  },
  {
    id: 'litellm',
    what: 'LiteLLM — the layer CrewAI, Aider and OpenHands route through',
    run: ['python', 'agents/litellm_agent.py'],
    needs: 'litellm',
    exchanges: 1,
  },
  {
    id: 'openhands-sdk',
    what: "the OpenHands SDK's own LLM layer, which wraps LiteLLM",
    run: ['python', 'agents/openhands_agent.py'],
    needs: 'openhands.sdk',
    exchanges: 1,
  },
  {
    id: 'openai-agents',
    what: 'the OpenAI Agents SDK on its default wire format, the Responses API',
    run: ['python', 'agents/openai_agents_sdk.py'],
    needs: 'agents',
    exchanges: 1,
  },
  {
    id: 'crewai',
    what: 'CrewAI itself — which since 1.x no longer routes through LiteLLM at all',
    run: ['python', 'agents/crewai_agent.py'],
    needs: 'crewai',
    exchanges: 1,
  },
  {
    id: 'langgraph-stream',
    what: 'a two-node LangGraph over streaming SSE',
    run: ['python', 'agents/langgraph_agent.py', 'stream'],
    needs: 'langgraph',
    exchanges: 2,
    // The one check that also forks. A fork is the third of the three things the README claims,
    // and it is the only one that leaves the recording behind and asks a model again — so it is
    // exercised where the stub is still up, which is what keeps it free.
    forks: true,
  },
  {
    id: 'langgraph-tools',
    what: 'the same graph with a bound tool',
    run: ['python', 'agents/langgraph_agent.py', 'tools'],
    needs: 'langgraph',
    exchanges: 2,
  },
  {
    id: 'browser-use',
    what: "browser-use's own ChatOpenAI, which passes an unset base_url straight through",
    run: ['python', 'agents/browser_use_agent.py'],
    needs: 'browser_use',
    exchanges: 1,
  },
  {
    id: 'fetch-hook',
    what: 'a JS agent with its origin compiled in',
    adapter: 'node',
    run: ['node', 'agents/hardcoded_origin.mjs'],
    exchanges: 1,
  },
  {
    id: 'rag-index',
    what: 'a retrieval pipeline: concurrent indexing, an embedding batch, then one answer',
    run: ['python', 'agents/rag_pipeline.py'],
    needs: 'openai',
    // Four indexing calls plus the answer. The four are the ones that used to be served each
    // other's extraction under a `minor` label, because their only message is a fixed template
    // and the document rides in the system prompt.
    exchanges: 5,
    // Two embedding calls: the batch, and the question. Neither is a model exchange, and before
    // `RetrievalRule` a strict replay answered 502 at the first of them.
    retrieval: 2,
    // What the retriever put in the prompt, derived rather than captured.
    retrievalContexts: 1,
  },
  {
    id: 'rag-split-origin',
    what: 'the same pipeline with embeddings at a second origin of the same wire dialect',
    run: ['python', 'agents/rag_pipeline.py'],
    needs: 'openai',
    exchanges: 5,
    retrieval: 2,
    // The configuration `--upstream-openai` cannot express: chat at one origin and embeddings at
    // another, both OpenAI-shaped. Redirected through `/forward/`, the request carries its own
    // destination and the proxy has nothing to guess at.
    secondOrigin: 'EMBEDDING_BASE_URL',
  },
];

/** Whether the framework this check speaks for is installed at all. */
async function installed(module) {
  if (module === undefined) return true;
  try {
    await exec('python', ['-c', `import ${module}`], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** Start the stub and resolve once it has printed the port it took. */
function startOrigin() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'stub-origin.mjs'), '0'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const port = Number(out.trim());
      if (Number.isInteger(port) && port > 0) resolve({ port, stop: () => child.kill() });
    });
    child.on('error', reject);
    child.on('exit', () => reject(new Error('the stub origin exited before it was ready')));
    setTimeout(() => reject(new Error('the stub origin did not start in 10s')), 10_000).unref();
  });
}

/** Run the CLI, returning what it printed whether or not it succeeded. */
async function orca(argv, cwd, extraEnv = {}) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    // A key has to be present or the SDKs refuse to build a client; it never leaves the machine.
    OPENAI_API_KEY: 'stub-key',
    ANTHROPIC_API_KEY: 'stub-key',
    ...extraEnv,
  };
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...argv], {
      cwd,
      env,
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, killed: e.killed };
  }
}

async function runCheck(check) {
  if (!(await installed(check.needs))) return { skipped: `${check.needs} is not installed` };

  const dir = await mkdtemp(join(tmpdir(), `orca-int-${check.id}-`));
  const origin = await startOrigin();
  // A second stub, only for the checks that split their traffic across two origins of the same
  // wire dialect — the shape `--upstream-openai` cannot express, and the ordinary shape of a
  // retrieval stack.
  const second = check.secondOrigin ? await startOrigin() : undefined;
  try {
    await cp(join(here, 'agents'), join(dir, 'agents'), { recursive: true });

    const adapter = check.adapter ?? 'generic-openai';
    // The variable that names the second origin is redirected by name, which is what an adapter
    // for a known harness does for itself.
    const splitEnv = second
      ? {
          [check.secondOrigin]: `http://127.0.0.1:${second.port}/v1`,
          ORCA_BASE_URL_VARS: check.secondOrigin,
        }
      : {};
    const recorded = await orca(
      [
        'record',
        adapter,
        '--upstream-openai',
        `http://127.0.0.1:${origin.port}`,
        '--upstream-anthropic',
        `http://127.0.0.1:${origin.port}`,
        '--',
        ...check.run,
      ],
      dir,
      splitEnv,
    );
    if (recorded.code !== 0) throw new Error(`record exited ${recorded.code}`);
    if (!recorded.out.includes('GOT:')) throw new Error('the agent did not produce its answer');
    if (/capture\.empty/.test(recorded.out)) {
      throw new Error('recorded nothing — the traffic never reached the proxy');
    }

    const runId = /run=(run_[0-9a-f]+)/.exec(recorded.out)?.[1];
    if (runId === undefined) throw new Error('no run id in the record output');

    // A fork continues live from a checkpoint, so it runs while the stub is still up — which is
    // also what keeps it free. `replayed=0 live=N` is the shape to look for: nothing served from
    // the recording past the cursor, every turn after it answered by the origin.
    if (check.forks) {
      const forked = await orca(
        [
          'replay',
          runId,
          '--from',
          '1',
          '--model',
          'stub-2',
          '--upstream-openai',
          `http://127.0.0.1:${origin.port}`,
        ],
        dir,
      );
      if (forked.code !== 0) throw new Error(`fork exited ${forked.code}`);
      const f = /fork\.done .*live=(\d+) divergences=(\d+)/.exec(forked.out);
      if (f === null) throw new Error('fork printed no verdict');
      if (Number(f[1]) === 0) throw new Error('the fork answered nothing live');
      if (Number(f[2]) !== 0) throw new Error(`${f[2]} divergence(s) in the fork`);
    }

    // What the trace says it captured, before the origins go down.
    const events = (await readFile(join(dir, '.orca', 'runs', runId, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));

    // `retrieval.context` exists nowhere on the wire — it is derived from the prompt — so nothing
    // but the trace can show whether it was derived at all.
    if (check.retrievalContexts !== undefined) {
      const found = events.filter((e) => e.type === 'retrieval.context');
      if (found.length !== check.retrievalContexts) {
        throw new Error(
          `${found.length} retrieval.context event(s), wanted ${check.retrievalContexts}`,
        );
      }
      // Derived means derived: the passages have to be the ones that were in the prompt.
      if (!(found[0].attrs?.passages > 0)) throw new Error('retrieval.context named no passages');
    }

    // Where the second origin's traffic actually went. This is the assertion the check exists for
    // — without it, "two origins" is indistinguishable from one, which is precisely the failure
    // being guarded against: the embeddings were forwarded to the *chat* origin, or to
    // `api.openai.com`, carrying the embedding provider's credential.
    if (second) {
      const retrievalCalls = events.filter(
        (e) => e.type === 'net.request' && e.attrs?.replay_key !== undefined,
      );
      const stray = retrievalCalls.filter((e) => e.attrs?.port !== second.port);
      if (retrievalCalls.length === 0) throw new Error('no retrieval call reached the trace');
      if (stray.length > 0) {
        const where = stray.map((e) => `${e.attrs?.host}:${e.attrs?.port}`).join(', ');
        throw new Error(
          `${stray.length} retrieval call(s) went to ${where}, not the second origin`,
        );
      }
      // And the chat half stayed where it was. Both halves, or the check proves only one of them.
      const chat = events.filter((e) => e.type === 'model.response');
      if (chat.some((e) => !String(e.attrs?.upstream ?? '').includes(`:${origin.port}`))) {
        throw new Error('a model exchange left the chat origin');
      }
    }

    // From here the recording is on its own. Anything that reaches out now fails.
    origin.stop();
    second?.stop();

    const replayed = await orca(['replay', runId, '--in-place'], dir, splitEnv);
    if (replayed.code !== 0) throw new Error(`replay exited ${replayed.code}`);

    const m = /reused=(\d+)\/(\d+) exact=(\d+) divergences=(\d+) unmatched=(\d+)/.exec(
      replayed.out,
    );
    if (m === null) throw new Error('replay printed no verdict');
    const [, reused, total, exact, divergences, unmatched] = m.map(Number);

    if (total !== check.exchanges)
      throw new Error(`recorded ${total} exchanges, wanted ${check.exchanges}`);
    if (reused !== total)
      throw new Error(`${total - reused} turn(s) could not be served from the recording`);
    if (exact !== total) throw new Error(`${exact}/${total} matched byte for byte`);
    if (divergences !== 0) throw new Error(`${divergences} divergence(s)`);
    if (unmatched !== 0) throw new Error(`${unmatched} unmatched`);

    // Retrieval is a separate axis and asserted separately, for the reason it is reported
    // separately: `exact` is about a matching ladder these calls never climb, and a check that
    // read only `exact` would call a replay faithful while every embedding in it went unserved.
    if (check.retrieval !== undefined) {
      const r = /retrieval=(\d+)\/(\d+)/.exec(replayed.out);
      if (r === null) throw new Error('replay printed no retrieval count');
      const [, served, recordedCalls] = r.map(Number);
      if (recordedCalls !== check.retrieval)
        throw new Error(`recorded ${recordedCalls} retrieval calls, wanted ${check.retrieval}`);
      if (served !== recordedCalls)
        throw new Error(
          `${recordedCalls - served} retrieval call(s) not served from the recording`,
        );
    }

    const retrievalNote = check.retrieval === undefined ? '' : `, ${check.retrieval} retrieval`;
    return {
      ok: `${total} exchanges${retrievalNote}, replayed exact with the origin down${check.forks ? ', forked live' : ''}`,
    };
  } finally {
    origin.stop();
    second?.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `--require-all` turns a skip into a failure.
 *
 * A skip is right for a contributor who has not installed every framework, and wrong for CI, where
 * the whole point is that the check ran. Without a way to say so the two are indistinguishable from
 * the exit code, and that is not hypothetical: two checks were added, neither was added to the
 * workflow's `pip install` line, and CI went green on three skips while the README said "in CI"
 * about all of them. The intent was even written down here — "CI installs them, so a skip there is
 * a failure" — and nothing enforced it.
 */
const args = process.argv.slice(2);
const requireAll = args.includes('--require-all');
const only = args.find((a) => !a.startsWith('--'));
const selected = only ? CHECKS.filter((c) => c.id === only) : CHECKS;
if (selected.length === 0) {
  console.error(`no check named ${only}. known: ${CHECKS.map((c) => c.id).join(', ')}`);
  process.exit(2);
}

let failed = 0;
let skipped = 0;
for (const check of selected) {
  process.stdout.write(`── ${check.id.padEnd(18)} `);
  let result;
  try {
    result = await runCheck(check);
  } catch (e) {
    result = { failed: String(e.message).split('\n')[0] };
  }
  if (result.skipped && requireAll) {
    failed += 1;
    console.log(`FAILED — ${result.skipped}, and --require-all was given`);
    console.log(`   ${check.what}`);
  } else if (result.skipped) {
    skipped += 1;
    console.log(`skipped — ${result.skipped}`);
  } else if (result.failed) {
    failed += 1;
    console.log(`FAILED — ${result.failed}`);
    console.log(`   ${check.what}`);
  } else {
    console.log(result.ok);
  }
}

console.log(`\n${selected.length} checked, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
