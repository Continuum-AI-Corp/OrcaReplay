import { describe, expect, it } from 'vitest';
import { advertisedUrl, attachExports, attachInstructions } from '../src/attach.js';

/**
 * Recording an agent orca does not launch.
 *
 * Every capture mechanism here so far ends in a child process: the adapter builds an environment
 * and orca spawns the agent inside it. That is the whole design, and it has one boundary it cannot
 * cross — an agent that is not on this machine. A bot on a VPS, an agent inside a dev container or
 * a cloud sandbox, a harness someone else's CI runs: orca has no process to spawn, so it has no
 * environment to build.
 *
 * What it can still do is be *reachable*, and say exactly what to set. The proxy already accepts a
 * bind address; what was missing was the other half — the block of variables the operator pastes
 * on the far side, which is the part that has to be right or the run records nothing.
 */
describe('the address a remote agent is told to use', () => {
  it('uses the bind address when it is one an agent could dial', () => {
    expect(advertisedUrl({ bind: '10.0.0.5', port: 8080 })).toBe('http://10.0.0.5:8080');
  });

  /**
   * `0.0.0.0` means "every interface I have", which is a statement about listening. As an address
   * to connect *to* it is meaningless, and an agent handed `http://0.0.0.0:8080` fails in a way
   * that looks like orca is broken rather than like the flag was incomplete.
   */
  it('refuses to advertise a wildcard, which is not an address anything can reach', () => {
    expect(() => advertisedUrl({ bind: '0.0.0.0', port: 8080 })).toThrow(/--advertise/);
    expect(() => advertisedUrl({ bind: '::', port: 8080 })).toThrow(/--advertise/);
  });

  it('takes an explicit advertised host over the bind address', () => {
    expect(advertisedUrl({ bind: '0.0.0.0', port: 8080, advertise: 'orca.internal' })).toBe(
      'http://orca.internal:8080',
    );
  });

  it('keeps a port the operator wrote into the advertised host', () => {
    // Behind a port-mapped container the outside port is not the one orca bound.
    expect(advertisedUrl({ bind: '0.0.0.0', port: 8080, advertise: 'localhost:19000' })).toBe(
      'http://localhost:19000',
    );
  });

  it('brackets a bare IPv6 literal, which is not a URL host without them', () => {
    expect(advertisedUrl({ bind: 'fd00::1', port: 8080 })).toBe('http://[fd00::1]:8080');
  });

  /**
   * An IPv6 literal is mostly colons, so "does this host already carry a port" cannot be answered
   * by looking for the last one. Getting it wrong drops the port entirely and hands the sandbox
   * `http://fd00::1`, which resolves to port 80 and connects to nothing.
   */
  it('does not mistake the tail of a bare IPv6 address for a port', () => {
    expect(advertisedUrl({ bind: '0.0.0.0', port: 8080, advertise: 'fd00::1' })).toBe(
      'http://[fd00::1]:8080',
    );
    expect(advertisedUrl({ bind: '0.0.0.0', port: 8080, advertise: '::1' })).toBe(
      'http://[::1]:8080',
    );
  });

  it('keeps a port written after a bracketed IPv6 host', () => {
    expect(advertisedUrl({ bind: '0.0.0.0', port: 8080, advertise: '[fd00::1]:19000' })).toBe(
      'http://[fd00::1]:19000',
    );
  });
});

describe('what a remote agent has to be told', () => {
  const proxyUrl = 'http://10.0.0.5:8080';

  it('points the agent at the proxy through the ordinary variables', () => {
    const env = attachExports({ proxyUrl, adapterEnv: { OPENAI_BASE_URL: `${proxyUrl}/v1` } });
    expect(env.OPENAI_BASE_URL).toBe('http://10.0.0.5:8080/v1');
  });

  it('adds the proxy and the CA when the run is intercepting', () => {
    const env = attachExports({
      proxyUrl,
      adapterEnv: {},
      ca: { certPath: '/runs/r1/tls/ca.crt', bundlePath: '/runs/r1/tls/ca-bundle.crt' },
      remoteCaPath: '/tmp/orca-ca.crt',
    });
    expect(env.HTTPS_PROXY).toBe(proxyUrl);
    expect(env.https_proxy).toBe(proxyUrl);
    // Every path is the one the file will have *there*, never the one it has here. Printing this
    // machine's path would produce a block that runs cleanly and trusts nothing.
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/tmp/orca-ca.crt');
    expect(env.SSL_CERT_FILE).toBe('/tmp/orca-ca.crt');
    expect(env.REQUESTS_CA_BUNDLE).toBe('/tmp/orca-ca.crt');
    expect(env.CURL_CA_BUNDLE).toBe('/tmp/orca-ca.crt');
  });

  it('sets no CA variable when nothing is being intercepted', () => {
    const env = attachExports({ proxyUrl, adapterEnv: { OPENAI_BASE_URL: `${proxyUrl}/v1` } });
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  /**
   * A sandbox that cannot reach the proxy is the failure this whole command exists to avoid, and
   * `NO_PROXY` inherited from the operator's shell is a good way to cause it silently.
   */
  it('does not carry the local NO_PROXY into the sandbox', () => {
    const env = attachExports({
      proxyUrl,
      adapterEnv: {},
      ca: { certPath: '/a/ca.crt', bundlePath: '/a/b.crt' },
      remoteCaPath: '/tmp/ca.crt',
    });
    expect(env.NO_PROXY).toBeUndefined();
  });
});

describe('the block the operator pastes', () => {
  it('is shell-pasteable, one export per line', () => {
    const lines = attachInstructions({
      proxyUrl: 'http://10.0.0.5:8080',
      adapterEnv: { OPENAI_BASE_URL: 'http://10.0.0.5:8080/v1' },
    });
    expect(lines).toContain("export OPENAI_BASE_URL='http://10.0.0.5:8080/v1'");
  });

  it('quotes a value so a shell cannot reinterpret it', () => {
    const lines = attachInstructions({
      proxyUrl: 'http://h:1',
      adapterEnv: { WEIRD: "a b$(echo hi)'c" },
    });
    expect(lines.join('\n')).toContain(`'a b$(echo hi)'\\''c'`);
  });

  /**
   * The bundle rather than the bare certificate, and the distinction is not cosmetic.
   *
   * `SSL_CERT_FILE` and its siblings *replace* an OpenSSL client's trust store rather than adding
   * to it. A sandbox handed only `ca.crt` would trust the run CA and nothing else, so every host
   * orca deliberately does not intercept — the package index, the git remote — would stop
   * verifying. The bundle is the run CA plus the public roots, which is why one file is safe to
   * ship and safe to point all of them at.
   */
  it('says to copy the CA bundle across first, because the paths are remote', () => {
    const lines = attachInstructions({
      proxyUrl: 'http://10.0.0.5:8080',
      adapterEnv: {},
      ca: { certPath: '/runs/r1/tls/ca.crt', bundlePath: '/runs/r1/tls/ca-bundle.crt' },
      remoteCaPath: '/tmp/orca-ca.crt',
    });
    const text = lines.join('\n');
    expect(text).toContain('/runs/r1/tls/ca-bundle.crt');
    expect(text).not.toContain('/runs/r1/tls/ca.crt ');
    expect(text).toContain('/tmp/orca-ca.crt');
    expect(text).toMatch(/copy/i);
  });

  it('mentions no certificate authority when there is none to copy', () => {
    const text = attachInstructions({
      proxyUrl: 'http://h:1',
      adapterEnv: { OPENAI_BASE_URL: 'http://h:1/v1' },
    }).join('\n');
    expect(text).not.toMatch(/ca-bundle\.crt/);
  });
});
