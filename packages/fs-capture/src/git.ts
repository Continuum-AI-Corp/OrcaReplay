import { spawn } from 'node:child_process';

export interface GitOptions {
  gitDir?: string;
  workTree?: string;
  cwd?: string;
  indexFile?: string;
  input?: string | Uint8Array;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitRawResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/**
 * `--upload-pack`/`--receive-pack` name a command for git to execute. A workspace path that
 * reaches an argument array unquoted would otherwise be arbitrary code execution.
 */
const UNSAFE_ARG_PREFIXES = ['--upload-pack', '--receive-pack'];

/** Exit code convention for "the binary could not be run at all". */
export const GIT_NOT_EXECUTABLE = 127;

function assertSafeArgs(args: readonly string[]): void {
  for (const arg of args) {
    for (const prefix of UNSAFE_ARG_PREFIXES) {
      if (arg.startsWith(prefix)) {
        throw new Error(`refusing to run git: argument "${arg}" can execute an arbitrary command`);
      }
    }
  }
}

/**
 * Ambient GIT_* variables are inherited whenever orca runs from inside a hook or another git
 * process, and would silently retarget commands at the wrong repository. System and global config
 * are dropped so a snapshot depends only on the workspace, never on who is running it.
 */
function childEnv(opts: GitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  env.LC_ALL = 'C';
  if (opts.indexFile !== undefined) env.GIT_INDEX_FILE = opts.indexFile;
  return env;
}

function prefixArgs(opts: GitOptions): string[] {
  const args: string[] = [];
  if (opts.gitDir !== undefined) args.push(`--git-dir=${opts.gitDir}`);
  if (opts.workTree !== undefined) args.push(`--work-tree=${opts.workTree}`);
  return args;
}

/** Like {@link runGit} but leaves stdout as bytes, for blob contents that are not text. */
export function runGitRaw(args: string[], opts: GitOptions = {}): Promise<GitRawResult> {
  assertSafeArgs(args);
  const full = [...prefixArgs(opts), ...args];
  return new Promise((resolve) => {
    const child = spawn('git', full, {
      cwd: opts.cwd,
      env: childEnv(opts),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const settle = (code: number, extra?: string): void => {
      if (settled) return;
      settled = true;
      const stderr = Buffer.concat(err).toString('utf8') + (extra ?? '');
      resolve({ stdout: Buffer.concat(out), stderr, code });
    };
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error: Error) => settle(GIT_NOT_EXECUTABLE, `failed to run git: ${error.message}`));
    child.on('close', (code, signal) => settle(code ?? (signal ? GIT_NOT_EXECUTABLE : 0)));
    // A git subcommand may exit before draining stdin; that EPIPE is not our problem.
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Runs git and reports the exit code. Never throws on a non-zero exit; callers decide. */
export async function runGit(args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const raw = await runGitRaw(args, opts);
  return { stdout: raw.stdout.toString('utf8'), stderr: raw.stderr, code: raw.code };
}

export async function gitAvailable(): Promise<boolean> {
  const res = await runGit(['--version']);
  return res.code === 0 && res.stdout.startsWith('git version');
}
