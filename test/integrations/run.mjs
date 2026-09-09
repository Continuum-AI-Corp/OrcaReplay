#!/usr/bin/env node
/**
 * Record a real framework, kill the origin, replay offline, assert the numbers.
 *
 * Each check answers one question: does `orca record` actually capture this, and does the
 * recording still reproduce with nothing to talk to. The second half is why the origin is stopped
 * before the replay — a replay that reached the network would fail here by construction rather
 * than by assertion.
 *
 *   node test/integrations/run.mjs            # all of them
 *   node test/integrations/run.mjs litellm    # one
 */
import { execFile, spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
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
async function orca(argv, cwd) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    // A key has to be present or the SDKs refuse to build a client; it never leaves the machine.
    OPENAI_API_KEY: 'stub-key',
    ANTHROPIC_API_KEY: 'stub-key',
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
  try {
    await cp(join(here, 'agents'), join(dir, 'agents'), { recursive: true });

    const adapter = check.adapter ?? 'generic-openai';
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

    // From here the recording is on its own. Anything that reaches out now fails.
    origin.stop();

    const replayed = await orca(['replay', runId, '--in-place'], dir);
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

    return {
      ok: `${total} exchanges, replayed exact with the origin down${check.forks ? ', forked live' : ''}`,
    };
  } finally {
    origin.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

const only = process.argv[2];
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
  if (result.skipped) {
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
