/**
 * The origin-prefixed path an adapter can hand a client whose base URL orca rewrites.
 *
 * Base-URL variables cover the harnesses that read one, and `--tls-intercept` covers the ones
 * that read none. Between them sits a third shape: a harness that resolves each *provider's*
 * origin itself — OpenCode picks a base URL per model out of its catalog — so no single
 * environment variable can name where the traffic was headed. The adapter rewrites that base URL
 * to `<proxy>/forward/<encoded base>`, and the request arrives carrying its own destination.
 *
 * Encoding is `encodeURIComponent` of the whole base URL, so a base with a path in it
 * (`https://opencode.ai/zen/go/v1`) survives as one opaque first segment and the path the SDK
 * appends (`/chat/completions`) stays readable after it.
 */
export interface ForwardPath {
  /** The base URL the request was actually addressed to, without a trailing slash. */
  base: string;
  /** What follows the prefix: the path the client appended to the base it was given. */
  path: string;
}

export const FORWARD_PREFIX = '/forward/';

/**
 * Decode a `/forward/` path, or undefined when it is not one.
 *
 * Every failure decodes to `undefined` rather than throwing, because the prefix sits in a
 * namespace any client can write to: a POST to `/forward/plain` from a harness that happens to
 * use that path must fall through to the ordinary handling — passthrough or dialect — and not
 * become a 500 from a bad `new URL`. The bar for "is one of ours" is deliberately high: the
 * segment must percent-decode to an absolute http(s) origin-or-base with no credentials, query
 * or fragment, which no ordinary API path collides with.
 */
export function decodeForwardPath(path: string): ForwardPath | undefined {
  if (!path.startsWith(FORWARD_PREFIX)) return undefined;
  const rest = path.slice(FORWARD_PREFIX.length);
  const separator = rest.indexOf('/');
  const encoded = separator === -1 ? rest : rest.slice(0, separator);
  const tail = separator === -1 ? '' : rest.slice(separator);

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined;
  }

  return { base: decoded.replace(/\/+$/, ''), path: tail === '' ? '/' : tail };
}

/** The path an adapter writes into a rewritten base URL: `<proxy>/forward/<encoded base>`. */
export function forwardBasePath(base: string): string {
  return `${FORWARD_PREFIX}${encodeURIComponent(base.replace(/\/+$/, ''))}`;
}
