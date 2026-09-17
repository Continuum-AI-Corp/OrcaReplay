import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
  // parent's ACL — and a parent is not something this function gets to assume anything about. On
  // every Windows command the store root would spend that window readable by whoever the
  // workspace allowed, and anything created inside it would keep that permanently, since icacls
  // does not re-propagate to children later. Measured too, on a real store.
  await run(icacls, [
    path,
    '/inheritance:r',
    ...foreign.flatMap((trustee) => ['/remove', `*${trustee}`]),
    '/grant:r',
    ...grantsFor(keep, inherit),
    '/q',
  ]);

  // And then read it back, because everything above rests on having understood a descriptor that
  // this file's own parser has now been wrong about twice. The check is deliberately not that
  // parser: it matches the whole descriptor, anchored, against the shape this function writes, so
  // an ACE of a type nobody anticipated fails it rather than being skipped by it.
  //
  // Nothing is escaped into the pattern because nothing needs to be — a trustee here is a SID or
  // one of SDDL's two-letter abbreviations, and both are `[A-Za-z0-9-]`.
  const written = await descriptorOf(icacls, path);
  if (!asWritten(ours).test(written)) {
    throw new Error(
      `the ACL orca wrote to ${path} is not the one it asked for: ${JSON.stringify(written)}`,
    );
  }
}

/**
 * The grants a narrowing asks for, and the shape its result has to come back in.
 *
 * Shared by `restrictToOwner` and `aclScratch` because they are the same job and drifted apart
 * once already: the second was written with `/inheritance:r` and `/grant:r` and neither the
 * read-back nor the reasoning eighty lines above about why exiting 0 is not an answer.
 *
 * Nothing is escaped into the pattern because nothing needs to be — a trustee here is a SID or one
 * of SDDL's two-letter abbreviations, and both are `[A-Za-z0-9-]`.
 */
function grantsFor(trustees: readonly string[], inherit: string): string[] {
  return trustees.map((sid) => `*${sid}:${inherit}(F)`);
}

function asWritten(trustees: Iterable<string>): RegExp {
  return new RegExp(
    '^D:[A-Z]*P[A-Z]*(?:\\(A;[A-Z]*;[^;]*;;;(?:' + [...trustees].join('|') + ')\\))+$',
  );
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
  const descriptor = await descriptorOf(icacls, path);
  // (type;flags;rights;object_guid;inherit_object_guid;trustee[;condition]) — `ID` in the flags
  // marks it inherited. The type is read as a field rather than as one character: `XA`/`XD` are
  // conditional ACEs, `OA`/`OD` object ones, `AU`/`AL` audits, and a single-character type class
  // matched none of them. The trustee stops at `;` as well as `)`, because a conditional ACE
  // carries its expression after the trustee.
  const aces = [...descriptor.matchAll(/\(([^;]*);([^;]*);[^;]*;[^;]*;[^;]*;([^;)]+)/g)];
  return [...new Set(aces.filter((ace) => !ace[2]!.includes('ID')).map((ace) => ace[3]!))];
}

/** The path's security descriptor, as SDDL. */
async function descriptorOf(icacls: string, path: string): Promise<string> {
  const saved = join(await aclScratch(icacls), randomBytes(8).toString('hex'));
  try {
    await run(icacls, [path, '/save', saved]);
    return await readDescriptor(saved, path);
  } finally {
    await rm(saved, { force: true }).catch(() => undefined);
  }
}

/**
 * The descriptor out of what `icacls /save` wrote.
 *
 * UTF-16LE, and the descriptor is the last line: two lines for an ordinary path — the entry's
 * name, then its descriptor — and one for a path with no name to give, such as a drive root.
 *
 * By position rather than by scanning for a `D:` prefix. A name line cannot carry one today, since
 * `/save` writes the basename and a Windows filename cannot contain a colon, but that is a fact
 * about a neighbouring tool rather than about this parse.
 */
async function readDescriptor(saved: string, path: string): Promise<string> {
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
  return descriptor;
}

let scratch: Promise<string> | undefined;

/**
 * Somewhere private to write the descriptors this file reads back.
 *
 * `mkdtemp` discards its mode on Windows, so a scratch directory under `%TEMP%` takes whatever
 * that hands down — measured here: two further local accounts, both with inheritable Modify. Every
 * other temporary directory this feature mints is narrowed the moment it exists, and this one was
 * not, which matters more rather than less: the file written into it is the *input to both halves
 * of the only guard this function has* — the descriptor `explicitTrustees` decides the `/remove`
 * list from, and the descriptor the read-back check compares against what was asked for.
 * Substituting it hides a foreign trustee from the first and satisfies the second.
 *
 * Narrowed directly rather than through `restrictToOwner`, which reads a descriptor, which is read
 * from here — that would recurse. `execFile` rejects on a non-zero exit, so a narrowing that did
 * not apply is a throw rather than a descriptor read out of a directory anyone can write.
 *
 * One per process, with a random filename per call, so the cost is a single extra `icacls` for the
 * life of the run rather than two on every path narrowed.
 */
async function aclScratch(icacls: string): Promise<string> {
  scratch ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-acl-'));
    try {
      const keep = [await currentAccountSid(), SYSTEM, ADMINISTRATORS];
      const ours = new Set([...keep, 'SY', 'BA']);

      // `mkdtemp` just made this, so it carries no explicit ACE to remove — measured: five, every
      // one flagged inherited — and it cannot be a link. What it *can* be is swapped, in the gap
      // between that call and this one, by an account with Modify on `%TEMP%`, which is the ACL
      // measured here. `icacls` does not follow a reparse point, so the narrowing would land on
      // the junction while every descriptor this module reads came out of the other directory.
      // So it is vouched for and re-checked either side, exactly as `ensureRunsDir` does it.
      const was = await lstat(dir);
      await run(icacls, [dir, '/inheritance:r', '/grant:r', ...grantsFor(keep, '(OI)(CI)'), '/q']);
      const now = await lstat(dir);
      if (now.isSymbolicLink() || now.dev !== was.dev || now.ino !== was.ino) {
        throw new Error(`${dir} was replaced while orca was securing it`);
      }

      // A file, kept, so the directory cannot be removed and replaced later.
      //
      // The identity check above closes the window up to here. It does nothing about the rest of
      // the run: this directory is reused for every narrowing the process makes, and between them
      // it would sit empty in `%TEMP%` — where Modify, which two further local accounts hold here,
      // carries Delete-Subfolders, and Delete-Subfolders on a parent removes a child whatever the
      // child's own DACL says. An *empty* child. `rmdir` on a non-empty one is refused, and this
      // file is out of reach in turn: it inherits this directory's ACL, so deleting it would need
      // Delete-Subfolders *here*, which is exactly what the narrowing took away.
      //
      // `.orca` and `.orca/runs` are already safe this way — `.orca` holds `runs` and
      // `.gitignore`, and `runs` sits under a narrowed parent — which is why only this one needed
      // saying out loud.
      await writeFile(join(dir, 'in-use'), String(process.pid), { mode: 0o600, flag: 'wx' });

      // And read back what was written, for the reason the sibling gives: `execFile` reports that
      // icacls exited 0 and nothing more. Read straight rather than through `descriptorOf`, which
      // writes into this directory and would await the promise it is running inside.
      const saved = join(dir, 'verify');
      await run(icacls, [dir, '/save', saved]);
      const written = await readDescriptor(saved, dir);
      await rm(saved, { force: true }).catch(() => undefined);
      if (!asWritten(ours).test(written)) {
        throw new Error(`the ACL orca wrote to ${dir} is not the one it asked for: ${written}`);
      }

      // Nothing sweeps an `orca-acl-` directory the way `sweepStaleTransports` sweeps the two
      // named transports, so it takes itself with it rather than accumulating one per run.
      process.on('exit', () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Exiting anyway; a directory left in %TEMP% is not worth failing the exit over.
        }
      });
      return dir;
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      scratch = undefined;
      throw err;
    }
  })();
  return scratch;
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
  // Absolute, not merely present. `SystemRoot=C:Windows` — the same drive-relative shape the
  // comment above describes — would rebuild the workspace-relative lookup out of the environment
  // instead of out of a literal, and a wrapper that sets the variable for orca's process is an
  // ordinary thing to run into. `isAbsolute('C:Windows')` is false and `isAbsolute('C:\Windows')`
  // is true, so this refuses exactly the values that would resolve against the current directory.
  if (root === undefined || root === '' || !isAbsolute(root)) {
    throw new Error(
      `cannot locate ${exe}: SystemRoot is ${root === undefined || root === '' ? 'not set' : `not an absolute path (${JSON.stringify(root)})`}, ` +
        'so there is no trustworthy path to it. orca will not fall back to a guess here — this ' +
        'call is what keeps a private key private.',
    );
  }
  return join(root, 'System32', exe);
}
