import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What must never be true of a committed capture.
 *
 * `capture/capture.mjs` scrubs a prompt before it is written, and the rules live in a script with
 * no tests of their own. Two of them have been wrong in ways that only a published file showed:
 * one consumed `Recent commits:` along with the status block it was meant to replace, and one
 * fired where there was nothing to replace and inserted a placeholder above the prompt's own
 * text. A third gap was simpler and lasted longer — the rules did not cover the branch and status
 * at all, so four committed artifacts recorded the branch that happened to be checked out and
 * every file that happened to be dirty, `claude-opus-5` listing fifteen of them.
 *
 * So this checks the outcome rather than the regexes: whatever the rules say, no artifact under
 * `prompt/` may carry the capture machine's working state. It is deliberately a repo-wide sweep,
 * because the thing that went wrong was not one bad capture but a rule that was missing while
 * captures kept being taken.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PROMPTS = join(REPO, 'prompt');

const artifacts = readdirSync(PROMPTS)
  .filter((d) => statSync(join(PROMPTS, d)).isDirectory())
  .flatMap((d) =>
    readdirSync(join(PROMPTS, d))
      .filter((f) => f.endsWith('.md'))
      .map((f) => [`${d}/${f}`, readFileSync(join(PROMPTS, d, f), 'utf8')] as const),
  );

describe('committed prompt artifacts', () => {
  it('finds the artifacts at all', () => {
    // A path that stops resolving would make every assertion below vacuously true.
    expect(artifacts.length).toBeGreaterThan(20);
  });

  it.each(artifacts)('%s carries no branch name', (_name, text) => {
    // `{{GIT_BRANCH}}` is fine; anything else is the branch someone had checked out.
    expect(text.match(/^Current branch: (?!\{\{GIT_BRANCH\}\}$).*$/m)?.[0]).toBeUndefined();
  });

  it.each(artifacts)('%s carries no git status listing', (_name, text) => {
    // A porcelain entry right after the heading: `(clean)`, or one or two status letters and a
    // space. `{{GIT_STATUS}}` matches neither, which is the point.
    expect(text.match(/^Status:\n(?:\(clean\)|[ MADRCU?!]{1,2} [^\n]*)$/m)?.[0]).toBeUndefined();
  });

  it.each(artifacts)('%s carries no per-project directory name', (_name, text) => {
    // ZCode's is `<basename>-<16 hex of the absolute path>`, which makes the artifact a fact
    // about the directory it was captured in and is below the `{{HEX}}` rule's floor of 32.
    expect(
      text.match(/[\\/]\.zcode[\\/]cli[\\/]memories[\\/]projects[\\/](?!\{\{)[^\\/\s"']+/)?.[0],
    ).toBeUndefined();
  });

  it.each(artifacts)('%s carries no home directory or account id', (_name, text) => {
    // The rules these cover are older and have their own history — a Crush capture shipped eight
    // `<location>` lines of a real home path and two account uuids, because `pathRe` did not yet
    // match a path written with forward slashes. Kept here so the whole set is swept at once.
    //
    // The home-path patterns require the path to continue into a config directory, and that is
    // not fussiness: a harness prompt may legitimately talk about home directories, and two here
    // do. Hermes explains Windows paths with `` `C:/Users/x`-style `` and Cursor's uses
    // `/Users/me`. A pattern that stopped at the user name flagged both, which is a guard that
    // teaches people to delete the guard. What a leak looks like is `C:/Users/<name>/.claude/…`
    // or `…/AppData/…` — the name followed by something only a real home has.
    for (const [what, re] of [
      ['home path', /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+[\\/]+(?:\.[A-Za-z]|AppData)/],
      ['posix home', /\/(?:home|Users)\/[a-z0-9_.-]+\/\.[a-z]/i],
      ['uuid', /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
      ['long hex', /(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/i],
      ['email', /[\w.+-]+@[\w-]+\.[\w.]{2,}/],
      ['key-shaped value', /\bsk-[A-Za-z0-9_-]{16,}/],
    ] as const) {
      expect(text.match(re)?.[0], what).toBeUndefined();
    }
  });

  it('would have caught the leaks these rules were written for', () => {
    // A guard nobody has seen fail is a guard nobody knows works. These are the shapes that
    // reached committed files before the rules existed, reduced to one line each — with the user
    // name and the account id replaced, because a test that pins a leak by quoting it verbatim
    // commits the leak. The patterns do not care which name it is.
    const leaks = [
      'Current branch: capture-opencode',
      'Status:\n?? .venv/\n',
      'Status:\nM capture/README.md\n',
      'Status:\n(clean)\n',
      'memory at `C:\\Users\\someone\\.zcode\\cli\\memories\\projects\\tmp-x-0123456789abcdef\\memory/`',
      '<location>C:/Users/someone/.claude/skills/synced/00000000-1111-2222-3333-444444444444/x</location>',
    ];
    const checks = [
      /^Current branch: (?!\{\{GIT_BRANCH\}\}$).*$/m,
      /^Status:\n(?:\(clean\)|[ MADRCU?!]{1,2} [^\n]*)$/m,
      /[\\/]\.zcode[\\/]cli[\\/]memories[\\/]projects[\\/](?!\{\{)[^\\/\s"']+/,
      /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+[\\/]+(?:\.[A-Za-z]|AppData)/,
      /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    ];
    for (const leak of leaks) {
      expect(
        checks.some((re) => re.test(leak)),
        leak.slice(0, 48),
      ).toBe(true);
    }
    // And the two harness prompts that legitimately mention a home directory are not flagged.
    for (const fine of ['Pass `C:/Users/x`-style forward-slash paths', 'e.g. /Users/me/project']) {
      expect(
        checks.some((re) => re.test(fine)),
        fine,
      ).toBe(false);
    }
  });
});
