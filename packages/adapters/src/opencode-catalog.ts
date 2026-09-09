/** Self-contained because the emitted OpenCode plugin embeds this function. */
export function collectOpenCodeApiBases(catalog: unknown): string[] {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const bases = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) bases.add(value.trim());
  };
  for (const value of Object.values(object(catalog))) {
    const provider = object(value);
    add(provider.api);
    for (const model of Object.values(object(provider.models))) {
      add(object(object(model).provider).api);
    }
  }
  return [...bases];
}

/** Fetch only public metadata, before installing capture; offline runs use the bundled list. */
export async function refreshOpenCodeApiBases(
  fallback: string[],
  refresh = true,
): Promise<string[]> {
  if (!refresh) return fallback;
  try {
    const response = await fetch('https://models.opencode.ai/api.json', {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
      credentials: 'omit',
    });
    if (!response.ok) throw new Error('catalog unavailable');
    const bases = collectOpenCodeApiBases(await response.json());
    if (!bases.length) throw new Error('empty catalog');
    return [...new Set([...fallback, ...bases])];
  } catch {
    // Do not print URLs/error bodies: a custom fetch implementation may include credentials.
    console.warn('[orca] OpenCode API catalog unavailable; using bundled capture endpoints.');
    return fallback;
  }
}
