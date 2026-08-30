/**
 * Placeholder key for runs where the user has no credential in the environment. The proxy is
 * holding the real one (or serving from a trace), but SDK clients refuse to start without
 * *something* — so an obviously-fake value beats an empty string that looks like a real key.
 */
export const PLACEHOLDER_KEY = 'orca-recorded';

/** An env var set to the empty string is unset for our purposes: an empty key breaks clients. */
export function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value !== '' ? value : undefined;
}

/** Joins a path onto the proxy url without producing `//`, whether or not the base ends in `/`. */
export function proxyBase(proxyUrl: string, path = ''): string {
  const base = proxyUrl.replace(/\/+$/, '');
  return path ? `${base}/${path.replace(/^\/+/, '')}` : base;
}

/** Copies `name` from the run environment into the launch overlay, or a placeholder if unset. */
export function passKey(
  target: Record<string, string>,
  env: Record<string, string | undefined>,
  name: string,
): void {
  target[name] = readEnv(env, name) ?? PLACEHOLDER_KEY;
}

/** Copies `name` only if it is actually set — used for optional tokens we must not invent. */
export function passThrough(
  target: Record<string, string>,
  env: Record<string, string | undefined>,
  name: string,
): void {
  const value = readEnv(env, name);
  if (value !== undefined) target[name] = value;
}

/**
 * Point base-URL variables orca does not know about at the proxy.
 *
 * Read from `ORCA_BASE_URL_VARS`: a comma-separated list of variable names, each optionally with
 * `=<path>` when the origin is not OpenAI-shaped. `/v1` is the default suffix because that is what
 * an OpenAI-compatible override wants, and it is what every example in the wild ends in.
 *
 * This exists because enumerating them is hopeless. Hermes alone overrides per provider —
 * `NOVITA_BASE_URL`, `GLM_BASE_URL`, `KIMI_BASE_URL`, `MINIMAX_BASE_URL`, `HF_BASE_URL`,
 * `NEBIUS_BASE_URL` and a dozen more in one `.env.example` — and a list of names baked in here
 * would be stale the week after it was written. A harness the author has never heard of is the
 * normal case, so it gets a mechanism rather than a pull request.
 *
 * The variable is consumed, never forwarded: it names other variables and means nothing downstream.
 */
export function applyNamedBaseUrls(
  target: Record<string, string>,
  env: Record<string, string | undefined>,
  proxyUrl: string,
): void {
  for (const entry of (readEnv(env, 'ORCA_BASE_URL_VARS') ?? '').split(',')) {
    const [rawName, rawPath] = entry.split('=');
    const name = (rawName ?? '').trim();
    if (name === '') continue;
    // A path of `/` means the bare origin. `proxyBase` would otherwise leave the separator behind
    // and hand the harness `http://host:port/`, which some clients then join into a double slash.
    const path = (rawPath ?? 'v1').trim().replace(/^\/+|\/+$/g, '');
    target[name] = proxyBase(proxyUrl, path);
  }
}
