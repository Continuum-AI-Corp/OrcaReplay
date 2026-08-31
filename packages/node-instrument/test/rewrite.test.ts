import { describe, expect, it } from 'vitest';
import { DEFAULT_INSTRUMENTED_HOSTS, rewriteUrl } from '../src/rewrite.js';

/**
 * Which URLs get redirected at the recording proxy, and — more importantly — which do not.
 *
 * This runs inside someone else's agent, on every `fetch` it makes. Over-matching here does not
 * produce a missing trace, it produces an agent whose telemetry, package downloads or database
 * calls silently go to a local port. The allowlist is the whole safety story.
 */

const PROXY = 'http://127.0.0.1:44100';
const cfg = { proxyUrl: PROXY, hosts: DEFAULT_INSTRUMENTED_HOSTS };

describe('rewriteUrl', () => {
  it('redirects a hardcoded OpenAI origin, keeping path and query', () => {
    expect(rewriteUrl('https://api.openai.com/v1/chat/completions?x=1', cfg)).toBe(
      `${PROXY}/v1/chat/completions?x=1`,
    );
  });

  it('redirects the Anthropic origin too', () => {
    expect(rewriteUrl('https://api.anthropic.com/v1/messages', cfg)).toBe(`${PROXY}/v1/messages`);
  });

  it('redirects the Responses path, which is the one Codex and the Agents SDK use', () => {
    expect(rewriteUrl('https://api.openai.com/v1/responses', cfg)).toBe(`${PROXY}/v1/responses`);
  });

  it('leaves every other host alone', () => {
    for (const url of [
      'https://registry.npmjs.org/react',
      'https://telemetry.example.com/track',
      'https://api.openai.com.evil.test/v1/chat/completions',
      'https://notapi.openai.com/v1',
      'http://localhost:5432/db',
    ]) {
      expect(rewriteUrl(url, cfg), url).toBeUndefined();
    }
  });

  it('does not rewrite a request already addressed to the proxy', () => {
    // The agent may read a base-URL variable *and* be instrumented. Rewriting twice would be
    // harmless here but the guard is what stops a proxy pointed at itself from looping.
    expect(rewriteUrl(`${PROXY}/v1/messages`, cfg)).toBeUndefined();
  });

  it('matches a host exactly, never as a suffix', () => {
    // `evil-api.openai.com.attacker.test` must not match. A naive endsWith check is the bug.
    expect(rewriteUrl('https://x-api.anthropic.com/v1/messages', cfg)).toBeUndefined();
  });

  it('honours an explicit host list, including a subdomain wildcard', () => {
    const azure = { proxyUrl: PROXY, hosts: ['*.openai.azure.com'] };
    expect(rewriteUrl('https://contoso.openai.azure.com/openai/deployments/g/chat', azure)).toBe(
      `${PROXY}/openai/deployments/g/chat`,
    );
    // A wildcard covers subdomains, not the bare parent and not a lookalike suffix.
    expect(rewriteUrl('https://openai.azure.com/x', azure)).toBeUndefined();
    expect(rewriteUrl('https://evil-openai.azure.com.test/x', azure)).toBeUndefined();
  });

  it('keeps the proxy port and any path prefix the proxy was given', () => {
    const prefixed = { proxyUrl: 'http://127.0.0.1:8080/orca', hosts: DEFAULT_INSTRUMENTED_HOSTS };
    expect(rewriteUrl('https://api.openai.com/v1/responses', prefixed)).toBe(
      'http://127.0.0.1:8080/orca/v1/responses',
    );
  });

  it('never throws on a value that is not a URL', () => {
    for (const junk of ['', 'not a url', '///', 'data:text/plain,hi']) {
      expect(() => rewriteUrl(junk, cfg)).not.toThrow();
      expect(rewriteUrl(junk, cfg)).toBeUndefined();
    }
  });

  it('does nothing at all when no proxy is configured', () => {
    expect(
      rewriteUrl('https://api.openai.com/v1/responses', { proxyUrl: '', hosts: cfg.hosts }),
    ).toBeUndefined();
  });
});
