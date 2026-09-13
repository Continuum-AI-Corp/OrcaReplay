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
  // Who to ask about later. A sweep that finds this directory after orca is gone has no other way
  // to tell an abandoned transport from one a longer run is still appending to.
  await writeFile(join(transportDir, TRANSPORT_OWNER), String(process.pid), {
    mode: 0o600,
  }).catch(() => undefined);
  return { spansPath, pythonPath: dir, transportDir };
}

/** Prefixes of the transport directories orca mints, for {@link sweepStaleTransports}. */
const TRANSPORT_PREFIXES = ['orca-spans-', 'orca-shell-'];

/** Names the process that minted a transport, so a sweep can ask whether it is still running. */
export const TRANSPORT_OWNER = 'owner.pid';

/**
 * How long a transport nobody can account for must sit untouched before it is taken.
 *
 * Only ever consulted once the owner is unresolvable, so this is not a timeout on a recording —
 * it is the second opinion asked about a transport whose first opinion came back "no such process".
 */
const TRANSPORT_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * Remove transports that outlived the run that made them.
 *
 * The drain removes one, and `recordCommand` removes one whose run threw. Neither runs when orca
 * itself is killed — `SIGKILL`, a `taskkill`, a power cut — and then the directory stays, holding
 * every command line the agent ran, un-redacted, under a name nobody was ever shown. Deleting
 * harder at exit does not help, because nothing gets to run at exit; the only thing that can
 * collect an orphan is the next run.
 *
 * **Whose it is, not how old it is.** Age was the first answer and it was wrong: a transport
 * directory's mtime is set when `mkdtemp` creates it and never moves again, because everything
 * after that is an *append* to the one file inside, and appending does not touch the containing
 * directory. So "older than a day" meant "this recording started more than a day ago", and any
 * other `orca record` on the machine would collect the live transport of a recording still in
 * progress — after which that run silently captures nothing, because both writers swallow their
 * errors by design.
 *
 * **Two signals, and deletion needs both.** The owner's pid comes first: while it resolves to a
 * running process, nothing else matters. But a pid only means anything in the pid namespace it was
 * written in, and a temp directory can be shared across them — `/tmp` bind-mounted into a
 * devcontainer, a CI job with a shared tmp volume, an NFS `/tmp`. There the owner of a live
 * recording is simply absent from this process's pid table, and `ESRCH` is indistinguishable from
 * "it has exited". Reasoning that a pid fails safely is true of *reuse*, which leaves an orphan,
 * and false of *unresolvable*, which was deleting a run's transport mid-recording.
 *
 * So when the owner cannot be accounted for, the transport has to have been silent as well. The
 * mtime of the file inside is the right thing to read, and the directory's is not — appending moves
 * the file's and never the directory's, which is the mistake the version before this one made.
 *
 * What is deliberately not written is a start time alongside the pid. It would only be useful for
 * telling a reused pid from the original, and that needs the *other* process's start time, which
 * Node cannot portably read. A field nothing can act on is how payload gets into a file.
 *
 * The remaining gap, stated rather than papered over: a recording in a shared temp directory that
 * has captured nothing for a day would be collected. That needs an unresolvable owner *and* a day
 * of silence together, where either alone used to be enough.
 *
 * Best-effort throughout: a directory with no owner is left alone rather than guessed at, a
 * directory that cannot be read is somebody else's problem, and nothing here is ever fatal.
 *
 * `root` is a parameter so a test can sweep a directory of its own rather than the machine's, which
 * is also what makes `now` safe to vary — reaching forward in time inside somebody else's temp
 * directory is how an earlier test took the live transports of everything running beside it.
 */
export async function sweepStaleTransports(root = tmpdir(), now = Date.now()): Promise<number> {
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
      const owner = Number.parseInt(await readFile(join(path, TRANSPORT_OWNER), 'utf8'), 10);
      // No owner recorded: not one of ours, or one we cannot reason about. Either way, not ours to
      // delete.
      // `<= 0` is not tidiness: `process.kill(0, …)` addresses this process's whole group and
      // `-1` addresses every process a user may signal, so a malformed owner must never reach the
      // probe.
      if (!Number.isInteger(owner) || owner <= 0) continue;
      if (isRunning(owner)) continue;
      if (now - (await lastTouched(path)) < TRANSPORT_IDLE_MS) continue;
      await rm(path, { recursive: true, force: true });
      swept += 1;
    } catch {
      // Unreadable, in use, or already gone. None of those is this run's business.
    }
  }
  return swept;
}

/**
 * When anything in this transport was last written.
 *
 * The entries, not the directory: a frame is appended to the file inside, and appending moves that
 * file's mtime and leaves the directory's exactly where `mkdtemp` set it. Reading the directory's
 * was the previous version's mistake, and it meant "when this recording started".
 *
 * A directory that cannot be listed answers `now`, so it is treated as busy and left alone.
 */
async function lastTouched(dir: string, now = Date.now()): Promise<number> {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return now;
  }
  for (const entry of entries) {
    try {
      const { mtimeMs } = await stat(join(dir, entry.name));
      if (mtimeMs > newest) newest = mtimeMs;
    } catch {
      return now; // something is there that cannot be read; do not conclude it is abandoned
    }
  }
  return newest;
}

/**
 * Whether a process with this id exists.
 *
 * Signal `0` performs the permission and existence checks without delivering anything. `EPERM`
 * means it is there and belongs to somebody else, which still counts as running — the point is
 * never to delete a transport whose owner might still be writing to it.
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
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
