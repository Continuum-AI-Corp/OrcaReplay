/**
 * Which URLs a recorded agent's `fetch` should be redirected to the proxy, and which must not be.
 *
 * Kept as one pure function because it is the security boundary of this package. The hook runs
 * inside someone else's agent, on every request it makes — so over-matching does not produce a
 * missing trace, it produces an agent whose telemetry, package downloads or database calls
 * silently go to a local port. Everything here is deny-by-default and matched on the whole
 * hostname, never on a suffix.
 */

/** Provider origins a JS agent reaches when it was never told about a base URL. */
export const DEFAULT_INSTRUMENTED_HOSTS = ['api.openai.com', 'api.anthropic.com'] as const;

export interface InstrumentConfig {
  /** Where the recording proxy is listening. Empty disables the hook entirely. */
  proxyUrl: string;
  /** Hostnames to redirect. `*.example.com` matches subdomains, never the bare parent. */
  hosts: readonly string[];
}

/**
 * The proxy URL a request should be sent to instead, or `undefined` to leave it alone.
 *
 * Never throws: this sits in the hot path of an agent that is not ours, and a hook that can throw
 * is a hook that breaks the run it was added to protect.
 */
export function rewriteUrl(raw: string, config: InstrumentConfig): string | undefined {
  if (config.proxyUrl === '') return undefined;
  let target: URL;
  let proxy: URL;
  try {
    target = new URL(raw);
    proxy = new URL(config.proxyUrl);
  } catch {
    return undefined;
  }
  // Already ours. The agent may read a base-URL variable *and* be instrumented, and without this
  // a proxy whose own upstream is itself would loop.
  if (target.host === proxy.host) return undefined;
  if (!config.hosts.some((pattern) => hostMatches(target.hostname, pattern))) return undefined;

  // The proxy may have been given a path prefix; the provider path is appended to it, not
  // substituted for it, so a gateway mounted under a subpath keeps working.
  const prefix = proxy.pathname.replace(/\/+$/, '');
  return `${proxy.origin}${prefix}${target.pathname}${target.search}`;
}

/**
 * Whole-hostname match. `endsWith` alone is the bug that lets `api.openai.com.attacker.test` in.
 *
 * Exported, and deliberately self-contained — no imports, no closure, nothing TypeScript-only —
 * because `install.ts` serialises this function into the hook that runs inside the agent's own
 * process, where it cannot import anything of ours.
 */
export function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const want = pattern.trim().toLowerCase();
  if (want === '') return false;
  if (want.startsWith('*.')) {
    const parent = want.slice(2);
    // A subdomain only: the label boundary is part of the comparison, and the bare parent is not
    // covered — someone who wants both says so twice.
    return host.endsWith(`.${parent}`) && host.length > parent.length + 1;
  }
  return host === want;
}
