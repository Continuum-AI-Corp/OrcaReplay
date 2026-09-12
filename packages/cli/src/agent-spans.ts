import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Getting the OpenAI Agents SDK's own run structure into a trace, without editing the agent.
 *
 * A proxy sees `POST /v1/responses` and cannot tell which agent sent it, that a handoff occurred, or
 * that a guardrail ran at all. Measured on a two-agent run with both — the same script recorded
 * twice, once with this layer and once without:
 *
 *     which agent a turn belonged to        trace: no    spans: yes
 *     that a handoff happened, and from whom trace: no    spans: yes
 *     that a guardrail ran                   trace: no    spans: yes
 *
 * The handoff row is the sharp one. The SDK implements a handoff as a function tool named
 * `transfer_to_<agent>`, so a rule *could* guess one from the tool name — but a user tool may be
 * called that too, and the agent it came **from** never reaches the wire. `orca graph` already
 * separates what a trace records from what a rule infers; this moves handoffs into the first column.
 *
 * Installed the way the fetch hook is, and for the same reason: `sitecustomize.py` is imported by
 * Python at startup from anywhere on `sys.path`, so putting one directory on `PYTHONPATH` attaches
 * the layer to an agent nobody modified. Asking the user to call `set_trace_processors` would make
 * this the SDK wrapper the README says orca does not need.
 *
 * The file is self-contained and imports the published package by name, never this repository — it
 * runs inside the agent's interpreter, which resolves imports against its own environment. The
 * shell shim and the fetch hook are written out for the same reason.
 */

export const SPANS_ENV = 'ORCA_AGENT_SPANS';
export const SPANS_FILENAME = 'agent-spans.jsonl';
export const SITECUSTOMIZE = 'sitecustomize.py';

/**
 * The bootstrap, as it is written into the run directory.
 *
 * Every path through it ends in a return rather than a traceback. It runs before the agent's first
 * statement, in *every* Python process the recording starts — including `python --version` — so a
 * failure here is a failure of the run rather than of the capture. Absence of the package, absence
 * of the SDK and an SDK whose interface moved are all the same non-event.
 *
 * It also chains to whatever `sitecustomize` it displaced. Ours arrives via `PYTHONPATH` and so wins
 * over a site's or a virtualenv's own; silently disabling someone's startup hook to add a debugging
 * layer would be a poor trade.
 */
export const SITECUSTOMIZE_SOURCE = `# Written by \`orca record\`. Deleted with the run directory.
#
# Attaches OrcaReplay's tracing processor to the OpenAI Agents SDK without editing the agent.
# Inert unless ORCA_AGENT_SPANS is set, which only \`orca record\` does.
import os


def _chain():
    """Load whatever sitecustomize this one displaced, so no startup hook is lost."""
    import importlib.util
    import sys

    here = os.path.dirname(os.path.abspath(__file__))
    for entry in sys.path:
        try:
            if not entry or os.path.abspath(entry) == here:
                continue
            candidate = os.path.join(entry, "sitecustomize.py")
            if not os.path.isfile(candidate):
                continue
            spec = importlib.util.spec_from_file_location("_orca_prev_sitecustomize", candidate)
            if spec is None or spec.loader is None:
                continue
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        except Exception:
            pass
        return


def _install():
    if not os.environ.get("ORCA_AGENT_SPANS"):
        return
    try:
        from orcareplay_openai_agents import install
    except Exception:
        return
    try:
        install()
    except Exception:
        return


_chain()
_install()
`;

export interface AgentSpanCapture {
  /** Where the processor writes, and what the child is told. */
  spansPath: string;
  /** Prepended to PYTHONPATH so Python finds the bootstrap. */
  pythonPath: string;
}

/** Write the bootstrap into the run directory and say how to point a child at it. */
export async function installAgentSpans(runDir: string): Promise<AgentSpanCapture> {
  const dir = join(runDir, 'py');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SITECUSTOMIZE), SITECUSTOMIZE_SOURCE, 'utf8');
  const spansPath = join(runDir, SPANS_FILENAME);
  // Created here rather than left to the child, so it gets the mode SECURITY.md promises for
  // everything in a run directory — "trace files and blobs are written mode 0600". A file the
  // child creates gets that interpreter's umask instead, and the two capture layers that already
  // leave a side file here both pre-create it for the same reason (`shell-shim`'s frames,
  // `mcp.ts`'s config). Best-effort, like theirs: a capture layer may degrade a trace and may
  // never fail the run it is watching.
  await writeFile(spansPath, '', { flag: 'a', mode: 0o600 }).catch(() => undefined);
  return { spansPath, pythonPath: dir };
}

/**
 * Remove the spans file once its contents are in the trace.
 *
 * It is a transport, not part of the trace: one reader, during the drain, and nothing in replay,
 * fork or the viewer touches it. Leaving it would make it the one thing in a run directory that no
 * other machinery covers — `orca scrub` rewrites `events.jsonl`, the manifest and the blobs and
 * would report `removed=N` with this file untouched beside them, which SECURITY.md calls worse than
 * having no scrubber at all. Deleting it is cheaper and more honest than teaching three other
 * components about a file that has no reason to outlive the ingest.
 *
 * Returns what went wrong, for the caller to warn about. Failing to delete it is worth saying and
 * never worth losing the trace over — the same posture as the run CA's `dispose`.
 */
export async function discardAgentSpans(path: string): Promise<string | undefined> {
  const failures: string[] = [];
  // The whole set, not just the base: one file per tracing process, and leaving any of them behind
  // leaves the same uncovered file in the run directory that this exists to remove.
  for (const file of await spansFiles(path)) {
    try {
      await rm(file, { force: true });
    } catch (err) {
      failures.push(String(err));
    }
  }
  return failures.length === 0 ? undefined : failures.join('; ');
}

/** PYTHONPATH with our directory in front, keeping whatever was already there. */
export function pythonPathWith(dir: string, existing: string | undefined, sep: string): string {
  const parts = (existing ?? '').split(sep).filter((p) => p !== '');
  // Ours first so the bootstrap is found; theirs kept so nothing they rely on stops resolving.
  return [dir, ...parts.filter((p) => p !== dir)].join(sep);
}

/** One span, as the processor writes it. */
export interface AgentSpan {
  kind: string;
  type?: string;
  span_id?: string;
  parent_id?: string;
  trace_id?: string;
  started_at?: string;
  ended_at?: string;
  error?: unknown;
  data?: Record<string, unknown>;
}

/**
 * Read what the processor wrote.
 *
 * A malformed line is skipped rather than thrown on: the file is appended to by another process
 * that may have been killed mid-write, and losing the last span is a much better outcome than
 * failing to seal a trace that is otherwise complete.
 *
 * "Malformed" has to mean more than "does not parse". `null` is valid JSON and is exactly what a
 * producer writes as its could-not-serialise fallback, and it used to reach `eventForSpan`, which
 * dereferenced it — one such line took the whole run down and left the trace unsealed. So a line
 * is kept only if it parsed to an object.
 */
export async function readAgentSpans(path: string): Promise<AgentSpan[]> {
  const spans: AgentSpan[] = [];
  for (const file of await spansFiles(path)) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      // No file means the SDK was never used, or the package is not installed. Both are ordinary.
      continue;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        spans.push(parsed as AgentSpan);
      }
    }
  }
  return spans;
}

/**
 * Every file the processors wrote: `<base>` and `<base>.<pid>`.
 *
 * One process per file, because the whole environment — `PYTHONPATH` and the variable naming this
 * path — is inherited by everything the agent starts, so an agent that shells out to `python`, or
 * runs `pytest -n` or a worker pool, has several tracing at once. Serialising them would need
 * `fcntl` on one platform and `msvcrt` on the other; a file each needs neither.
 *
 * `<base>` itself is still read. It is what `installAgentSpans` pre-creates for the mode, and it is
 * where a processor that predates the per-pid split would have written.
 */
async function spansFiles(base: string): Promise<string[]> {
  const dir = dirname(base);
  const prefix = `${basename(base)}.`;
  let siblings: string[] = [];
  try {
    siblings = (await readdir(dir))
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dir, name))
      .sort();
  } catch {
    // The run directory is gone, which is not this layer's problem to report.
  }
  return [base, ...siblings];
}

/** How many records a processor said it had to throw away. Zero unless one told us. */
export function droppedSpanCount(spans: AgentSpan[]): number {
  let total = 0;
  for (const span of spans) {
    if (span.kind !== 'dropped') continue;
    const count = (span as { count?: unknown }).count;
    if (typeof count === 'number' && Number.isFinite(count)) total += count;
  }
  return total;
}

/**
 * A trace event, or undefined for a span that carries nothing the proxy lacks.
 *
 * Takes `unknown` rather than `AgentSpan` on purpose. The only caller reads a file another process
 * appends to, so the type is a description of what is expected rather than a guarantee, and a
 * translator that trusts it is one bad line away from ending the run it was watching.
 */
export function eventForSpan(
  value: unknown,
): { type: string; attrs: Record<string, unknown> } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const span = value as AgentSpan;
  if (span.kind !== 'span') return undefined;
  const data = span.data ?? {};
  const at = span.started_at === undefined ? {} : { started_at: span.started_at };

  switch (span.type) {
    case 'AgentSpanData':
      return {
        type: 'agent.start',
        attrs: {
          name: String(data['name'] ?? 'unknown'),
          // Joined rather than nested: `attrs` values are scalars everywhere else in the format,
          // and a reader that prints them should not have to special-case one event type.
          handoffs: Array.isArray(data['handoffs']) ? data['handoffs'].join(',') : undefined,
          tools: Array.isArray(data['tools']) ? data['tools'].length : undefined,
          output_type: data['output_type'] === undefined ? undefined : String(data['output_type']),
          ...at,
        },
      };
    case 'HandoffSpanData':
      return {
        type: 'agent.handoff',
        attrs: {
          from: String(data['from_agent'] ?? 'unknown'),
          to: String(data['to_agent'] ?? 'unknown'),
          ...at,
        },
      };
    case 'GuardrailSpanData':
      return {
        type: 'agent.guardrail',
        attrs: {
          name: String(data['name'] ?? 'unknown'),
          triggered: data['triggered'] === true,
          ...at,
        },
      };
    default:
      // Turn, Task, Custom, Speech and the rest describe structure the timeline already shows, or
      // belong to pipelines this layer does not claim to cover. Dropping them keeps the trace to
      // what it could not otherwise have known.
      return undefined;
  }
}
