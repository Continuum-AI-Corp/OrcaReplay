import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import {
  assertPrivatePathIdentity,
  privatePathIdentity,
  removePrivateDirectory,
  restrictToOwner,
} from '@orcareplay/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_RECORD_START, objectsOnLine } from '@orcareplay/mcp-shim';
import { EARLIEST_TS_MS, LATEST_TS_MS } from '@orcareplay/schema';

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

/** A Python framework whose own run structure orca can read, and the package that reads it. */
export interface PythonAdapter {
  /** The framework, as `importlib.metadata` names the distribution that provides it. */
  distribution: string;
  /** The top-level module the agent imports to use it, which is how the bootstrap notices it. */
  root: string;
  /** The adapter's import name, for the bootstrap's `from … import install`. */
  module: string;
  /** The adapter's distribution name, as `pip install` takes it. */
  package: string;
  /** What the trace goes without when the framework is used and the adapter is not there. */
  lost: string;
}

/**
 * Every adapter the bootstrap installs — one declaration, three consumers.
 *
 * The bootstrap's Python is generated from this, {@link agentSpanLosses} reports against it, and
 * the drain's warning reads its prose from it. Adding a row is the whole of adding an adapter to
 * the record path, and nothing can be added to one of the three and forgotten in the others.
 *
 * They share a transport file on purpose. The reader recovers a record from a torn line by finding
 * `{"kind":` in it, which is a property of the writers rather than of the file, so a second writer
 * costs nothing; a second file would cost a second environment variable, a second drain and a
 * second entry in the stale-transport sweep.
 */
export const PYTHON_ADAPTERS: readonly PythonAdapter[] = [
  {
    distribution: 'openai-agents',
    root: 'agents',
    module: 'orcareplay_openai_agents',
    package: 'orcareplay-openai-agents',
    lost: 'the agents, handoffs and guardrails only it can see',
  },
  {
    distribution: 'langgraph',
    root: 'langgraph',
    module: 'orcareplay_langgraph',
    package: 'orcareplay-langgraph',
    lost: 'which node produced which call, and the nodes that call no model at all',
  },
];

/**
 * One adapter's stanza inside the bootstrap's `_install`.
 *
 * Written out per adapter rather than looped over a list, because the import has to be a literal
 * `from … import install` statement: `__import__(name)` would work, and would leave the file with
 * no readable statement of what it attaches to. This runs on someone else's machine, in front of
 * their interpreter, and it should be possible to read it and see exactly that.
 *
 * `else` rather than a bare sequence, so an adapter whose `install` raises is not reported as one
 * that is missing — a package that is present and broken sends the operator somewhere different
 * from one that was never installed.
 */
function installBlock({ module, root, distribution, package: pkg }: PythonAdapter): string {
  return `    try:
        from ${module} import install as _${module}
    except Exception:
        missing["${root}"] = ("${distribution}", "${pkg}")
    else:
        try:
            _${module}()
        except Exception:
            pass
`;
}

/**
 * The bootstrap, as it is written into the run directory.
 *
 * Every path through it ends in a return rather than a traceback. It runs before the agent's first
 * statement, in *every* Python process the recording starts — including `python --version` — so a
 * failure here is a failure of the run rather than of the capture. Absence of an adapter, absence
 * of the framework and a framework whose interface moved are all the same non-event.
 *
 * The adapters come from {@link PYTHON_ADAPTERS}, so adding one is a row in that list rather than
 * an edit to this string.
 *
 * It also chains to whatever `sitecustomize` it displaced. Ours arrives via `PYTHONPATH` and so wins
 * over a site's or a virtualenv's own; silently disabling someone's startup hook to add a debugging
 * layer would be a poor trade.
 */
export const SITECUSTOMIZE_SOURCE = `# Written by \`orca record\`. Deleted with the run directory.
#
# Attaches OrcaReplay's adapters to the agent frameworks on this interpreter, without editing the
# agent. Inert unless ORCA_AGENT_SPANS is set, which only \`orca record\` does.
import os
import sys


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


def _unavailable(path, distribution, package):
    """Record that a framework was used and its adapter was not there — the case worth reporting.

    Without this, a run whose agent uses the framework on a machine without the adapter is
    byte-identical to one that never used it: the same \`recorded ... exit=0\`, no structural
    events, no warning.

    **The confirmation is about the distribution, not the import name.** The caller has only seen
    a module *name* being imported, and \`agents.py\` is an ordinary name for an ordinary module —
    measured: a project with its own two-line \`agents.py\` and \`PYTHONPATH=.\`, on a machine with
    no SDK at all, was told "the agent imported the OpenAI Agents SDK" and sent to install a
    package it has no use for. \`importlib.metadata\` asks which *distribution* provides that name,
    which is what "the framework is here" actually means.

    Metadata rather than importing, and rather than probing a submodule. Measured on this machine:
    \`distribution("openai-agents")\` 2.3ms, and \`find_spec("agents.tracing")\` **2066ms** —
    resolving a submodule spec imports the parent, so the specific-looking option costs the same as
    the import it was avoiding.
    """
    import importlib.metadata

    try:
        importlib.metadata.distribution(distribution)
    except Exception:
        return  # a module that merely shares the name: nothing was lost here
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write('{"kind": "unavailable", "package": "' + package + '"}\\n')
    except Exception:
        return


class _WhenImported:
    """Report a missing adapter if, and only if, the agent imports the framework it is for.

    Asking \`importlib.metadata\` at startup instead would answer a different question — is the
    framework *installed* — and on an ordinary machine that is yes for frameworks the run never
    touches. One venv here has both langgraph and openai-agents, so every recorded run in it would
    be told to install two adapters it has no use for, and the count grows with every adapter orca
    ships. A warning that fires when nothing is wrong is how warnings stop being read.

    Installed only for the adapters that were *not* importable, so a fully equipped machine carries
    nothing, and it takes itself off \`sys.meta_path\` once there is nothing left to watch for.
    Every path returns None: it never claims a module, and the ordinary finders load the framework
    exactly as they would have.
    """

    def __init__(self, path, missing):
        self._path = path
        self._missing = missing

    def find_spec(self, fullname, path=None, target=None):
        try:
            found = self._missing.pop(fullname.partition(".")[0], None)
            if not self._missing:
                try:
                    sys.meta_path.remove(self)
                except ValueError:
                    pass
            if found is not None:
                _unavailable(self._path, found[0], found[1])
        except Exception:
            pass
        return None


def _install():
    """Attach every adapter that is here, and watch for the frameworks whose adapter is not.

    One environment read for all of them, and each guarded on its own: an adapter that is absent,
    or whose \`install\` raises, must not stop the next from attaching. \`else\` rather than a bare
    sequence, so an adapter that is present and broken is not reported as one that is missing —
    those send the operator somewhere different.
    """
    path = os.environ.get("ORCA_AGENT_SPANS")
    if not path:
        return
    missing = {}
${PYTHON_ADAPTERS.map(installBlock).join('\n')}    if missing:
        try:
            sys.meta_path.insert(0, _WhenImported(path, missing))
        except Exception:
            pass


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
  const was = process.platform === 'win32' ? await privatePathIdentity(transportDir) : undefined;
  // Narrowed before the first write, for the reason the comment above no longer gets to assume:
  // `mkdtemp` gives a directory only this user can enter on POSIX, and on Windows gives whatever
  // `%TEMP%` hands down. `icacls` does not re-propagate, so this has to happen before `spansPath`
  // and the owner file exist, not after. A failure here fails the install, and the caller degrades
  // to no agent-span capture rather than writing into a directory it cannot vouch for.
  try {
    // Windows only: `mkdtemp` already creates 0700 on POSIX, so there the call can only
    // fail — on a filesystem without permissions it would abort a recording that main
    // completed. On Windows the mode is discarded and this is the whole protection.
    if (was) {
      await restrictToOwner(transportDir, 0o700);
      await assertPrivatePathIdentity(transportDir, was);
      await writeFile(join(transportDir, TRANSPORT_OWNER), String(process.pid), {
        mode: 0o600,
        flag: 'wx',
      });
      await assertPrivatePathIdentity(transportDir, was);
    }
  } catch (err) {
    if (was) await removePrivateDirectory(transportDir, was);
    throw err;
  }
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
 * How often a run reasserts that its transports are not abandoned.
 *
 * Anything comfortably inside {@link TRANSPORT_IDLE_MS} does, and the margin is the point rather
 * than the exact number: a beat is one `utimes`, so beating far more often than strictly necessary
 * costs nothing, and it means a machine busy enough to drop a run of them still cannot make a live
 * recording look idle for a day.
 */
const TRANSPORT_HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Say, for as long as this run lasts, that its transports are not orphans.
 *
 * {@link sweepStaleTransports} asks two questions and only deletes when both say abandoned. The
 * second one — has anything in there been written in the last day — is the one that had to stand
 * alone whenever the first could not be answered, which is the shared-temp-directory case: `/tmp`
 * bind-mounted into a devcontainer, a CI job with a shared tmp volume, an NFS `/tmp`. And silence
 * is not evidence of abandonment, because a transport is only written when a span *ends* or the
 * agent *runs a command*. An agent that spends a day on one model turn, or on one long command,
 * writes nothing for a day while being entirely alive.
 *
 * The consequence was not a stale directory: the next `orca record` anywhere on that machine would
 * delete a live run's transport, and both writers swallow the `ENOENT` that follows by design
 * (`shell-shim/src/runner.ts`, `processor.py`). Every remaining frame and span would be lost
 * without a word, the trace would still report success, and `shell.ineffective` would go on to
 * blame the harness for commands orca itself had deleted the evidence of.
 *
 * A heartbeat answers the question instead of widening the window it is asked in. While the owner
 * lives it keeps saying so, in the one way a sweep in another pid namespace can still read; an
 * orphan stops saying it the moment its owner dies, so the collection the sweep exists for is
 * untouched. It is the owner file that gets touched, because that is the one entry that exists from
 * the moment the transport does.
 *
 * `dirs` is read on every beat rather than copied, so a transport installed part-way into a run is
 * covered from the next beat without the caller having to say so. Stopping is the caller's job and
 * belongs on every exit path; the timer is `unref`ed as well, so that a stop missed on some future
 * path can still never be what holds the process open — the hang `record-teardown.test.ts` exists
 * to catch.
 */
export function touchTransports(
  dirs: readonly string[],
  everyMs: number = TRANSPORT_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    const at = new Date();
    for (const dir of dirs) {
      // Best-effort, like everything else about a transport: one that has already been taken away
      // is not this run's problem, and a heartbeat must never be what fails a recording.
      utimes(join(dir, TRANSPORT_OWNER), at, at).catch(() => undefined);
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

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
 * Two gates left one gap between them, and {@link touchTransports} closes it rather than accepting
 * it: a recording in a shared temp directory that captured nothing for a day satisfied both at
 * once, and a day of silence is what an agent thinking about one long turn looks like. Its owner
 * now refreshes the transport for as long as the run lasts, so reaching this line means the owner
 * has stopped saying anything, not that the agent had nothing to say.
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
  // The third transport, and the same two rules as the other two. Every Python process the run
  // starts appends to this file — the processor's lock is per-process — so a short write leaves a
  // fragment with the next process's bytes on the end of it, and `objectsOnLine` is what gets the
  // whole span back out of such a line rather than dropping both.
  //
  // And a line that parses is not yet a span. `eventForSpan` reads `.kind` off whatever it is
  // handed, so a line that parsed to `null` threw there — in the drain, after the agent has
  // exited, which is where the trace is being sealed. `recordCommand` catches that, disposes of
  // the transport, and rethrows: the run ends with no `run.end`, `verifyIntegrity` calls it
  // tampered with, and the spans that were never read are gone with the transport.
  for (const parsed of raw.split('\n').flatMap((line) => objectsOnLine(line, SPAN_START))) {
    const span = parsed as unknown as AgentSpan;
    // And the third rule the other two transports apply, for the same reason and with the same
    // consequence. The drain builds `new Date(Date.parse(String(span.started_at ?? span.ended_at ??
    // '')))` and hands it to `TraceWriter.append` as `occurredAt`; `Date.parse` accepts instants a
    // `date-time` cannot write down, and `assertEvent` then throws where the trace is being sealed
    // — after `discardAgentSpanTransport` has already taken the file, so the run ends with no
    // `run.end` and every span it recorded is gone. Exactly the drain's own expression, so the two
    // cannot disagree about what parses — including the fallback, which is what a record that
    // closes something carries instead.
    //
    // Absent or unparseable is kept, as in the siblings: the drain drops `occurredAt` for those
    // and stamps from its own clock, which degrades a field rather than losing a handoff.
    const startedMs = Date.parse(String(span.started_at ?? span.ended_at ?? ''));
    if (!Number.isNaN(startedMs) && (startedMs < EARLIEST_TS_MS || startedMs > LATEST_TS_MS)) {
      continue;
    }
    spans.push(span);
  }
  return spans;
}

/**
 * Where every span record on a line begins.
 *
 * `processor.py` builds each record with `kind` first and `json.dumps` keeps insertion order —
 * `agent-spans.test.ts` pins that against the real thing. The trailing space `json.dumps` writes
 * after a colon comes *after* these bytes, so the same string matches what both writers produce.
 */
const SPAN_START = '{"kind":';

/**
 * What this layer captured nothing of, and why — the two ways it can come back empty.
 *
 * Both are read off the same records `readAgentSpans` already returns, because both are written by
 * the only two things that know: the bootstrap, which finds out at import time that the adapter is
 * missing, and the processor, which is the only party that saw the record it could not write.
 *
 * `eventForSpan` ignores them — it answers only to `kind === 'span'` — so neither reaches the trace
 * as an event. They are for the operator, now, while the run is still on screen.
 */
export interface AgentSpanLosses {
  /** The framework was used and its adapter was not there, so nothing structural was captured. */
  unavailable: string[];
  /** Records an adapter held and could not write: unserialisable, or the append failed. */
  dropped: number;
  /**
   * Which adapters reported those drops, for the records that said.
   *
   * The count alone stopped being actionable when there was more than one adapter: several write
   * to one transport, so a total says how much was lost and nothing about where to look. Read
   * rather than merely written — `_dropped` in the first adapter was counted from the start and
   * read by nothing, which is how a field becomes payload.
   */
  droppedBy: string[];
}

export function agentSpanLosses(spans: AgentSpan[]): AgentSpanLosses {
  const unavailable = new Set<string>();
  const droppedBy = new Set<string>();
  let dropped = 0;
  for (const span of spans) {
    if (span.kind === 'unavailable') {
      // Deduplicated by package name: the bootstrap runs in every Python process the recording
      // starts, so an agent that shells out to `python` writes this once per child. Six lines
      // saying the same thing is one fact, and reporting it six times reads like six failures.
      const pkg = (span as { package?: unknown }).package;
      // The fallback is the first adapter rather than a name spelled out here, because a record
      // with no `package` can only have come from a bootstrap older than the field — which is the
      // version that had exactly one adapter.
      unavailable.add(
        typeof pkg === 'string' && pkg !== '' ? pkg : (PYTHON_ADAPTERS[0]?.package ?? 'unknown'),
      );
    } else if (span.kind === 'dropped') {
      // Summed rather than taken: one `dropped` line per process, same as above, and here the
      // counts are of different records so they add rather than collapse.
      const count = (span as { count?: unknown }).count;
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) dropped += count;
      // Optional: the first adapter's records predate the field, and a loss reported without a
      // name is still a loss worth counting.
      const pkg = (span as { package?: unknown }).package;
      if (typeof pkg === 'string' && pkg !== '') droppedBy.add(pkg);
    }
  }
  return { unavailable: [...unavailable].sort(), dropped, droppedBy: [...droppedBy].sort() };
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
    // A LangGraph superstep, which the wire has no representation of at all. A node's name is not
    // in any request, a node that calls no model makes no request, and two nodes in one parallel
    // superstep are indistinguishable from two consecutive turns.
    case 'LangGraphNodeStart':
      return {
        type: 'graph.node.start',
        attrs: {
          node: String(data['node'] ?? 'unknown'),
          // The superstep is per graph, so two records can share one without being concurrent.
          // `parent` is what separates those, and it is the only reason the pair is useful.
          step: typeof data['step'] === 'number' ? data['step'] : undefined,
          run_id: span.span_id,
          parent_run_id: span.parent_id,
          ...at,
        },
      };
    case 'LangGraphNodeEnd':
      return {
        type: 'graph.node.end',
        attrs: {
          node: String(data['node'] ?? 'unknown'),
          step: typeof data['step'] === 'number' ? data['step'] : undefined,
          run_id: span.span_id,
          // The exception's class, never its message: the adapter has no redactor in front of it,
          // and a node's exception text is whatever it was handed.
          error: data['error'] === undefined ? undefined : String(data['error']),
          ended_at: span.ended_at,
        },
      };
    default:
      // Turn, Task, Custom, Speech and the rest describe structure the timeline already shows, or
      // belong to pipelines this layer does not claim to cover. Dropping them keeps the trace to
      // what it could not otherwise have known.
      return undefined;
  }
}
