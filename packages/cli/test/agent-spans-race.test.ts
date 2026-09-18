import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const attack = vi.hoisted(() => ({ kind: '', target: '', transport: '', displaced: '' }));

vi.mock('@orcareplay/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@orcareplay/core')>();
  return {
    ...core,
    restrictToOwner: async (path: string, mode: 0o600 | 0o700) => {
      if (attack.kind && path.includes('orca-spans-')) {
        attack.transport = path;
        attack.displaced = `${path}.displaced`;
        await rename(path, attack.displaced);
        if (attack.kind === 'junction') await symlink(attack.target, path, 'junction');
        else if (attack.kind === 'directory') await mkdir(path);
        else throw new Error('injected ACL failure');
      }
      await core.restrictToOwner(path, mode);
    },
  };
});

const { installAgentSpans } = await import('../src/agent-spans.js');

describe.runIf(process.platform === 'win32')('agent-span transport replacement', () => {
  let root: string;

  afterEach(async () => {
    attack.kind = '';
    // All targets are test-created children or the exact mkdtemp captured above. Never recurse
    // through the injected junction; the attacker's marker must survive installation failure.
    if (attack.transport && existsSync(attack.transport)) {
      if ((await lstat(attack.transport)).isSymbolicLink()) await rm(attack.transport);
      else await rm(attack.transport, { recursive: true, force: true });
    }
    if (attack.displaced) await rm(attack.displaced, { recursive: true, force: true });
    if (root) await rm(root, { recursive: true, force: true });
    attack.transport = '';
    attack.displaced = '';
  });

  it.each(['junction', 'directory', 'missing'])(
    'refuses a %s swapped in during ACL setup',
    async (kind) => {
      root = await mkdtemp(join(tmpdir(), 'orca-transport-race-'));
      attack.target = join(root, 'attacker');
      await mkdir(attack.target);
      await writeFile(join(attack.target, 'keep'), 'attacker data');
      attack.kind = kind;

      await expect(installAgentSpans(root)).rejects.toThrow();
      expect(existsSync(join(attack.target, 'agent-spans.jsonl'))).toBe(false);
      expect(await readFile(join(attack.target, 'keep'), 'utf8')).toBe('attacker data');
    },
  );
});
