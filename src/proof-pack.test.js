'use strict';

const { createEvidenceAttestation } = require('./agent-evidence');
const { attestBrowserCheck, attestTestResult, attestUrlTlsCheck } = require('./evidence-producers');
const { buildProofPack } = require('./proof-pack');

describe('ProofPack/v1', () => {
  test('assembles verifiable receipts without raw command output', () => {
    const pack = buildProofPack({
      run: {
        id: 'run-1',
        objective: 'Verify the implementation',
        state: 'completed',
        evidence: [attestTestResult({
          subject: 'Focused tests',
          command: 'npm test',
          exitCode: 0,
          passed: 12,
          failed: 0,
          outputDigest: 'abc123',
        })],
        outputs: [{ id: 'artifact-1', title: 'Report', previewUrl: '/artifacts/1' }],
        usage: { costUsd: 0.12, durationMs: 4000 },
        completion: { summary: 'Done' },
      },
      quality: { status: 'passed', requiredMissing: [] },
    });

    expect(pack.version).toBe('ProofPack/v1');
    expect(pack.status).toBe('verified');
    expect(pack.checks[0]).toMatchObject({ kind: 'test', status: 'pass' });
    expect(JSON.stringify(pack)).not.toContain('raw output');
    expect(pack.evidence.digests[0]).toMatch(/^[a-f0-9]{64}$/);
  });

  test('cannot verify a website without screenshot-backed browser proof', () => {
    const weakBrowserProof = attestBrowserCheck({ url: 'https://example.test', exitCode: 0 });
    const urlProof = attestUrlTlsCheck({
      url: 'https://example.test',
      statusCode: 200,
      tlsValid: true,
      contentMatched: true,
    });
    const pack = buildProofPack({
      run: {
        id: 'run-2',
        objective: 'Build a public website',
        state: 'completed',
        evidence: [weakBrowserProof, urlProof],
      },
    });

    expect(pack.status).toBe('partial');
    expect(pack.missingGates).toContain('Browser, Playwright, screenshot, or kimibuilt-ui-check evidence exists');
  });

  test('discards forged or tampered evidence from the pack', () => {
    const receipt = createEvidenceAttestation({
      kind: 'test',
      subject: 'Tests',
      verdict: 'pass',
      details: { exitCode: 0 },
    });
    const pack = buildProofPack({
      run: {
        id: 'run-3',
        objective: 'Run tests',
        state: 'completed',
        evidence: [{ ...receipt, verdict: 'fail' }],
      },
    });

    expect(pack.status).toBe('unavailable');
    expect(pack.checks).toEqual([]);
  });

  test('does not verify a website from a bare browser attestation with no URL', () => {
    const bareBrowserProof = createEvidenceAttestation({
      kind: 'browser_ui',
      subject: 'Browser checked',
      verdict: 'pass',
      details: { screenshots: ['desktop.png'] },
    });
    const pack = buildProofPack({
      run: {
        id: 'run-4',
        objective: 'Build and launch a public website',
        state: 'completed',
        evidence: [bareBrowserProof],
      },
    });

    expect(pack.status).toBe('partial');
    expect(pack.liveUrl).toBeNull();
    expect(pack.agentQuality.status).not.toBe('passed');
    expect(pack.missingGates).toContain('Public or preview URL is available');
  });
});
