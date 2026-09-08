/**
 * Which hosts a TLS-intercepting run may decrypt.
 *
 * This is the whole safety argument for the feature. A proxy that terminates TLS for everything
 * the agent touches is a keylogger with a nice CLI: the agent's shell runs `git push`, `pip
 * install`, `gh auth login`, and a debugger has no business reading any of it. So interception is
 * an allowlist, the default holds model APIs only, and every host outside it is tunnelled as
 * opaque bytes — orca sees the address it connected to and nothing else.
 *
 * The list is overridable, because the whole reason the feature exists is a harness talking to an
 * endpoint we did not predict. It is not overridable with `*`.
 */

/**
 * The hosts orca will decrypt when nobody says otherwise: model APIs, and only model APIs.
 *
 * Deliberately absent: `auth.openai.com` and every other sign-in origin. The OAuth flow a
 * subscription login runs through is where the credential itself crosses the wire, and the point
 * of intercepting a Codex CLI is to read its *model* traffic. Decrypting the login would hand a
 * trace the one secret this project works hardest never to record.
 */
export const DEFAULT_TLS_HOSTS: readonly string[] = [
  'api.openai.com',
  // The subscription path — a Codex CLI signed in with a ChatGPT plan posts to the backend API
  // here rather than to api.openai.com, and reads no base-URL variable on the way. It is the
  // concrete case this feature was built for.
  'chatgpt.com',
  '*.chatgpt.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.x.ai',
  'api.deepseek.com',
  'api.mistral.ai',
  'api.groq.com',
  'api.cohere.com',
  'api.fireworks.ai',
  'api.together.xyz',
  'openrouter.ai',
  // Xiaomi's, reached by MiMo Code's built-in `xiaomi/*` and `mimo/*` models. Named individually
  // rather than as `*.xiaomimimo.com`, because the wildcard would also cover
  // `platform.xiaomimimo.com` -- the console where the API key is issued, which is exactly the
  // kind of origin the paragraph above promises to leave alone. `tracking.miui.com` is MiMo's
  // telemetry and stays tunnelled for the same reason.
  'api.xiaomimimo.com',
  // The token-plan endpoints, one per region. All three are in the shipped binary alongside
  // `api.xiaomimimo.com`; without them a run on a token plan is decrypted for none of its
  // traffic, which reads as "orca recorded nothing" rather than as a missing host.
  'token-plan-cn.xiaomimimo.com',
  'token-plan-sgp.xiaomimimo.com',
  'token-plan-ams.xiaomimimo.com',
  // Kilo's own gateway, which its built-in `kilo/*` models route through. Kilo also posts to
  // `us.i.posthog.com`; that is not a model API and stays tunnelled.
  'api.kilo.ai',
  // Nous Research's, reached by Hermes on its own models. The inference host only: sign-in,
  // billing and subscription management are on `portal.nousresearch.com`, which is where the API
  // key is issued and is the kind of origin this list exists to leave alone.
  'inference-api.nousresearch.com',
];

/**
 * What the operator asked for, resolved against the defaults.
 *
 * `--tls-hosts a,b` has always meant "decrypt exactly these", which is the right default for a
 * feature whose safety argument is the list itself. It is the wrong shape for the commonest real
 * request — "the usual model APIs, plus the one endpoint my agent talks to" — and someone who
 * reached for that got the strict reading instead: naming one host dropped the other twelve, and
 * the run under-captured in silence.
 *
 * A leading `+` asks for the other meaning. Mixing the two forms is refused rather than resolved,
 * because the two readings disagree about every host the operator did not name, and guessing would
 * produce a policy nobody asked for.
 */
export function resolveTlsHosts(
  requested: readonly string[],
  /**
   * What `+host` adds to, and what an empty request falls back to.
   *
   * Defaults to the model API hosts. A replay passes the list its recording decrypted instead, so
   * `--tls-hosts '+extra'` on a run recorded with a custom list adds to *that* list rather than
   * silently swapping it for the defaults — which would stop decrypting the host the recording
   * needs and report `reused=0/n`.
   */
  base: readonly string[] = DEFAULT_TLS_HOSTS,
): string[] {
  const entries = requested.map((h) => h.trim()).filter((h) => h !== '');
  if (entries.length === 0) return [...base];

  const additive = entries.filter((h) => h.startsWith('+'));
  if (additive.length === 0) return entries;
  if (additive.length !== entries.length) {
    const plain = entries.filter((h) => !h.startsWith('+'));
    throw new Error(
      `--tls-hosts mixes "${plain[0]}" with "${additive[0]}": a bare host replaces the default ` +
        'list and a "+host" adds to it, so together they disagree about every host you did not ' +
        'name. Mark all of them with + to add, or none to replace.',
    );
  }

  // A bare `+` names nothing; dropping it beats minting an empty pattern that `HostPolicy` would
  // then reject with an error about a list the operator never typed.
  const added = additive.map((h) => h.slice(1).trim()).filter((h) => h !== '');
  const seen = new Set(base.map((h) => h.toLowerCase()));
  const extra: string[] = [];
  for (const host of added) {
    const key = host.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(host);
  }
  return [...base, ...extra];
}

interface Pattern {
  /** Lower-case host, or the suffix after `*.` for a wildcard. */
  host: string;
  wildcard: boolean;
  /** Undefined means any port. */
  port?: number;
  /** The pattern as written, for reporting. */
  source: string;
}

/** Trailing dots and case are not part of a host's identity; normalize both away. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

function parsePattern(source: string): Pattern {
  const text = source.trim();
  if (text.length === 0) throw new Error('empty host pattern');

  // Split on the last colon so a bracketed IPv6 literal survives.
  let hostPart = text;
  let port: number | undefined;
  const colon = text.lastIndexOf(':');
  if (colon > text.lastIndexOf(']') && colon !== -1) {
    const tail = text.slice(colon + 1);
    if (/^\d+$/.test(tail)) {
      hostPart = text.slice(0, colon);
      port = Number(tail);
    }
  }

  const host = normalizeHost(hostPart.replace(/^\[|\]$/g, ''));

  if (host === '*') {
    throw new Error(
      `"${source}" would intercept every host the agent talks to. ` +
        'Name the model API hosts you want decrypted instead.',
    );
  }
  if (host.startsWith('*.')) {
    const suffix = host.slice(2);
    if (suffix.split('.').filter(Boolean).length < 2) {
      throw new Error(
        `"${source}" is too broad: a wildcard needs at least a domain and a suffix, ` +
          'as in *.chatgpt.com.',
      );
    }
    return port === undefined
      ? { host: suffix, wildcard: true, source }
      : { host: suffix, wildcard: true, port, source };
  }
  if (host.includes('*')) {
    throw new Error(`"${source}" is not a host pattern; wildcards go at the front, as in *.x.com`);
  }
  return port === undefined
    ? { host, wildcard: false, source }
    : { host, wildcard: false, port, source };
}

/** The decision "decrypt this connection, or pipe it through untouched". */
export class HostPolicy {
  readonly #patterns: Pattern[];

  private constructor(patterns: Pattern[]) {
    this.#patterns = patterns;
  }

  static from(patterns: readonly string[]): HostPolicy {
    const parsed = patterns.map(parsePattern);
    if (parsed.length === 0) {
      throw new Error(
        'TLS interception needs at least one host to intercept. ' +
          'An empty list is ambiguous where a policy must not be.',
      );
    }
    return new HostPolicy(parsed);
  }

  allows(host: string, port: number): boolean {
    const target = normalizeHost(host);
    return this.#patterns.some((p) => {
      if (p.port !== undefined && p.port !== port) return false;
      if (!p.wildcard) return p.host === target;
      // The dot is what keeps `*.chatgpt.com` from covering `evilchatgpt.com`.
      return target.endsWith(`.${p.host}`);
    });
  }

  /** What the run is about to decrypt, for the line that says so before it starts. */
  describe(): string {
    return this.#patterns.map((p) => p.source).join(', ');
  }
}
