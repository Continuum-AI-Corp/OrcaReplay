import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises';
// Namespaced as well as named, because `statfs` is not present on every supported node build and
// a missing named import from a builtin is a load-time error for the whole CLI.
import * as fsPromises from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { defaultAdapters } from '@orcareplay/adapters';
import { listRuns, orcaDir } from '@orcareplay/core';
import { runGit } from '@orcareplay/fs-capture';
import { installShellShim, readShellFrames } from '@orcareplay/shell-shim';
import type { ParsedArgs } from '../args.js';
import { RENDER_DEPS, missingRenderDeps } from '../rasterize.js';
import type { Output } from '../out.js';
import { formatBytes, runDirBytes } from './gc.js';
import { shimIsRunnable } from '../mcp.js';

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** What to do about it. Mandatory in spirit for anything that is not ok. */
  fix?: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean;
}

const MIN_NODE_MAJOR = 20;
const LOW_DISK_BYTES = 512 * 1024 * 1024;
const BIG_STORE_BYTES = 1024 * 1024 * 1024;

/**
 * `orca doctor` — will recording actually work here?
 *
 * Orca instruments an agent by putting environment variables in front of someone else's process
 * and shelling out to git. When that goes wrong the symptom appears inside the agent, minutes
 * later, as something that looks like the agent's fault. Every check here is one of those failure
 * modes, answered before the user spends an hour on it — so each is exercised for real (a port is
 * actually bound, a file is actually written) rather than inferred.
 */
export async function doctorCommand(
  args: ParsedArgs,
  out: Output,
  cwd = process.cwd(),
): Promise<DoctorResult> {
  const git = await checkGit();
  const writable = await checkWritable(cwd);

  const checks: DoctorCheck[] = [
    checkNode(),
    git.check,
    await checkWorkspace(cwd, git.available),
    writable.check,
    await checkAgents(cwd),
    await checkPort(),
    await checkShellShim(),
    await checkMcpShim(),
    await checkRasteriser(),
    await checkDisk(writable.probeDir),
    await checkRuns(cwd),
  ];

  const failed = checks.filter((c) => c.status === 'fail');
  const warned = checks.filter((c) => c.status === 'warn');
  const ok = failed.length === 0;

  out.table(
    ['CHECK', 'STATUS', 'DETAIL'],
    checks.map((c) => [c.name, c.status, c.detail]),
  );

  const trouble = [...failed, ...warned];
  out.plain('');
  if (trouble.length === 0) {
    out.plain('  all clear — orca record <agent> should work here');
  } else {
    for (const check of trouble) {
      out.plain(`  ${check.status} ${check.name}: ${check.fix ?? check.detail}`);
    }
  }

  out.phase('doctor', { ok, checks: checks.length, failed: failed.length, warned: warned.length });
  return { checks, ok };
}

function checkNode(): DoctorCheck {
  const name = 'node version';
  // Read at call time, never cached: the running version is the thing under test.
  const version = process.version;
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? Number.NaN);
  if (Number.isNaN(major)) {
    return {
      name,
      status: 'warn',
      detail: `cannot read a major version from ${version}`,
      fix: `run orca on node ${MIN_NODE_MAJOR} or newer`,
    };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      name,
      status: 'fail',
      detail: `${version} — orca needs node ${MIN_NODE_MAJOR} or newer`,
      fix: `install node ${MIN_NODE_MAJOR}+ (nvm install ${MIN_NODE_MAJOR}) and run orca doctor again`,
    };
  }
  return { name, status: 'ok', detail: version };
}

/**
 * Two capture layers that fail quietly.
 *
 * Both are shims — a PATH entry in front of `sh`/`bash`, and a rewritten MCP config launching a
 * JSON-RPC tee. When either cannot start, nothing goes wrong that anybody sees: the agent runs
 * perfectly, the run succeeds, and the trace is missing a layer, which you discover only when you
 * go looking for an exit code or a tool call that was never recorded. That is exactly the class of
 * failure `doctor` exists to move forward in time, so both are exercised for real rather than
 * inferred from a file existing.
 */
async function checkShellShim(): Promise<DoctorCheck> {
  const name = 'shell shim';
  const dir = await mkdtemp(join(tmpdir(), 'orca-doctor-shim-'));
  try {
    const shim = await installShellShim({ runDir: dir });
    // Run something through it, rather than trusting that writing the scripts was enough: the
    // failure this catches is the compiled runner being absent from an installed package.
    const { stdout } = await execFileAsync('sh', ['-c', 'printf ok'], {
      env: { ...process.env, PATH: `${shim.dir}${delimiter}${process.env.PATH ?? ''}` },
    });
    if (stdout.trim() !== 'ok') {
      return {
        name,
        status: 'warn',
        detail: `the shim ran but returned ${JSON.stringify(stdout)}`,
        fix: 'record with --no-shell; exit codes and timing will be missing from the trace',
      };
    }
    const frames = await readShellFrames(shim.framesPath);
    if (frames.length === 0) {
      return {
        name,
        status: 'warn',
        detail: 'commands pass through but nothing is captured',
        fix: 'record with --no-shell rather than trusting a layer that records nothing',
      };
    }
    return { name, status: 'ok', detail: `${shim.shimmed.join(', ')} — captured a test command` };
  } catch (err) {
    return {
      name,
      status: 'warn',
      detail: String(err instanceof Error ? err.message : err).split('\n')[0] ?? 'unavailable',
      fix: 'run `npm run build` if working from source, or record with --no-shell',
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function checkMcpShim(): Promise<DoctorCheck> {
  const name = 'mcp shim';
  const runnable = await shimIsRunnable();
  return runnable
    ? { name, status: 'ok', detail: 'runnable — pass --mcp-config <path> to use it' }
    : {
        name,
        status: 'warn',
        detail: 'the shim entry point cannot be launched',
        fix: 'run `npm run build` if working from source; MCP calls will not be captured without it',
      };
}

/** Through fs-capture's own runner, so this tests the git invocation recording will really make. */
/**
 * Whether a card can be written as a PNG or a GIF.
 *
 * Never a failure. The raster toolchain is optional by design — `docs/media/README.md` keeps it
 * out of `package.json` so `npm ci` stays lean — and recording, replaying and SVG cards all work
 * without it. Reporting it is how someone finds out before they need it rather than at the moment
 * they ask for a `.png`.
 */
async function checkRasteriser(): Promise<DoctorCheck> {
  const name = 'card rasteriser';
  const missing = await missingRenderDeps();
  return missing.length === 0
    ? { name, status: 'ok', detail: 'installed — cards can be written as .svg, .png or .gif' }
    : {
        name,
        status: 'ok',
        detail: 'not installed — cards can be written as .svg',
        fix: `npm i --no-save ${RENDER_DEPS.join(' ')} to also write .png and .gif`,
      };
}

async function checkGit(): Promise<{ check: DoctorCheck; available: boolean }> {
  const name = 'git';
  const res = await runGit(['--version']);
  if (res.code === 0 && res.stdout.startsWith('git version')) {
    return { check: { name, status: 'ok', detail: res.stdout.trim() }, available: true };
  }
  return {
    check: {
      name,
      status: 'warn',
      detail: 'not runnable here — filesystem capture and forked worktrees will be off',
      fix: 'install git to get fs snapshots and checkpoints; otherwise record with --no-fs',
    },
    available: false,
  };
}

async function checkWorkspace(cwd: string, gitAvailable: boolean): Promise<DoctorCheck> {
  const name = 'git workspace';
  const fix =
    'git init here, or record from your project root — fs diffs are far more useful in a repo';

  if (gitAvailable) {
    const res = await runGit(['rev-parse', '--show-toplevel'], { cwd });
    if (res.code === 0 && res.stdout.trim() !== '') {
      return { name, status: 'ok', detail: res.stdout.trim() };
    }
    return { name, status: 'warn', detail: `${cwd} is not inside a git repo`, fix };
  }

  // Without git, answer the question from the filesystem rather than declining to answer it.
  const root = await findRepoRoot(cwd);
  return root === undefined
    ? { name, status: 'warn', detail: `${cwd} is not inside a git repo`, fix }
    : { name, status: 'ok', detail: `${root} (found by .git; git itself is not runnable)` };
}

/**
 * Writes a real file and removes it. `.orca` is created lazily by `record`, so when it does not
 * exist yet the directory that will have to hold it is what gets probed — and nothing is created.
 */
async function checkWritable(cwd: string): Promise<{ check: DoctorCheck; probeDir: string }> {
  const name = '.orca writable';
  const target = orcaDir(cwd);
  const info = await stat(target).catch(() => null);

  if (info !== null && !info.isDirectory()) {
    return {
      check: {
        name,
        status: 'fail',
        detail: `${target} exists but is not a directory`,
        fix: `move or remove ${target}; orca keeps every recorded run in it`,
      },
      probeDir: cwd,
    };
  }

  const probeDir = info === null ? cwd : target;
  const probe = join(probeDir, `.orca-doctor-${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(probe, 'orca doctor', { mode: 0o600 });
    await unlink(probe);
  } catch (err) {
    return {
      check: {
        name,
        status: 'fail',
        detail: `cannot write and clean up a file in ${probeDir}: ${messageOf(err)}`,
        fix: `make ${probeDir} writable, or run orca from a directory you own`,
      },
      probeDir,
    };
  }
  return {
    check: {
      name,
      status: 'ok',
      detail:
        info === null ? `${probeDir} is writable (.orca not created yet)` : `${target} is writable`,
    },
    probeDir,
  };
}

async function checkAgents(cwd: string): Promise<DoctorCheck> {
  const name = 'agents detected';
  const registry = defaultAdapters();
  const found: string[] = [];
  for (const id of registry.ids()) {
    try {
      if (await registry.get(id).detect(cwd)) found.push(id);
    } catch {
      // A detector that throws is a "no"; it must never take the diagnosis down with it.
    }
  }
  if (found.length === 0) {
    return {
      name,
      status: 'warn',
      detail: 'none of the known agents were found on PATH or in this workspace',
      fix: 'name the agent explicitly, or record any OpenAI-compatible one: orca record generic-openai -- <command>',
    };
  }
  return { name, status: 'ok', detail: found.join(', ') };
}

async function checkPort(): Promise<DoctorCheck> {
  const name = 'proxy port';
  try {
    const port = await bindEphemeral();
    return { name, status: 'ok', detail: `bound 127.0.0.1:${port}, then released it` };
  } catch (err) {
    return {
      name,
      status: 'fail',
      detail: `cannot bind a loopback port: ${messageOf(err)}`,
      fix: 'orca records by proxying model traffic through 127.0.0.1 — allow loopback listeners (sandbox or firewall policy) before recording',
    };
  }
}

function bindEphemeral(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('listening socket reported no port'));
      });
    });
  });
}

async function checkDisk(probeDir: string): Promise<DoctorCheck> {
  const name = 'disk space';
  if (typeof fsPromises.statfs !== 'function') {
    return { name, status: 'ok', detail: 'skipped — statfs is unavailable on this node build' };
  }
  try {
    const fs = await fsPromises.statfs(probeDir);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < LOW_DISK_BYTES) {
      return {
        name,
        status: 'warn',
        detail: `${formatBytes(free)} free where .orca lives`,
        fix: 'free some space — one recorded run can reach tens of megabytes: orca gc --older-than 7d',
      };
    }
    return { name, status: 'ok', detail: `${formatBytes(free)} free` };
  } catch (err) {
    return { name, status: 'ok', detail: `skipped — statfs failed: ${messageOf(err)}` };
  }
}

async function checkRuns(cwd: string): Promise<DoctorCheck> {
  const name = 'existing runs';
  const runs = await listRuns(cwd);
  if (runs.length === 0) return { name, status: 'ok', detail: 'none recorded here yet' };

  let bytes = 0;
  for (const run of runs) bytes += await runDirBytes(run.dir);
  const detail = `${runs.length} run${runs.length === 1 ? '' : 's'}, ${formatBytes(bytes)}`;
  if (bytes > BIG_STORE_BYTES) {
    return {
      name,
      status: 'warn',
      detail,
      fix: 'orca gc --keep 20 --dry-run shows what could be reclaimed',
    };
  }
  return { name, status: 'ok', detail };
}

async function findRepoRoot(from: string): Promise<string | undefined> {
  let dir = from;
  for (;;) {
    const found = await stat(join(dir, '.git')).then(
      () => true,
      () => false,
    );
    if (found) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
