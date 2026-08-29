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
