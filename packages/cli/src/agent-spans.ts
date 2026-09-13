import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  /** The directory holding {@link spansPath}, for {@link discardAgentSpanTransport}. */
  transportDir: string;
}

/**
 * Write the bootstrap into the run directory and say how to point a child at it.
 *
 * The spans file is **not** in the run directory, and that is the point. It is a transport: orca
 * reads it once, turns what it needs into events, and those go to disk through `TraceWriter`, which
 * redacts. The file itself is written by the agent's own interpreter, so nothing orca owns can
 * redact it on the way in — and while it sat in the run directory that made it a sink the write path
 * never touched, `orca scrub` never rewrote (it reaches `events.jsonl`, the manifest and the blobs,
 * and nothing else), and nobody deleted, in a directory people share. `orca scrub --match <secret>`
 * over such a run printed "nothing matched — the trace is unchanged" with the secret still beside
 * the trace, which is the one failure mode SECURITY.md says a scrubber must not have.
 *
 * Somewhere orca owns fixes it. `mkdtemp` gives a directory only this user can enter, with a name
 * nobody can guess ahead of it, and {@link discardAgentSpanTransport} takes the whole thing away
 * when the run is done. The file is pre-created here rather than left to the child, so it carries
 * the 0600 SECURITY.md promises instead of whatever the agent's umask happens to be — the same thing
 * the shell shim does with its frames file, for the same reason.
 */
export async function installAgentSpans(runDir: string): Promise<AgentSpanCapture> {
  const dir = join(runDir, 'py');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SITECUSTOMIZE), SITECUSTOMIZE_SOURCE, 'utf8');
  const transportDir = await mkdtemp(join(tmpdir(), 'orca-spans-'));
  const spansPath = join(transportDir, SPANS_FILENAME);
  // Best-effort: an unwritable transport must not stop the run, and the child creating it instead
  // still lands inside a directory only this user can enter.
  await writeFile(spansPath, '', { flag: 'a', mode: 0o600 }).catch(() => undefined);
  return { spansPath, pythonPath: dir, transportDir };
}

/** Prefixes of the transport directories orca mints, for {@link sweepStaleTransports}. */
const TRANSPORT_PREFIXES = ['orca-spans-', 'orca-shell-'];

/** A transport older than this was left by a run that is not coming back. */
const STALE_TRANSPORT_MS = 24 * 60 * 60 * 1000;

/**
 * Remove transports that outlived the run that made them.
 *
 * The drain removes one, and `recordCommand` removes one whose run threw. Neither runs when orca
 * itself is killed — `SIGKILL`, a `taskkill`, a power cut — and then the directory stays, holding
 * every command line the agent ran, un-redacted, under a name nobody was ever shown. Deleting
 * harder at exit does not help, because nothing gets to run at exit; the only thing that can
 * collect an orphan is the next run.
 *
 * A day old, so this can never take a transport out from under a run that is still going. A
 * recording that has lasted more than a day *and* has not written a shell frame in the last day
 * would be swept, which is the one case this gets wrong, and it gets it wrong by deleting a
 * transport whose run has nothing in it.
 *
 * Best-effort throughout: a temp directory that cannot be read, or an entry that cannot be removed,
 * is somebody else's problem and never this run's.
 *
 * `root` is a parameter so a test can sweep a directory of its own. It matters more than it looks:
 * with only `now` to vary, a test that reaches forward in time sweeps every transport on the
 * machine, including the live ones belonging to whatever else is running — which is exactly what
 * happened, and the suite caught it.
 */
export async function sweepStaleTransports(now = Date.now(), root = tmpdir()): Promise<number> {
  let swept = 0;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!TRANSPORT_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    const path = join(root, entry.name);
    try {
      const age = now - (await stat(path)).mtimeMs;
      if (age < STALE_TRANSPORT_MS) continue;
      await rm(path, { recursive: true, force: true });
      swept += 1;
    } catch {
      // Another user's, or in use, or already gone. None of those is this run's business.
    }
  }
  return swept;
}

/**
 * Take the transport away once it has been read.
 *
 * The directory, not the file: the whole point of minting one was that nothing else is in it, and
 * removing the directory also takes anything a stray writer created beside the file after the drain.
 * Returns a message rather than throwing — a run that produced a trace must not fail at teardown.
 */
export async function discardAgentSpanTransport(dir: string): Promise<string | undefined> {
  try {
    await rm(dir, { recursive: true, force: true });
    return undefined;
  } catch (err) {
    return String(err);
  }
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
 */
export async function readAgentSpans(path: string): Promise<AgentSpan[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // No file means the SDK was never used, or the package is not installed. Both are ordinary.
    return [];
  }
  const spans: AgentSpan[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      spans.push(JSON.parse(line) as AgentSpan);
    } catch {
      continue;
    }
  }
  return spans;
}

/** A trace event, or undefined for a span that carries nothing the proxy lacks. */
export function eventForSpan(
  span: AgentSpan,
): { type: string; attrs: Record<string, unknown> } | undefined {
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
