/**
 * Defensive accessors for wire bodies.
 *
 * Every function here takes `unknown` and never throws. Translation runs on bytes captured from
 * a live proxy: half of them will be shapes this code has never seen, and a debugger that dies on
 * an unfamiliar field is worse than useless.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Drop keys whose value is undefined so wire bodies never carry `"key": undefined`. */
export function omitUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Every key of `body` that translation did not consume, so it can be restored verbatim. */
export function unknownKeys(
  body: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  let found = false;
  for (const [k, v] of Object.entries(body)) {
    if (known.has(k)) continue;
    extra[k] = v;
    found = true;
  }
  return found ? extra : undefined;
}

/**
 * Parse accumulated tool-call JSON without ever throwing.
 *
 * A truncated or malformed argument string is a real thing that happens mid-stream and after a
 * model goes off the rails; losing it would erase the evidence. Keep it under `_raw` instead.
 */
export function parseToolInput(json: string): unknown {
  const trimmed = json.trim();
  if (trimmed === '') return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // A bare scalar is not a valid tool input object; keep the evidence rather than pretend.
    if (typeof parsed === 'object' && parsed !== null) return parsed;
    return { _raw: json };
  } catch {
    return { _raw: json };
  }
}

/** Serialize a canonical tool input back to the JSON string OpenAI-shaped APIs expect. */
export function stringifyToolInput(input: unknown): string {
  const rec = asRecord(input);
  const raw = rec['_raw'];
  // `{_raw: "..."}` is the marker parseToolInput leaves for arguments that were not valid JSON,
  // so emit it verbatim. But a model may legitimately name a parameter `_raw`: if the string
  // parses as a JSON object it is real data and must be re-serialized, not unwrapped.
  if (typeof raw === 'string' && Object.keys(rec).length === 1 && !isJsonObject(raw)) return raw;
  if (input === undefined) return '{}';
  try {
    return JSON.stringify(input) ?? '{}';
  } catch {
    return '{}';
  }
}

function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}
