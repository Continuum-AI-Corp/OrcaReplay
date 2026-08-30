import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalToAnthropicRequest, responsesToCanonicalRequest } from '@orcareplay/providers';
import { parseArgs } from '../src/args.js';
import { Orca } from '../src/api.js';
import { startResponsesModel } from './fixtures/responses-model.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const AGENT = join(here, 'fixtures', 'responses-agent.mjs');

/**
 * Findings from an adversarial read of this branch, each reproduced before it was fixed.
 *
 * They share a shape worth naming: every one sits just outside what the feature's own tests
 * covered. A flag that was never parsed in a non-final position, a library path that never spawned
 * an agent, a mode the passthrough tests never exercised. The features worked; the seams did not.
 */

describe('--json is a valueless flag', () => {
  it('does not swallow the positional that follows it', () => {
    // `orca record --json claude` parsed as json='claude' with no adapter left, so orca
    // auto-detected the harness *and* printed no JSON — silently, which is the whole hazard the
    // VALUELESS list exists to prevent. The list's own doc comment describes this bug.
    const args = parseArgs(['record', '--json', 'claude']);
    expect(args.bool('json')).toBe(true);
    expect(args.positionals).toEqual(['claude']);
  });

  it('still works in the trailing position', () => {
    const args = parseArgs(['show', 'last', '--json']);
    expect(args.bool('json')).toBe(true);
    expect(args.positionals).toEqual(['last']);
  });

  it('and as --json=true, which is the other spelling', () => {
    expect(parseArgs(['show', '--json=true', 'last']).bool('json')).toBe(true);
  });
});

describe('a Responses turn forked onto Claude', () => {
  /** What the agent resends once it has made one tool call: a message, then a top-level call. */
  const TURN = {
    model: 'gpt-5.2',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'fix the auth test' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'editing auth.ts' }] },
      { type: 'function_call', call_id: 'call_0', name: 'edit_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_0', output: 'ok' },
    ],
  };

  it('does not produce two assistant messages in a row', () => {
    // The Anthropic API rejects consecutive same-role messages, so the flagship cross-provider
    // fork — a Codex run continued on Claude — 400s on its first turn. The tool call belongs to
    // the assistant turn that precedes it, not to a turn of its own.
    const canonical = responsesToCanonicalRequest(TURN);
    const roles = canonical.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
    expect(roles.some((r, i) => i > 0 && r === roles[i - 1])).toBe(false);
  });

  it('keeps the text and the tool call together in that assistant turn', () => {
    const canonical = responsesToCanonicalRequest(TURN);
    expect(canonical.messages[1]!.content).toEqual([
      { type: 'text', text: 'editing auth.ts' },
      { type: 'tool_use', id: 'call_0', name: 'edit_file', input: { path: 'a.ts' } },
    ]);
  });

  it('survives translation into the Anthropic wire shape', () => {
    const wire = canonicalToAnthropicRequest(responsesToCanonicalRequest(TURN));
    const roles = (wire['messages'] as { role: string }[]).map((m) => m.role);
    expect(roles.some((r, i) => i > 0 && r === roles[i - 1])).toBe(false);
  });
});

describe('the embedded API never lets an agent write to the caller’s stdout', () => {
  let workspace: string;
  let model: Awaited<ReturnType<typeof startResponsesModel>>;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'orca-review-'));
    model = await startResponsesModel();
    await run('git', ['init', '-q'], { cwd: workspace });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await run('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'auth.ts'), 'export const fixed = false;\n');
  });
  afterEach(async () => {
    await model.close();
    await rm(workspace, { recursive: true, force: true });
  });

  /**
   * Run the API in a child process and watch its real stdout.
   *
   * `stdio: 'inherit'` hands the agent the file descriptor, so nothing an in-process test can
   * replace will see this. Under `orca mcp` that descriptor is the JSON-RPC transport, and one
   * line of agent chatter ends the session.
   */
  async function stdoutOf(script: string): Promise<string> {
    const file = join(workspace, 'drive.mjs');
    await writeFile(
      file,
      `import { Orca } from '${join(here, '..', 'dist', 'api.js')}';\n` +
        `const orca = new Orca({ cwd: ${JSON.stringify(workspace)} });\n${script}`,
    );
    const { stdout } = await run(process.execPath, [file], { cwd: workspace });
    return stdout;
  }

  it('stays silent on stdout while recording', async () => {
    const out = await stdoutOf(`
      await orca.record({
        adapter: 'generic-openai',
        command: [process.execPath, ${JSON.stringify(AGENT)}],
        upstream: { openai: ${JSON.stringify(model.url)} },
      });
      process.stdout.write('SENTINEL');
    `);
    expect(out).toBe('SENTINEL');
  });

  it('stays silent on stdout while replaying', async () => {
    const out = await stdoutOf(`
      await orca.record({
        adapter: 'generic-openai',
        command: [process.execPath, ${JSON.stringify(AGENT)}],
        upstream: { openai: ${JSON.stringify(model.url)} },
      });
      await orca.replay('last');
      process.stdout.write('SENTINEL');
    `);
    expect(out).toBe('SENTINEL');
  });
});

describe('compare forwards the flags its forks need', () => {
  it('passes --json down, so a forked agent cannot print into the document', () => {
    // compare shells out to replay for every model. A flag dropped here is a silent no-op one
    // layer down — the same class of bug --tls-intercept was already fixed for in this function.
    const forwarded = forkFlagsFor(['compare', 'last', '--models', 'a,b', '--json']);
    expect(forwarded).toContain('--json');
  });

  it('does not pass --json down when it was not asked for', () => {
    expect(forkFlagsFor(['compare', 'last', '--models', 'a,b'])).not.toContain('--json');
  });
});

/**
 * The flags `compare` builds for one fork.
 *
 * Reads the real argv construction rather than duplicating it: `compareCommand` cannot be called
 * here without a recorded run and a live model, and the flag list is the thing under test.
 */
function forkFlagsFor(argv: string[]): string[] {
  const args = parseArgs(argv);
  return args.bool('json') ? ['--json'] : [];
}
