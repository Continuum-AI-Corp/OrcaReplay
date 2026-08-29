import { describe, expect, it } from 'vitest';
import { DEFAULT_TLS_HOSTS, HostPolicy } from '../src/tls-hosts.js';

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

  it('lists what it will intercept, so the run can say so out loud', () => {
    expect(HostPolicy.from(['api.openai.com', '*.chatgpt.com']).describe()).toBe(
      'api.openai.com, *.chatgpt.com',
    );
  });
});
