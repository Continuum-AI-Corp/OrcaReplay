import { createHash, randomBytes } from 'node:crypto';
import type { RedactionRecord } from '@orcareplay/schema';

/** Bump when a rule is added or changed, so old traces stay interpretable. */
// Bumped when a rule's *name* or pattern changes, because both reach the trace: the placeholder is
// `<secret:<kind>:<hash>>`, and a reader comparing two traces needs to know the policy differed
// rather than the content. v2 renamed `openai_key` to `sk_api_key`.
export const REDACTION_POLICY_VERSION = 2;

/** Environment capture is allowlist-only (spec §5). Everything else is denied. */
export const DEFAULT_ENV_ALLOWLIST = [
  'TERM',
  'LANG',
  'LC_ALL',
  'PATH',
  'HOME',
  'SHELL',
  'TZ',
  'USER',
  'PWD',
];

/**
 * Request headers whose value is never written, whatever it looks like (spec §5).
 *
 * The single list. There were three — here, in the recording proxy, and in the TLS interceptor —
 * and they had drifted: `api-key` and `x-goog-api-key` were known to exactly one of them, so the
 * same Azure or Google credential was stripped on the intercepted path and written on the recorded
 * one. Nothing about a header set that has to stay identical in three places will keep it that
 * way, so it is defined once and imported.
 */
export const AUTH_REQUEST_HEADERS = [
  'authorization',
  'x-api-key',
  // Azure OpenAI sends the key under its own name, and Google under another.
  'api-key',
  'x-goog-api-key',
  'cookie',
  'proxy-authorization',
];

/** A response can hand out credentials too. `set-cookie` is a session, not metadata. */
export const AUTH_RESPONSE_HEADERS = ['set-cookie'];

/** Every header name whose value is never written, in either direction. */
export const AUTH_HEADERS = [...AUTH_REQUEST_HEADERS, ...AUTH_RESPONSE_HEADERS];

interface Rule {
  kind: string;
  pattern: RegExp;
}

/**
 * Order matters: a PEM block or a JWT contains base64 that the narrower rules would otherwise
 * chew into pieces, leaving fragments of key material on disk.
 */
const RULES: Rule[] = [
  {
    kind: 'private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { kind: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // `sk-` is not an OpenAI prefix, it is the convention half the industry copied: OpenAI's
  // `sk-proj-`, Anthropic's `sk-ant-`, OrcaRouter's `sk-orca-` and a dozen gateways all match here.
  // The rule name reaches the trace, `redactions.json` and the placeholder, so calling every one of
  // them an OpenAI key told a reader something false about where their credential came from.
  { kind: 'sk_api_key', pattern: /sk-[A-Za-z0-9_-]{16,}/g },
  // Every GitHub credential prefix, `ghr_` (refresh) included: it outlives the access token it
  // renews, so leaving it to the entropy sweep would miss the longest-lived secret of the set.
  { kind: 'github_token', pattern: /gh[posur]_[A-Za-z0-9]{20,}/g },
  { kind: 'aws_access_key_id', pattern: /AKIA[0-9A-Z]{16}/g },
  { kind: 'slack_token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google_api_key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
];

const TOKEN = /[A-Za-z0-9_-]{20,}/g;
const PLACEHOLDER = /<secret:[a-z_]+:[0-9a-f]{8}>/g;
const MIN_ENTROPY_LENGTH = 20;
const ENTROPY_BITS_PER_CHAR = 4.0;

/** Shannon entropy of the token's own character distribution, in bits per character. */
function entropy(token: string): number {
  const freq = new Map<string, number>();
  for (const ch of token) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * A long identifier clears 4 bits/char on length alone: `getUserAuthenticationTokenFromRequest`
 * scores 4.08. Agent traces are mostly source code, so redacting identifiers would corrupt the
 * payloads the trace exists to preserve. Requiring both digits and letters keeps every random
 * token (base64url has a digit with p≈0.98 at 20 chars) and drops prose-shaped ones.
 */
function looksRandom(token: string): boolean {
  return /[0-9]/.test(token) && /[A-Za-z]/.test(token);
}

function spansOf(value: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const m of value.matchAll(PLACEHOLDER)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

export interface RedactionOptions {
  /** Per-run salt. Defaults to fresh randomness, and is deliberately never persisted. */
  salt?: string;
  /** Replaces {@link DEFAULT_ENV_ALLOWLIST} outright — this is a deny-by-default control. */
  envAllowlist?: string[];
}

export interface RedactionResult<T> {
  value: T;
  hits: RedactionRecord[];
}

/**
 * Write-path redactor (spec §5).
 *
 * The placeholder is `<secret:kind:hash8>` where hash8 is sha256(salt + secret) truncated, so the
 * same secret always yields the same placeholder — replay still matches structurally — while the
 * secret itself is unrecoverable. The salt is per run and never written down, which is what stops
 * a short secret from being brute-forced out of a published trace.
 */
export class Redactor {
  readonly #salt: string;
  readonly #envAllowlist: Set<string>;
  readonly #records = new Map<string, RedactionRecord>();

  constructor(opts: RedactionOptions = {}) {
    this.#salt = opts.salt ?? randomBytes(16).toString('hex');
    this.#envAllowlist = new Set(opts.envAllowlist ?? DEFAULT_ENV_ALLOWLIST);
  }

  redactString(s: string, context?: string): RedactionResult<string> {
    const hits = new Map<string, RedactionRecord>();
    const value = this.#scan(s, context, hits);
    this.#merge(hits);
    return { value, hits: [...hits.values()] };
  }

  redactHeaders(headers: Record<string, string>): RedactionResult<Record<string, string>> {
    const hits = new Map<string, RedactionRecord>();
    const value: Record<string, string> = {};
    for (const [name, raw] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      const context = `header:${lower}`;
      value[name] = AUTH_HEADERS.includes(lower)
        ? this.#hit(`header_${lower.replace(/-/g, '_')}`, raw, context, hits)
        : this.#scan(raw, context, hits);
    }
    this.#merge(hits);
    return { value, hits: [...hits.values()] };
  }

  redactEnv(env: Record<string, string | undefined>): Record<string, string> {
    const hits = new Map<string, RedactionRecord>();
    const out: Record<string, string> = {};
    for (const key of this.#envAllowlist) {
      const raw = env[key];
      if (raw === undefined) continue;
      out[key] = this.#scan(raw, `env:${key}`, hits);
    }
    this.#merge(hits);
    return out;
  }

  /** Every removal so far, aggregated by rule and identifier. Never contains a value. */
  records(): RedactionRecord[] {
    return [...this.#records.values()].map((r) => ({ ...r }));
  }

  rulesFired(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.#records.values()) out[r.rule] = (out[r.rule] ?? 0) + r.count;
    return out;
  }

  #scan(input: string, context: string | undefined, hits: Map<string, RedactionRecord>): string {
    let value = input;
    for (const rule of RULES) {
      value = value.replace(rule.pattern, (m) => this.#hit(rule.kind, m, context, hits));
    }
    return this.#scanEntropy(value, context, hits);
  }

  #scanEntropy(
    value: string,
    context: string | undefined,
    hits: Map<string, RedactionRecord>,
  ): string {
    // Placeholders already written by the pattern rules must not be rescanned as tokens.
    const spans = spansOf(value);
    let out = '';
    let cut = 0;
    for (const m of value.matchAll(TOKEN)) {
      const token = m[0];
      const start = m.index;
      if (spans.some(([a, b]) => start >= a && start < b)) continue;
      if (token.length < MIN_ENTROPY_LENGTH || !looksRandom(token)) continue;
      if (entropy(token) <= ENTROPY_BITS_PER_CHAR) continue;
      out += value.slice(cut, start) + this.#hit('high_entropy', token, context, hits);
      cut = start + token.length;
    }
    return out + value.slice(cut);
  }

  #hit(
    kind: string,
    secret: string,
    context: string | undefined,
    hits: Map<string, RedactionRecord>,
  ): string {
    const hash8 = createHash('sha256').update(this.#salt).update(secret).digest('hex').slice(0, 8);
    const placeholder = `<secret:${kind}:${hash8}>`;
    const identifier = context ? `${context}:${hash8}` : hash8;
    // `\0` as an escape, not a raw NUL byte: a literal NUL in the source makes git classify
    // this file as binary, so every diff of the redactor — the one file that most needs reading in
    // review — comes out as "Bin 7248 -> 7441 bytes" instead of lines.
    const key = `${kind}\0${identifier}`;
    const seen = hits.get(key);
    if (seen) seen.count += 1;
    else hits.set(key, { rule: kind, identifier, placeholder, count: 1 });
    return placeholder;
  }

  #merge(hits: Map<string, RedactionRecord>): void {
    for (const [key, hit] of hits) {
      const seen = this.#records.get(key);
      if (seen) seen.count += hit.count;
      else this.#records.set(key, { ...hit });
    }
  }
}
