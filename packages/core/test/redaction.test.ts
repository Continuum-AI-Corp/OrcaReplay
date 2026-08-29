import { describe, expect, it } from 'vitest';
import {
  AUTH_REQUEST_HEADERS,
  AUTH_RESPONSE_HEADERS,
  DEFAULT_ENV_ALLOWLIST,
  REDACTION_POLICY_VERSION,
  Redactor,
} from '../src/redaction.js';

const PLACEHOLDER = /^<secret:[a-z_]+:[0-9a-f]{8}>$/;

function fresh(): Redactor {
  return new Redactor({ salt: 'test-salt' });
}

describe('placeholder stability', () => {
  it('emits exactly <secret:KIND:HASH8>', () => {
    const { value } = fresh().redactString('key sk-abcdefghijklmnop0123 end');
    const found = value.match(/<secret:[^>]*>/g) ?? [];
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(PLACEHOLDER);
  });

  it('gives the same secret the same placeholder, so replay still matches structurally', () => {
    const r = fresh();
    const a = r.redactString('Authorization: Bearer sk-abcdefghijklmnop0123');
    const b = r.redactString('again: sk-abcdefghijklmnop0123');
    expect(a.hits[0]?.placeholder).toBe(b.hits[0]?.placeholder);
  });

  it('gives different secrets different placeholders', () => {
    const r = fresh();
    const a = r.redactString('sk-abcdefghijklmnop0123');
    const b = r.redactString('sk-zyxwvutsrqponm9876');
    expect(a.hits[0]?.placeholder).not.toBe(b.hits[0]?.placeholder);
  });

  it('salts per run, so the same secret does not correlate across runs', () => {
    const one = new Redactor({ salt: 'run-one' }).redactString('sk-abcdefghijklmnop0123');
    const two = new Redactor({ salt: 'run-two' }).redactString('sk-abcdefghijklmnop0123');
    expect(one.value).not.toBe(two.value);
  });

  it('leaves nothing of the secret behind', () => {
    const secret = 'sk-abcdefghijklmnop0123456789';
    const { value } = fresh().redactString(`body ${secret} tail`);
    expect(value).not.toContain(secret);
    expect(value).not.toContain('abcdefghij');
    expect(value).toBe(`body ${value.match(/<secret:[^>]*>/)?.[0]} tail`);
  });

  it('counts repeats of one secret as a single record', () => {
    const r = fresh();
    const { hits } = r.redactString('sk-abcdefghijklmnop0123 and sk-abcdefghijklmnop0123');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.count).toBe(2);
  });

  it('never records the value itself', () => {
    const r = fresh();
    r.redactString('sk-abcdefghijklmnop0123');
    const json = JSON.stringify(r.records());
    expect(json).not.toContain('abcdefghijklmnop');
  });

  it('is idempotent — a placeholder is not itself redactable', () => {
    const r = fresh();
    const once = r.redactString('sk-abcdefghijklmnop0123').value;
    const twice = r.redactString(once);
    expect(twice.value).toBe(once);
    expect(twice.hits).toHaveLength(0);
  });
});

describe('pattern rules', () => {
  const cases: [string, string, string][] = [
    ['sk_api_key', 'sk-abcdefghijklmnop0123456789', 'openai'],
    // The same rule covers every vendor that copied the prefix, which is why it is not named for
    // one of them: OrcaRouter is now the gateway `orca setup` suggests, so its keys are the ones
    // most likely to be sitting next to a trace.
    ['sk_api_key', 'sk-orca-abcdefghijklmnop0123456789', 'orcarouter'],
    ['sk_api_key', 'sk-ant-api03-abcdefghijklmnop0123456789', 'anthropic'],
    ['github_token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github classic'],
    ['github_token', 'gho_abcdefghijklmnopqrstuvwxyz0123456789', 'github oauth'],
    ['github_token', 'ghs_abcdefghijklmnopqrstuvwxyz0123456789', 'github server'],
    ['github_token', 'ghu_abcdefghijklmnopqrstuvwxyz0123456789', 'github user'],
    ['github_token', 'ghr_abcdefghijklmnopqrstuvwxyz0123456789', 'github refresh'],
    ['aws_access_key_id', 'AKIAIOSFODNN7EXAMPLE', 'aws'],
    ['slack_token', 'xoxb-123456789012-abcdefghijkl', 'slack bot'],
    ['slack_token', 'xoxp-123456789012-abcdefghijkl', 'slack user'],
    ['google_api_key', `AIza${'B'.repeat(35)}`, 'google'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g',
      'jwt',
    ],
  ];

  for (const [rule, secret, label] of cases) {
    it(`catches a ${label} token`, () => {
      const r = fresh();
      const { value, hits } = r.redactString(`prefix ${secret} suffix`);
      expect(value).not.toContain(secret);
      expect(hits.map((h) => h.rule)).toContain(rule);
    });
  }

  it('catches a PEM private key block whole', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAx7Rn3kQ2iVPYbLPqf1oW',
      'nZ1Z9Yy2K0m5Q7uC3sV8dT4hJgR6pL0aN2bX',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const { value, hits } = fresh().redactString(`key:\n${pem}\ndone`);
    expect(value).not.toContain('MIIEowIBAAK');
    expect(value).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(hits.map((h) => h.rule)).toContain('private_key');
    expect(value.startsWith('key:\n')).toBe(true);
    expect(value.endsWith('\ndone')).toBe(true);
  });

  it('catches a truncated PEM block that never ends', () => {
    const { value } = fresh().redactString('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg');
    expect(value).not.toContain('MIIEvQIBADANBg');
  });

  it('catches a key buried in a JSON request body and leaves the JSON parseable', () => {
    const body = JSON.stringify({
      model: 'claude-opus-5',
      headers: { authorization: 'Bearer sk-proj-Tn0pQrStUvWxYz0123456789AbCdEf' },
      messages: [{ role: 'user', content: 'here is my key: sk-proj-Tn0pQrStUvWxYz0123456789' }],
    });
    const { value, hits } = fresh().redactString(body);
    expect(value).not.toContain('sk-proj-Tn0pQrStUvWxYz');
    expect(hits.length).toBeGreaterThan(0);
    const parsed = JSON.parse(value) as { model: string };
    expect(parsed.model).toBe('claude-opus-5');
  });

  /**
   * A refresh token is the one GitHub credential that survives a rotated access token, so the
   * pattern rule has to carry it rather than leaning on the entropy sweep: a low-entropy token
   * body clears neither the entropy floor nor the letters-and-digits test.
   */
  it('catches a github refresh token the entropy sweep would never see', () => {
    const secret = `ghr_${'1'.repeat(30)}`;
    const { value, hits } = fresh().redactString(`token ${secret} end`);
    expect(value).not.toContain(secret);
    expect(hits.map((h) => h.rule)).toContain('github_token');
  });

  it('catches a high-entropy token with no recognisable prefix', () => {
    const { value, hits } = fresh().redactString('token=Xq7Lm2Vb9Zt4Rw8Ny1Kc6Ph3Jd5Gs0F');
    expect(value).not.toContain('Xq7Lm2Vb9Zt4');
    expect(hits.map((h) => h.rule)).toContain('high_entropy');
  });
});

describe('false positives', () => {
  const clean = [
    'The quick brown fox jumps over the lazy dog while the agent keeps thinking.',
    'Please refactor the authentication middleware so that it validates tokens properly.',
    'I ran the test suite and three of the integration tests failed with a timeout.',
    'Antidisestablishmentarianism is a supercalifragilisticexpialidocious word.',
    'export function deriveCheckpoints(events: TraceEvent[]): Checkpoint[] {',
    'getUserAuthenticationTokenFromRequestHeaders(request, options)',
    'const setUnhandledRejectionHandlerForBackgroundTasks = () => undefined;',
    'aVeryLongCamelCaseVariableNameUsedInProductionCode = 1;',
    '/home/user/OrcaReplay/packages/core/src/redaction.ts',
    'node_modules/@orcareplay/schema/dist/index.js',
    'https://api.anthropic.com/v1/messages?beta=true',
    'sha256:9f2c14be7d1a0b3c5e6f8a9d2b4c6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d',
    '550e8400-e29b-41d4-a716-446655440000',
    '2026-08-29T10:00:00.000Z',
    'run_9f2c14be7d1a',
    'SCREAMING_SNAKE_CASE_CONSTANT_NAME_THAT_IS_LONG',
    'this-is-a-long-kebab-case-branch-name-for-a-pull-request',
    '',
  ];

  for (const s of clean) {
    it(`leaves alone: ${JSON.stringify(s.slice(0, 48))}`, () => {
      const { value, hits } = fresh().redactString(s);
      expect(hits).toEqual([]);
      expect(value).toBe(s);
    });
  }

  it('does not redact a sha256 digest — every event line carries one', () => {
    const r = fresh();
    const digest = 'a3f5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5';
    expect(r.redactString(digest).hits).toEqual([]);
  });
});

describe('redactHeaders', () => {
  it('replaces every auth header regardless of the value shape', () => {
    const r = fresh();
    const { value } = r.redactHeaders({
      authorization: 'Bearer plainlookingvalue',
      'x-api-key': 'abc123',
      cookie: 'session=1',
      'proxy-authorization': 'Basic dXNlcjpwYXNz',
      'set-cookie': 'session=1; HttpOnly',
    });
    for (const v of Object.values(value)) expect(v).toMatch(PLACEHOLDER);
  });

  it('knows the vendor header names, not only the standard ones', () => {
    // Pinned by name rather than only iterated, because a table-driven test over this list gets
    // *smaller* when a name is deleted from it — it never goes red. Azure OpenAI sends the key as
    // `api-key` and Google as `x-goog-api-key`; both were known to one of the three copies of this
    // set that used to exist, which is how the same credential ended up stripped on one code path
    // and written on another.
    for (const name of [
      'authorization',
      'x-api-key',
      'api-key',
      'x-goog-api-key',
      'cookie',
      'proxy-authorization',
    ]) {
      expect(AUTH_REQUEST_HEADERS, name).toContain(name);
    }
    expect(AUTH_RESPONSE_HEADERS).toContain('set-cookie');
    // Every request header is redacted whatever its value looks like — the list is the contract.
    const { value } = fresh().redactHeaders(
      Object.fromEntries(AUTH_REQUEST_HEADERS.map((h) => [h, 'plain-looking-value'])),
    );
    for (const v of Object.values(value)) expect(v).toMatch(PLACEHOLDER);
  });

  it('matches auth header names case-insensitively', () => {
    const { value } = fresh().redactHeaders({ Authorization: 'Bearer x', 'X-Api-Key': 'y' });
    expect(value['Authorization']).toMatch(PLACEHOLDER);
    expect(value['X-Api-Key']).toMatch(PLACEHOLDER);
  });

  it('keeps the header name and record, but never the value', () => {
    const r = fresh();
    const { value, hits } = r.redactHeaders({ authorization: 'Bearer hunter2hunter2' });
    expect(Object.keys(value)).toEqual(['authorization']);
    expect(value['authorization']).not.toContain('hunter2');
    expect(hits).toHaveLength(1);
    expect(JSON.stringify(hits)).not.toContain('hunter2');
  });

  it('gives one auth value the same placeholder on every request', () => {
    const r = fresh();
    const a = r.redactHeaders({ authorization: 'Bearer sk-abcdefghijklmnop0123' });
    const b = r.redactHeaders({ authorization: 'Bearer sk-abcdefghijklmnop0123' });
    expect(a.value['authorization']).toBe(b.value['authorization']);
  });

  it('still pattern-scans ordinary headers', () => {
    const r = fresh();
    const { value, hits } = r.redactHeaders({
      'user-agent': 'claude-cli/1.2.3',
      'x-custom': 'token sk-abcdefghijklmnop0123',
    });
    expect(value['user-agent']).toBe('claude-cli/1.2.3');
    expect(value['x-custom']).not.toContain('sk-abcdef');
    expect(hits).toHaveLength(1);
  });
});

describe('redactEnv', () => {
  it('denies by default — only allowlisted keys survive', () => {
    const out = fresh().redactEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      ANTHROPIC_API_KEY: 'sk-abcdefghijklmnop0123',
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      SOME_INTERNAL_URL: 'https://internal.example.com',
    });
    expect(Object.keys(out).sort()).toEqual(['HOME', 'PATH']);
    expect(JSON.stringify(out)).not.toContain('sk-abcdef');
  });

  it('ships a conservative default allowlist', () => {
    expect(DEFAULT_ENV_ALLOWLIST).toContain('TERM');
    expect(DEFAULT_ENV_ALLOWLIST).toContain('PATH');
    expect(DEFAULT_ENV_ALLOWLIST).not.toContain('ANTHROPIC_API_KEY');
  });

  it('lets a caller replace the allowlist entirely', () => {
    const r = new Redactor({ salt: 's', envAllowlist: ['CI'] });
    expect(r.redactEnv({ CI: 'true', PATH: '/usr/bin' })).toEqual({ CI: 'true' });
  });

  it('drops undefined values, as process.env produces', () => {
    expect(fresh().redactEnv({ PATH: undefined, HOME: '/h' })).toEqual({ HOME: '/h' });
  });

  it('redacts inside allowlisted values too', () => {
    const out = fresh().redactEnv({ PATH: '/usr/bin:/opt/sk-abcdefghijklmnop0123/bin' });
    expect(out['PATH']).not.toContain('sk-abcdef');
    expect(out['PATH']?.startsWith('/usr/bin:/opt/')).toBe(true);
  });
});

describe('records and rulesFired', () => {
  it('aggregates across calls by rule and identifier', () => {
    const r = fresh();
    r.redactString('sk-abcdefghijklmnop0123');
    r.redactString('sk-abcdefghijklmnop0123');
    r.redactString('AKIAIOSFODNN7EXAMPLE');
    const records = r.records();
    expect(records).toHaveLength(2);
    const openai = records.find((x) => x.rule === 'sk_api_key');
    expect(openai?.count).toBe(2);
    expect(openai?.identifier).toBeTruthy();
    expect(openai?.placeholder).toMatch(PLACEHOLDER);
  });

  it('counts occurrences per rule for the manifest', () => {
    const r = fresh();
    r.redactString('sk-abcdefghijklmnop0123 sk-zyxwvutsrqponm9876');
    r.redactHeaders({ authorization: 'Bearer x' });
    expect(r.rulesFired()['sk_api_key']).toBe(2);
    expect(Object.values(r.rulesFired()).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('starts empty and stays empty when nothing matches', () => {
    const r = fresh();
    r.redactString('nothing to see here');
    expect(r.records()).toEqual([]);
    expect(r.rulesFired()).toEqual({});
  });

  it('declares a policy version for redactions.json', () => {
    expect(REDACTION_POLICY_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('tags records with the caller-supplied context', () => {
    const r = fresh();
    const { hits } = r.redactString('sk-abcdefghijklmnop0123', 'event:7:payload');
    expect(hits[0]?.identifier).toContain('event:7:payload');
  });
});
