import { describe, expect, it } from 'vitest';
import { rewriteMcpConfig } from '../src/index.js';

const SHIM = 'orca-mcp-shim';
const SHIM_ARGS = ['--out', '/tmp/run/mcp.jsonl'];

function fixture() {
  return {
    mcpServers: {
      fs: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/work'],
        env: { FOO: 'bar' },
      },
      remote: { url: 'https://mcp.example.com/sse' },
    },
  };
}

describe('rewriteMcpConfig', () => {
  it('wraps a stdio server so it launches through the shim', () => {
    const { config, rewritten } = rewriteMcpConfig(fixture(), SHIM, SHIM_ARGS);
    const fs = (config as any).mcpServers.fs;
    expect(fs.command).toBe(SHIM);
    expect(fs.args).toEqual([
      '--out',
      '/tmp/run/mcp.jsonl',
      '--name',
      'fs',
      '--',
      'npx',
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/work',
    ]);
    expect(rewritten).toEqual(['fs']);
  });

  it('keeps the server environment on the wrapper', () => {
    const { config } = rewriteMcpConfig(fixture(), SHIM, SHIM_ARGS);
    expect((config as any).mcpServers.fs.env).toEqual({ FOO: 'bar' });
  });

  it('handles a stdio server with no args of its own', () => {
    const { config } = rewriteMcpConfig({ mcpServers: { t: { command: 'srv' } } }, SHIM, []);
    expect((config as any).mcpServers.t.args).toEqual(['--name', 't', '--', 'srv']);
  });

  it('preserves fields it does not understand rather than dropping them', () => {
    const { config } = rewriteMcpConfig(
      { mcpServers: { t: { command: 'srv', args: [], disabled: true, timeout: 5 } } },
      SHIM,
      [],
    );
    expect((config as any).mcpServers.t.disabled).toBe(true);
    expect((config as any).mcpServers.t.timeout).toBe(5);
  });

  it('leaves url servers alone and reports them instead of dropping them', () => {
    const { config, rewritten, skipped } = rewriteMcpConfig(fixture(), SHIM, SHIM_ARGS);
    expect((config as any).mcpServers.remote).toEqual({ url: 'https://mcp.example.com/sse' });
    expect(rewritten).not.toContain('remote');
    expect(skipped).toEqual(['remote']);
  });

  it('reports a server that is neither stdio nor url instead of dropping it', () => {
    const { config, skipped } = rewriteMcpConfig({ mcpServers: { odd: { note: 1 } } }, SHIM, []);
    expect((config as any).mcpServers.odd).toEqual({ note: 1 });
    expect(skipped).toEqual(['odd']);
  });

  it('is idempotent: a second rewrite does not double-wrap', () => {
    const once = rewriteMcpConfig(fixture(), SHIM, SHIM_ARGS);
    const twice = rewriteMcpConfig(once.config, SHIM, SHIM_ARGS);
    expect(twice.config).toEqual(once.config);
    expect(twice.rewritten).toEqual(once.rewritten);
    expect(twice.skipped).toEqual(once.skipped);
  });

  it('does not mutate the input config', () => {
    const input = fixture();
    const before = JSON.parse(JSON.stringify(input));
    const { config } = rewriteMcpConfig(input, SHIM, SHIM_ARGS);
    expect(input).toEqual(before);
    expect(config).not.toBe(input);
    expect((config as any).mcpServers.fs).not.toBe(input.mcpServers.fs);
  });

  it('rewrites every stdio server, in order', () => {
    const { rewritten, skipped } = rewriteMcpConfig(
      {
        mcpServers: {
          a: { command: 'a' },
          b: { url: 'https://b.example' },
          c: { command: 'c', args: ['--x'] },
        },
      },
      SHIM,
      [],
    );
    expect(rewritten).toEqual(['a', 'c']);
    expect(skipped).toEqual(['b']);
  });

  it('passes through a config with no mcpServers untouched', () => {
    const input = { other: true };
    const out = rewriteMcpConfig(input, SHIM, []);
    expect(out.config).toEqual(input);
    expect(out.rewritten).toEqual([]);
    expect(out.skipped).toEqual([]);
  });

  it('does not throw on a config that is not an object', () => {
    expect(rewriteMcpConfig(null, SHIM, []).config).toBeNull();
    expect(rewriteMcpConfig('nope', SHIM, []).config).toBe('nope');
    expect(rewriteMcpConfig({ mcpServers: 'nope' }, SHIM, []).rewritten).toEqual([]);
  });
});
