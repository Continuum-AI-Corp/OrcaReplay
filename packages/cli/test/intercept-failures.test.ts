import { describe, expect, it } from 'vitest';
import type { InterceptFailure } from '@orcareplay/proxy';
import { Output, type LogEntry } from '../src/out.js';
import { reportInterceptFailure } from '../src/tls-capture.js';

/**
 * ONE EVENT NAME PER THING THAT ACTUALLY HAPPENED.
 *
 * Interception reported everything it could go wrong with as `tls.handshake_failed`: a body that
 * would not decompress, a WebSocket upgrade declined, an h2 stream faulting mid-session, and — the
 * one an operator most needs to recognise — a client refusing the certificate orca presented.
 *
 * That last case is the reason the name mattered. It happens on the *client* side of the proxy, but
 * "handshake failed" with an `h2 session:` prefix reads as a problem between orca and the origin, so
 * the operator goes looking at the network and the upstream. The fix is on the other side of the
 * connection: the run CA is not in the agent's trust store. Meanwhile nothing from that host is
 * recorded, and the trace looks quiet rather than broken.
 */
describe('what interception reports, by what actually failed', () => {
  function report(kind: InterceptFailure['kind']): LogEntry {
    const logs: LogEntry[] = [];
    const out = new Output({ write: () => {}, sink: (e) => void logs.push(e), isTTY: false });
    reportInterceptFailure(out, { host: 'api.example.com', port: 443, reason: 'r', kind });
    expect(logs, `nothing was reported for ${kind}`).toHaveLength(1);
    return logs[0]!;
  }

  it('gives each kind its own name, so the name is what can be grepped', () => {
    expect(report('client_handshake').event).toBe('tls.handshake_failed');
    expect(report('upstream_session').event).toBe('tls.upstream_failed');
    expect(report('body_opaque').event).toBe('net.body_opaque');
    expect(report('upgrade_refused').event).toBe('net.upgrade_refused');
    expect(report('session').event).toBe('tls.session_error');
  });

  /**
   * The remedy is the whole point of telling this one apart, and it is not on the side of the
   * connection the old name pointed at.
   */
  it('sends a refused certificate to the agent’s trust store, not to the network', () => {
    const entry = report('client_handshake');
    const fields = entry.fields as Record<string, string>;
    expect(fields['cause']).toMatch(/trust store/);
    expect(fields['next']).toMatch(/NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|SSL_CERT_FILE/);
    // And that the run is losing that host entirely, which the trace will not otherwise show.
    expect(fields['effect']).toMatch(/api\.example\.com/);
  });

  /**
   * A body kept as it arrived is not a connection failure. Reporting it as one sent people to the
   * TLS layer for something that lost nothing.
   */
  it('does not dress an undecodable body up as a connection failure', () => {
    const entry = report('body_opaque');
    expect(entry.event).not.toMatch(/handshake/);
    expect((entry.fields as Record<string, string>)['effect']).toMatch(/recorded/);
  });

  it('carries the host and port through on every kind', () => {
    for (const kind of [
      'client_handshake',
      'upstream_session',
      'body_opaque',
      'upgrade_refused',
      'session',
    ] as const) {
      const fields = report(kind).fields as Record<string, unknown>;
      expect(fields['host'], kind).toBe('api.example.com');
      expect(fields['port'], kind).toBe(443);
      // `kind` is how the report was chosen; repeating it in the output would be noise.
      expect(fields['kind'], kind).toBeUndefined();
    }
  });
});
