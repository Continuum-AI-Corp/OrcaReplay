import { describe, expect, it } from 'vitest';
import { DEFAULT_TLS_HOSTS, HostPolicy, resolveTlsHosts } from '../src/tls-hosts.js';

/**
 * Which hosts a `--tls-intercept` run is allowed to decrypt.
 *
 * This is the part of the feature that decides whether orca is a model debugger or a general
 * wiretap. Everything not named here is tunnelled opaquely, so the tests below are less about
 * matching semantics than about what the tool refuses to look at.
 */
describe('TLS interception host policy', () => {
  it('intercepts a host named exactly', () => {
    const policy = HostPolicy.from(['api.openai.com']);
    expect(policy.allows('api.openai.com', 443)).toBe(true);
    expect(policy.allows('api.anthropic.com', 443)).toBe(false);
  });

  it('ignores case and a trailing dot, which resolve to the same host', () => {
    const policy = HostPolicy.from(['API.OpenAI.com']);
    expect(policy.allows('api.openai.com', 443)).toBe(true);
    expect(policy.allows('api.openai.com.', 443)).toBe(true);
  });

  it('matches subdomains under a wildcard but not the apex', () => {
    const policy = HostPolicy.from(['*.chatgpt.com']);
    expect(policy.allows('backend.chatgpt.com', 443)).toBe(true);
    expect(policy.allows('a.b.chatgpt.com', 443)).toBe(true);
    expect(policy.allows('chatgpt.com', 443)).toBe(false);
    // The suffix has to end at a label boundary, or `*.chatgpt.com` would cover
    // `evilchatgpt.com` — a host someone else controls.
    expect(policy.allows('evilchatgpt.com', 443)).toBe(false);
  });

  it('pins a pattern to one port when the pattern names one', () => {
    const policy = HostPolicy.from(['127.0.0.1:8443']);
    expect(policy.allows('127.0.0.1', 8443)).toBe(true);
    expect(policy.allows('127.0.0.1', 9443)).toBe(false);
  });

  it('refuses a bare wildcard, which is a request to decrypt everything', () => {
    expect(() => HostPolicy.from(['*'])).toThrow(/every host/i);
    expect(() => HostPolicy.from(['*:443'])).toThrow(/every host/i);
    expect(() => HostPolicy.from(['*.com'])).toThrow(/too broad/i);
  });

  it('rejects an empty list rather than silently intercepting nothing or everything', () => {
    expect(() => HostPolicy.from([])).toThrow(/at least one host/i);
  });

  it('defaults to model API hosts and nothing else', () => {
    const policy = HostPolicy.from(DEFAULT_TLS_HOSTS);
    expect(policy.allows('api.openai.com', 443)).toBe(true);
    expect(policy.allows('api.anthropic.com', 443)).toBe(true);
    expect(policy.allows('chatgpt.com', 443)).toBe(true);

    for (const host of [
      'chase.com',
      'accounts.google.com',
      'github.com',
      'login.microsoftonline.com',
    ]) {
      expect(policy.allows(host, 443), `${host} must not be intercepted by default`).toBe(false);
    }
  });

  it('leaves the OpenAI sign-in host alone, because that flow carries the credential itself', () => {
    const policy = HostPolicy.from(DEFAULT_TLS_HOSTS);
    expect(policy.allows('auth.openai.com', 443)).toBe(false);
  });

  /**
   * The same rule as the OpenAI sign-in host, on the vendor where the shortcut is tempting.
   *
   * MiMo Code reaches four model endpoints under `xiaomimimo.com` -- the API and one token-plan
   * host per region -- so `*.xiaomimimo.com` would be one line instead of four. It would also
   * decrypt `platform.xiaomimimo.com`, which is the console where the API key is issued, and that
   * is the origin this list exists to leave alone. The four are named individually for that
   * reason, and this is what stops the shortcut coming back.
   */
  it("decrypts a vendor's model endpoints without reaching its key console", () => {
    const policy = HostPolicy.from(DEFAULT_TLS_HOSTS);

    for (const host of [
      'api.xiaomimimo.com',
      'token-plan-cn.xiaomimimo.com',
      'token-plan-sgp.xiaomimimo.com',
      'token-plan-ams.xiaomimimo.com',
    ]) {
      expect(policy.allows(host, 443), `${host} is a model endpoint`).toBe(true);
    }

    // The console issues the credential; the tracker is not a model API at all.
    expect(policy.allows('platform.xiaomimimo.com', 443)).toBe(false);
    expect(policy.allows('tracking.miui.com', 443)).toBe(false);
  });

  it('lists what it will intercept, so the run can say so out loud', () => {
    expect(HostPolicy.from(['api.openai.com', '*.chatgpt.com']).describe()).toBe(
      'api.openai.com, *.chatgpt.com',
    );
  });
});

/**
 * Adding to the default list instead of replacing it.
 *
 * `--tls-hosts` replaced the defaults outright, which is the right shape for "decrypt exactly
 * these and nothing else" and the wrong one for the far more common "decrypt the usual model APIs,
 * plus this one endpoint my agent talks to". Someone reaching for the second got the first: naming
 * one host silently dropped the other twelve, and the run under-captured without saying so.
 *
 * A leading `+` is the difference, and the mistake it prevents is the reason the resolution lives
 * here rather than in the CLI — the policy and the meaning of the flag that builds it are one
 * decision.
 */
describe('resolving the requested host list', () => {
  it('falls back to the defaults when nothing is asked for', () => {
    expect(resolveTlsHosts([])).toEqual([...DEFAULT_TLS_HOSTS]);
  });

  it('replaces the defaults for a plain list, which is what naming hosts has always meant', () => {
    expect(resolveTlsHosts(['api.openai.com', 'api.x.ai'])).toEqual(['api.openai.com', 'api.x.ai']);
  });

  it('adds to the defaults when an entry is marked with +', () => {
    const hosts = resolveTlsHosts(['+grok.com']);
    expect(hosts).toEqual([...DEFAULT_TLS_HOSTS, 'grok.com']);
    // The point of the feature: the defaults survive.
    expect(HostPolicy.from(hosts).allows('api.anthropic.com', 443)).toBe(true);
    expect(HostPolicy.from(hosts).allows('grok.com', 443)).toBe(true);
  });

  it('adds several, and keeps them in the order they were named', () => {
    expect(resolveTlsHosts(['+grok.com', '+*.grok.com'])).toEqual([
      ...DEFAULT_TLS_HOSTS,
      'grok.com',
      '*.grok.com',
    ]);
  });

  it('never lists a default twice when one is added back explicitly', () => {
    const hosts = resolveTlsHosts(['+api.x.ai', '+grok.com']);
    expect(hosts.filter((h) => h === 'api.x.ai')).toHaveLength(1);
    expect(hosts).toContain('grok.com');
  });

  /**
   * Mixing the two is a contradiction — "use only these" and "keep the defaults too" in one flag —
   * and guessing which was meant would produce a policy the operator did not ask for. In a feature
   * whose entire safety argument is the host list, that is the one thing not to be clever about.
   */
  it('refuses a list that both replaces and adds, rather than picking one', () => {
    expect(() => resolveTlsHosts(['api.openai.com', '+grok.com'])).toThrow(/\+/);
    expect(() => resolveTlsHosts(['api.openai.com', '+grok.com'])).toThrow(
      /every host|all of them|mix/i,
    );
  });

  /**
   * A replay adds to what its recording decrypted, not to the defaults.
   *
   * Resolving `+extra` against `DEFAULT_TLS_HOSTS` on a run recorded with a custom list swaps that
   * list for the defaults, so the host the recording actually needs stops being decrypted and the
   * replay reports `reused=0/n` — the same confusing failure the inheritance was added to remove.
   */
  it('adds to the list a recording used, when one is given', () => {
    const recorded = ['127.0.0.1:8443'];
    expect(resolveTlsHosts(['+grok.example'], recorded)).toEqual([
      '127.0.0.1:8443',
      'grok.example',
    ]);
  });

  it('falls back to the recorded list when nothing is asked for', () => {
    expect(resolveTlsHosts([], ['127.0.0.1:8443'])).toEqual(['127.0.0.1:8443']);
  });

  it('still lets a plain list replace the recorded one, for narrowing by hand', () => {
    expect(resolveTlsHosts(['api.openai.com'], ['127.0.0.1:8443'])).toEqual(['api.openai.com']);
  });

  it('still refuses a wildcard that asks for everything, marked or not', () => {
    expect(() => HostPolicy.from(resolveTlsHosts(['+*']))).toThrow(/every host/);
    expect(() => HostPolicy.from(resolveTlsHosts(['*']))).toThrow(/every host/);
  });

  it('ignores a bare + with no host after it rather than adding an empty pattern', () => {
    expect(resolveTlsHosts(['+grok.com', '+'])).toEqual([...DEFAULT_TLS_HOSTS, 'grok.com']);
  });
});
