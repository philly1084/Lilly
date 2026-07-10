'use strict';

const {
  EVIDENCE_ATTESTATION_VERSION,
  createEvidenceAttestation,
  extractEvidenceAttestations,
  normalizeEvidenceAttestation,
} = require('./agent-evidence');

const OBSERVED_AT = '2026-07-09T12:00:00.000Z';

describe('EvidenceAttestation/v1', () => {
  test('builds a stable SHA-256 attestation independent of object key order', () => {
    const first = createEvidenceAttestation({
      kind: 'test',
      subject: 'npm test -- focused',
      sourceInvocationId: 'invocation-1',
      observedAt: OBSERVED_AT,
      verdict: 'pass',
      details: {
        exitCode: 0,
        counts: { passed: 4, failed: 0 },
      },
    });
    const second = createEvidenceAttestation({
      verdict: 'pass',
      observedAt: OBSERVED_AT,
      sourceInvocationId: 'invocation-1',
      subject: 'npm test -- focused',
      kind: 'test',
      details: {
        counts: { failed: 0, passed: 4 },
        exitCode: 0,
      },
    });

    expect(first.version).toBe(EVIDENCE_ATTESTATION_VERSION);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.digest).toBe(first.digest);
    expect(second.id).toBe(first.id);
    expect(normalizeEvidenceAttestation(first)).toEqual(first);
  });

  test('redacts secrets recursively before storing details or computing the digest', () => {
    const attestation = createEvidenceAttestation({
      kind: 'command',
      subject: 'remote health check',
      observedAt: OBSERVED_AT,
      verdict: 'pass',
      details: {
        environment: {
          API_KEY: 'sk-super-secret-value',
          nested: [{ authorization: 'Bearer hidden-token-value' }],
        },
        stdout: 'PASSWORD=inline-password Connected with Bearer abcdefghijklmnop successfully.',
      },
    });

    expect(attestation.details.environment.API_KEY).toBe('[REDACTED]');
    expect(attestation.details.environment.nested[0].authorization).toBe('[REDACTED]');
    expect(attestation.details.stdout).toContain('Bearer [REDACTED]');
    expect(JSON.stringify(attestation)).not.toContain('super-secret-value');
    expect(JSON.stringify(attestation)).not.toContain('hidden-token-value');
    expect(JSON.stringify(attestation)).not.toContain('inline-password');
  });

  test('rejects prose-only details and detects tampering', () => {
    expect(() => createEvidenceAttestation({
      kind: 'browser_ui',
      subject: 'dashboard',
      observedAt: OBSERVED_AT,
      verdict: 'pass',
      details: 'Playwright passed, trust me.',
    })).toThrow('structured object or array');

    const attestation = createEvidenceAttestation({
      kind: 'browser_ui',
      subject: 'https://example.test',
      observedAt: OBSERVED_AT,
      verdict: 'pass',
      details: { report: 'ui-check.json' },
    });
    expect(normalizeEvidenceAttestation({
      ...attestation,
      verdict: 'fail',
    })).toBeNull();
  });

  test('marks an explicitly empty typed evidence channel as present', () => {
    expect(extractEvidenceAttestations({ evidenceAttestations: [] })).toEqual({
      present: true,
      attestations: [],
      invalidCount: 0,
    });
  });
});
