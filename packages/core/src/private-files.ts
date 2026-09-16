import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Keep a path to its owner — in the currency the filesystem actually has.
 *
 * `chmod(path, 0o600)` on Windows sets the read-only attribute and nothing else. The mode bits are
 * a POSIX idea; what the file really gets is the ACL it inherits from wherever it was written, and
 * under a workspace on `C:\` that is:
 *
 * ```
 * NT AUTHORITY\Authenticated Users:(I)(M)   ← any authenticated account may rewrite it
 * BUILTIN\Users:(I)(RX)                     ← any local account may read it
 * ```
 *
 * For a trace that is bad. For the run CA's private key it is the whole point of the feature
 * undone: that key signs the certificates the agent has been told to trust for the life of the
 * run, so whoever reads it can impersonate every intercepted host to that agent, and whoever
 * writes it can substitute a CA of their own. For `config.json` it is a gateway API key sitting
 * in a file the machine can read.
 *
 * So on Windows the promise is kept with an ACL: inheritance dropped, and the only trustees left
 * are the owner, SYSTEM and Administrators. That is the rule OpenSSH for Windows enforces on its
 * own private keys, and it is the closest the platform comes to 0600 — under which root can still
 * read the file too.
 *
 * Callers keep whatever error policy they had: this throws where `chmod` threw.
 */
export async function restrictToOwner(path: string, mode: 0o600 | 0o700): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(path, mode);
    return;
  }
  // Inheritable, for a directory, so that everything written inside it afterwards is covered
  // without a further call — which is the only affordable way to secure a tree of many files.
  const inherit = mode === 0o700 ? '(OI)(CI)' : '';
  const trustees = [await currentAccountSid(), SYSTEM, ADMINISTRATORS];
  await run(system32('icacls.exe'), [
    path,
    '/inheritance:r',
    '/grant:r',
    ...trustees.map((sid) => `*${sid}:${inherit}(F)`),
    '/q',
  ]);
}

const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';

/**
 * By SID, never by name: `BUILTIN\Administrators` is localized on a localized Windows, and a grant
 * naming a principal that does not resolve is a grant that silently matches nothing — which, after
 * `/inheritance:r` has removed the rest, would leave the file with no usable ACE at all.
 */
let sid: Promise<string> | undefined;

async function currentAccountSid(): Promise<string> {
  sid ??= readSid().catch((err: unknown) => {
    // Not cached as a rejection: a transient failure here would otherwise be permanent for the
    // life of the process, and every later write would inherit the ACL we meant to replace.
    sid = undefined;
    throw err;
  });
  return sid;
}

async function readSid(): Promise<string> {
  const { stdout } = await run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const found = /S-1-[\d-]+/.exec(stdout)?.[0];
  if (!found) throw new Error(`could not read this account's SID from: ${stdout.trim()}`);
  return found;
}

/**
 * Absolute rather than resolved through PATH. This runs in order to secure a private key, and a
 * lookup that landed on someone else's `icacls.exe` — in the workspace being recorded, say — would
 * hand that key to exactly the reader the call exists to shut out.
 *
 * Which is why there is no fallback. `'C:\Windows'` looks like one and is not: `\W` is not an
 * escape, so that literal's value is `C:Windows`, and a path beginning with a drive letter and no
 * separator is *drive-relative* — CreateProcess resolves it against the current directory on C:,
 * which during a recording is the workspace. `Windows/System32/icacls.exe` is a storable git path,
 * so the guess reintroduces exactly the hijack it was written against. Spelling it correctly would
 * still be a guess, and wrong on a machine whose Windows is not on C:.
 *
 * `SystemRoot` is set by the OS in every normal process environment. Absent, something is wrong
 * with how orca was launched, and refusing is the only answer that cannot be silently incorrect.
 */
function system32(exe: string): string {
  const root = process.env['SystemRoot'];
  if (root === undefined || root === '') {
    throw new Error(
      `cannot locate ${exe}: SystemRoot is not set, so there is no trustworthy path to it. ` +
        'orca will not fall back to a guess here — this call is what keeps a private key private.',
    );
  }
  return join(root, 'System32', exe);
}
