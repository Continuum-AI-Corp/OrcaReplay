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
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
    id: 'openai-agents-handoff',
    what: 'a two-agent handoff and a guardrail, reported by the SDK and captured without editing it',
    run: ['python', 'agents/openai_agents_handoff.py'],
    needs: ['agents', 'orcareplay_openai_agents'],
    exchanges: 2,
    // The point of the check. These three cannot come from the proxy: a handoff reaches the wire as
    // an ordinary `transfer_to_*` tool call that never names the agent it came *from*, and a
    // guardrail need make no request at all.
    expectEvents: ['agent.start', 'agent.handoff', 'agent.guardrail'],
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
    id: 'vision-repaint',
    what: 'an agent with eyes: a screenshot recorded intact, and replayed against a different one',
    run: ['python', 'agents/vision_agent.py'],
    needs: 'openai',
    exchanges: 1,
    /**
     * Two assertions the other checks cannot make, because none of them sends an image.
     *
     * `imageIntact` reads the trace and looks for the exact base64 the agent printed. The entropy
     * sweep used to shred it — 47,314 placeholders in one real browser-use run — and every one of
     * those was recorded in `redactions.json` as though a secret had been removed.
     *
     * `repaint` re-runs the agent with a different image, which is the only thing a browser can
     * do. The match must survive it, and must say that it did.
     */
    imageIntact: true,
    repaint: true,
  },
  {
    id: 'mastra',
    what: 'Mastra, whose model provider takes its origin in code rather than from the environment',
    adapter: 'node',
    run: ['node', 'agents/mastra_agent.mjs'],
    needsNode: '@mastra/core/agent',
    /**
     * Run from the agent's place in the repo rather than the copy in the temp directory.
     *
     * ESM resolves a bare specifier from the *importing file's* location, not from the working
     * directory, and `NODE_PATH` does not apply to it. A copy under the system temp directory
     * therefore cannot see `@mastra/core` however the environment is arranged. Running the
     * original leaves the recording where every other check puts it — the run directory follows
     * the working directory, which is still the temp one.
     */
    fromRepo: true,
    exchanges: 1,
  },
  {
    id: 'llama-index',
    what: "LlamaIndex's own OpenAI LLM, which reads the older base-URL variable and not the new one",
    run: ['python', 'agents/llama_index_agent.py'],
    needs: 'llama_index.llms.openai',
    exchanges: 1,
  },
  {
    id: 'mcp-stdio',
    what: 'an MCP server launched from a config, recorded and then taken away',
    run: ['python', 'agents/mcp_agent.py'],
    needs: ['mcp', 'openai'],
    exchanges: 1,
    /**
     * The layer with the most code behind it and, until this, no end-to-end check at all:
     * `mcp-shim` and `cli/src/mcp.ts` are ~1900 lines including their unit tests, and nothing
     * asserted that a recorded MCP session comes back.
     *
     * Named here rather than inferred, because the whole point is what the shim puts in the trace
     * that the proxy never saw: MCP rides OS pipes, so no base-URL variable reaches it.
     */
    mcp: 'agents/mcp_server.py',
    expectEvents: ['mcp.request', 'mcp.response'],
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

/** Everything a run wrote, events and spilled bodies alike — a large body is not in events.jsonl. */
async function traceText(runDir) {
  let text = await readFile(join(runDir, 'events.jsonl'), 'utf8');
  const blobs = join(runDir, 'blobs');
  for (const shard of await readdir(blobs).catch(() => [])) {
    for (const name of await readdir(join(blobs, shard))) {
      text += await readFile(join(blobs, shard, name), 'utf8');
    }
  }
  return text;
}

/**
 * Whether the framework this check speaks for is installed at all.
 *
 * An array where a check needs more than one thing. `openai-agents-handoff` is the case that made
 * this necessary: it needs the SDK *and* orca's tracing package, and with only the first it ran and
 * failed with "no agent.start in the trace" — which reads as a bug in the layer rather than as a
 * missing install.
 */
async function installed(needs) {
  if (needs === undefined) return undefined;
  for (const module of Array.isArray(needs) ? needs : [needs]) {
    try {
      await exec('python', ['-c', `import ${module}`], { timeout: 30_000 });
    } catch {
      return module;
    }
  }
  return undefined;
}

/**
 * The same question for a JS dependency.
 *
 * Resolved rather than imported: importing runs the package's top-level code, and a check that is
 * only asking whether something is present should not be able to fail because of what it does.
 */
function installedNode(specifier) {
  if (specifier === undefined) return true;
  try {
    createRequire(join(here, 'agents', 'x.mjs')).resolve(specifier);
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
    // Reaches the replayed agent too, which is how a check makes the replay behave differently
    // from the recording — the only way to test a match that is not byte equality.
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
    // `e.status` is `spawnSync`'s field and is always undefined here, so every failure reported
    // `-1` whatever the command actually did. `execFile` rejects with `code` — the exit status, or
    // a string like `ENOENT` when the process never started — plus `signal` when it was killed.
    //
    // `e.message` matters as much: a spawn that fails, a timeout, or a `maxBuffer` overrun all
    // reject with empty `stdout`/`stderr`, so without it the check reports a number and nothing
    // else, which is the one case where there is no other evidence to go on.
    const how = e.signal ? `${e.code ?? 'killed'} (${e.signal})` : (e.code ?? 'failed');
    // Not just the first line. `execFile`'s message is `Command failed: <argv>` followed by the
    // child's stderr — so taking one line keeps the part naming the command and drops the part
    // saying what went wrong, which is the whole reason for reading it.
    // And the *last* lines rather than the first. A Python traceback puts the exception at the
    // bottom and the frames above it; keeping the top means keeping `asyncio.run(main())` and
    // dropping the sentence that says what went wrong.
    const why = String(e.message ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('Command failed:'))
      .slice(-4)
      .join(' | ');
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      killed: e.killed === true,
      how: why === '' ? String(how) : `${how}: ${why}`,
    };
  }
}

/**
 * The last few lines of what a command said, for an error message that has to survive CI.
 *
 * `exited -1` on its own is unactionable: nobody can re-run the failing check by hand from a log,
 * and -1 is what `orca()` reports when the process was killed rather than exiting — a timeout, or
 * a signal — which is exactly the case where the output is the only evidence there is.
 */
function tail(out, lines = 6) {
  const kept = String(out ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-lines);
  return kept.length === 0 ? '' : `\n      ${kept.join('\n      ')}`;
}

async function runCheck(check) {
  const absent = await installed(check.needs);
  if (absent !== undefined) return { skipped: `${absent} is not installed` };
  if (!installedNode(check.needsNode)) return { skipped: `${check.needsNode} is not installed` };

  const dir = await mkdtemp(join(tmpdir(), `orca-int-${check.id}-`));
  const origin = await startOrigin();
  // A second stub, only for the checks that split their traffic across two origins of the same
  // wire dialect — the shape `--upstream-openai` cannot express, and the ordinary shape of a
  // retrieval stack.
  const second = check.secondOrigin ? await startOrigin() : undefined;
  try {
    await cp(join(here, 'agents'), join(dir, 'agents'), { recursive: true });

    const adapter = check.adapter ?? 'generic-openai';
    /**
     * The config an MCP-config-reading agent loads, and the file orca rewrites.
     *
     * `orca record --mcp-config` swaps each server's command for `<node> <shim> --out <frames> --
     * <original>`, so the shim sits in the pipe and tees every JSON-RPC frame both ways. Written
     * here pointing at the copy under `dir`, because the copy is what gets taken away before the
     * replay.
     */
    const mcpServer = check.mcp ? join(dir, ...check.mcp.split('/')) : undefined;
    const mcpConfig = join(dir, 'mcp.json');
    if (mcpServer !== undefined) {
      await writeFile(
        mcpConfig,
        `${JSON.stringify({ mcpServers: { probe: { command: check.run[0], args: [mcpServer] } } }, null, 2)}\n`,
      );
    }
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
        ...(mcpServer === undefined ? [] : ['--mcp-config', mcpConfig]),
        '--',
        ...(check.fromRepo
          ? [check.run[0], join(here, ...check.run.slice(1).join('/').split('/'))]
          : check.run),
      ],
      dir,
      splitEnv,
    );
    if (recorded.code !== 0)
      throw new Error(
        `record exited ${recorded.code} — ${recorded.how ?? 'no detail'}${tail(recorded.out)}`,
      );
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
      if (forked.code !== 0)
        throw new Error(
          `fork exited ${forked.code} — ${forked.how ?? 'no detail'}${tail(forked.out)}`,
        );
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

    if (check.imageIntact) {
      const sent = /^IMAGE: (\S+)$/m.exec(recorded.out)?.[1];
      if (sent === undefined) throw new Error('the agent did not print the image it sent');
      const trace = await traceText(join(dir, '.orca', 'runs', runId));
      // Byte for byte. A near-miss is the failure this exists for: the sweep replaced runs *inside*
      // the payload, so a substring check on the first hundred characters would have passed.
      if (!trace.includes(sent))
        throw new Error('the recorded image is not the image that was sent');
      const holes = trace.match(/<secret:high_entropy:/g)?.length ?? 0;
      if (holes > 0)
        throw new Error(
          `${holes} entropy placeholder(s) in a trace whose only high-entropy value is a PNG`,
        );
    }

    // From here the recording is on its own. Anything that reaches out now fails.
    origin.stop();
    second?.stop();
    // The MCP server is an origin too, and taking it away is the only way to tell a replay that
    // served the recorded frames from one that quietly started the server again. Renamed rather
    // than deleted so a failure says what is missing.
    if (mcpServer !== undefined) await rename(mcpServer, `${mcpServer}.gone`);

    const replayed = await orca(['replay', runId, '--in-place'], dir, {
      ...splitEnv,
      ...(check.repaint ? { ORCA_CHECK_REPAINT: '1' } : {}),
    });
    if (replayed.code !== 0)
      throw new Error(
        `replay exited ${replayed.code} — ${replayed.how ?? 'no detail'}${tail(replayed.out)}`,
      );

    const m = /reused=(\d+)\/(\d+) exact=(\d+) divergences=(\d+) unmatched=(\d+)/.exec(
      replayed.out,
    );
    if (m === null) throw new Error('replay printed no verdict');
    const [, reused, total, exact, divergences, unmatched] = m.map(Number);

    if (total !== check.exchanges)
      throw new Error(`recorded ${total} exchanges, wanted ${check.exchanges}`);
    if (reused !== total)
      throw new Error(`${total - reused} turn(s) could not be served from the recording`);
    if (unmatched !== 0) throw new Error(`${unmatched} unmatched`);

    if (check.repaint) {
      // The opposite assertion to every other check, and deliberately so. A repaint that came back
      // `exact` would mean the agent had not in fact changed its image, and the check would be
      // passing without testing anything. A repaint that came back silent would mean the matcher
      // folded the pixels away without saying so, which the spec forbids.
      if (exact !== 0)
        throw new Error(`${exact} turn(s) matched byte for byte despite the repaint`);
      if (divergences !== total)
        throw new Error(`${divergences} divergence(s) for ${total} repainted turn(s)`);
      if (!/pixels are not compared/.test(replayed.out))
        throw new Error('the replay did not say the pixels had been set aside');
      return { ok: `${total} exchange, image intact on disk, replayed against a repaint` };
    }

    if (exact !== total) throw new Error(`${exact}/${total} matched byte for byte`);
    if (divergences !== 0) throw new Error(`${divergences} divergence(s)`);

    /**
     * The claim this check exists for: the session reproduces with the server gone.
     *
     * Asserted on the agent's own output rather than on a count, because a count cannot tell a
     * served frame from a wrong one. The tool answers from its argument, so `VALUE-FOR-alpha` is
     * the recorded reply to the recorded call and nothing else.
     *
     * `replay.done`'s numbers say nothing here — they count model exchanges — so a broken MCP
     * replay would leave that line reading exactly as it does on success.
     */
    if (mcpServer !== undefined) {
      if (existsSync(mcpServer)) throw new Error('the MCP server was still there for the replay');
      if (!/MCP: VALUE-FOR-alpha/.test(replayed.out)) {
        throw new Error('the MCP session did not reproduce from the recording');
      }
      if (!/mode=replay/.test(replayed.out)) {
        throw new Error('the shim was not put in replay mode');
      }
    }

    // Event types a check insists on. Counting exchanges says the traffic was captured; it says
    // nothing about a layer whose whole purpose is what the traffic does not contain.
    if (check.expectEvents) {
      const listed = await orca(['events', '--json', runId], dir);
      const line = listed.out.split(/\r?\n/).find((l) => l.startsWith('['));
      const events = JSON.parse(line ?? '[]');
      const seen = new Set(events.map((e) => e.type));
      const missing = check.expectEvents.filter((t) => !seen.has(t));
      if (missing.length > 0) throw new Error(`no ${missing.join(', ')} in the trace`);
    }

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
      ok: `${total} exchanges${retrievalNote}, replayed exact with the origin down${check.forks ? ', forked live' : ''}${check.expectEvents ? `, ${check.expectEvents.length} of ${check.expectEvents[0].split('.')[0]}.* asserted` : ''}`,
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
