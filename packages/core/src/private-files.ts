import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
 * So on Windows the promise is kept with an ACL: everything already on it is taken away — the
 * inherited entries and the explicit ones alike — and the only trustees left are the owner,
 * SYSTEM and Administrators. That is the rule OpenSSH for Windows enforces on its
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
  const icacls = system32('icacls.exe');
  const inherit = mode === 0o700 ? '(OI)(CI)' : '';

  // Everything that can fail happens before the one call that changes anything — the SID lookup,
  // the read, the temporary file. A failure therefore leaves the path exactly as it was found,
  // which for a function like this is the only acceptable direction to fail in.
  const keep = [await currentAccountSid(), SYSTEM, ADMINISTRATORS];
  // Both spellings, because a descriptor writes the well-known ones abbreviated.
  const ours = new Set([...keep, 'SY', 'BA']);
  const foreign = (await explicitTrustees(icacls, path)).filter((trustee) => !ours.has(trustee));

  // One invocation, and every part of it narrows.
  //
  // `/inheritance:r` removes only the ACEs carrying the inherited flag, and `/grant:r` replaces
  // previously granted explicit permissions *for the trustees it names* — so an explicit ACE for
  // anybody else survives both, keeping its `(OI)(CI)` on a directory and passing itself to
  // everything written afterwards. Measured: grant BUILTIN\Users explicitly, then restrict, and
  // `(A;;FA;;;BU)` is still on the DACL. "Replace all child object permissions" turns inherited
  // ACEs into explicit ones, and so do `robocopy /SEC` and a tree carried between machines, so
  // this is an ordinary shape rather than an exotic one. Hence naming them for removal.
  //
  // `/reset` would be the obvious way to clear them and is the wrong one: it replaces the DACL
  // with whatever the *parent* hands down, so between it and the grant the path holds the
  // workspace's ACL. `.orca` is not restricted — only `.orca/runs` is — so on every Windows
  // command the store root would spend that window readable by every account on the machine, and
  // anything created inside it would inherit that permanently, since icacls does not re-propagate
  // to children later. Measured too, on a real store.
  await run(icacls, [
    path,
    '/inheritance:r',
    ...foreign.flatMap((trustee) => ['/remove', `*${trustee}`]),
    '/grant:r',
    ...keep.map((sid) => `*${sid}:${inherit}(F)`),
    '/q',
  ]);
}

/**
 * Who a path grants or denies *explicitly*, in whatever spelling icacls itself uses.
 *
 * Explicit only, because the inherited ones are already `/inheritance:r`'s job — and naming one of
 * those alongside it fails the whole invocation. A directory under `%TEMP%` here carries inherited
 * ACEs for accounts that no longer exist, and `/remove` on such a SID after inheritance has been
 * stripped cannot map it to a name: `icacls … /inheritance:r /remove *<orphan>` exits 1332 and
 * applies nothing. Removing only what `/inheritance:r` will leave behind avoids that by being the
 * more accurate thing to ask for.
 *
 * As SDDL, via `/save`, because the names `icacls <path>` prints are localized. Returned verbatim
 * rather than expanded to SIDs: `/remove` accepts `*BU` as readily as `*S-1-5-32-545`, and a
 * lookup table of well-known abbreviations would silently pass through any entry it had missed —
 * which for this function means a trustee that keeps its access.
 */
async function explicitTrustees(icacls: string, path: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-acl-'));
  try {
    const saved = join(dir, 'acl');
    await run(icacls, [path, '/save', saved]);
    // UTF-16LE, and the descriptor is the last line: two lines for an ordinary path — the entry's
    // name, then its descriptor — and one for a path with no name to give, such as a drive root.
    //
    // By position rather than by scanning for a `D:` prefix. A name line cannot carry one today,
    // since `/save` writes the basename and a Windows filename cannot contain a colon, but that is
    // a fact about a neighbouring tool rather than about this parse.
    const lines = (await readFile(saved, 'utf16le'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const descriptor = lines.at(-1) ?? '';
    // Refused rather than read as "nothing to remove", which is what an unrecognised line would
    // silently mean: every foreign trustee left in place, and `icacls` still exiting 0.
    if (!/^[OGDS]:/.test(descriptor) || !descriptor.includes('(')) {
      throw new Error(
        `could not read the ACL of ${path}: ${JSON.stringify(descriptor.slice(0, 80))}`,
      );
    }
    // (type;flags;rights;object;inherit_object;trustee) — `ID` in the flags marks it inherited.
    const aces = [...descriptor.matchAll(/\(.;([^;]*);[^;]*;[^;]*;[^;]*;([^)]+)\)/g)];
    return [...new Set(aces.filter((ace) => !ace[1]!.includes('ID')).map((ace) => ace[2]!))];
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
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
