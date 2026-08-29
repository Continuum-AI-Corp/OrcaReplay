/** Result of rewriting an agent's MCP config to launch its stdio servers through the shim. */
export interface McpRewrite {
  /** A new config value. The input is never mutated. */
  config: unknown;
  /** Server names now launching through the shim. */
  rewritten: string[];
  /** Server names deliberately left alone — HTTP/SSE transports, or shapes we do not recognise. */
  skipped: string[];
}

type ServerEntry = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A server is already wrapped when it points at *this* shim and carries the `--name ... --`
 * separator we generate. Matching on the shim command as well as the separator keeps a real
 * server whose own argv happens to contain `--` from being mistaken for our wrapper.
 */
function isWrapped(entry: ServerEntry, shimCommand: string): boolean {
  if (entry['command'] !== shimCommand) return false;
  const args = entry['args'];
  return Array.isArray(args) && args.includes('--name') && args.includes('--');
}

/**
 * Rewrites `{ mcpServers: { name: { command, args, env } } }` so each stdio server launches under
 * the JSON-RPC tee. Servers reached over HTTP/SSE are left untouched — they are already captured
 * by the HTTP proxy — but they are reported rather than silently dropped, because an MCP server
 * that quietly stops appearing in a trace is indistinguishable from one that was never used.
 */
export function rewriteMcpConfig(
  config: unknown,
  shimCommand: string,
  shimArgs: string[],
): McpRewrite {
  const rewritten: string[] = [];
  const skipped: string[] = [];

  if (!isObject(config) || !isObject(config['mcpServers'])) {
    return { config, rewritten, skipped };
  }

  const servers = config['mcpServers'];
  const nextServers: Record<string, unknown> = {};

  for (const [name, raw] of Object.entries(servers)) {
    if (!isObject(raw)) {
      nextServers[name] = raw;
      skipped.push(name);
      continue;
    }
    const entry = structuredClone(raw) as ServerEntry;

    if (isWrapped(entry, shimCommand)) {
      nextServers[name] = entry;
      rewritten.push(name);
      continue;
    }
    if (typeof entry['url'] === 'string') {
      nextServers[name] = entry;
      skipped.push(name);
      continue;
    }
    if (typeof entry['command'] !== 'string') {
      nextServers[name] = entry;
      skipped.push(name);
      continue;
    }

    const original = entry['command'];
    const originalArgs = Array.isArray(entry['args']) ? (entry['args'] as unknown[]) : [];
    nextServers[name] = {
      ...entry,
      command: shimCommand,
      args: [...shimArgs, '--name', name, '--', original, ...originalArgs],
    };
    rewritten.push(name);
  }

  return { config: { ...structuredClone(config), mcpServers: nextServers }, rewritten, skipped };
}
