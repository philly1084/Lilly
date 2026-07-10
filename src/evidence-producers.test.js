'use strict';

const {
  attestApprovalReceipt,
  attestArtifactRender,
  attestBrowserCheck,
  attestDeploymentResult,
  attestTestResult,
  attestUrlTlsCheck,
  collectValidAttestations,
} = require('./evidence-producers');

describe('structured evidence producers', () => {
  test('derives test verdicts from real exit data rather than prose', () => {
    const passed = attestTestResult({ command: 'npm test', exitCode: 0, passed: 12, failed: 0 });
    const forged = attestTestResult({ command: 'tests passed', failed: 0 });

    expect(passed.verdict).toBe('pass');
    expect(forged.verdict).toBe('unknown');
    expect(passed.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('browser proof requires a checked URL, exit code, and screenshot receipt', () => {
    expect(attestBrowserCheck({ url: 'https://example.test', exitCode: 0 }).verdict).toBe('unknown');
    expect(attestBrowserCheck({
      url: 'https://example.test',
      exitCode: 0,
      screenshots: ['desktop.png'],
      viewports: ['desktop'],
    }).verdict).toBe('pass');
  });

  test('URL/TLS proof requires content verification as well as a healthy response', () => {
    expect(attestUrlTlsCheck({
      url: 'https://example.test',
      statusCode: 200,
      tlsValid: true,
      contentMatched: false,
    }).verdict).toBe('fail');
  });

  test('render, deployment, and approval producers retain structured receipts', () => {
    const evidence = [
      attestArtifactRender({ artifactId: 'artifact-1', rendered: true, inspected: true }),
      attestDeploymentResult({ deployment: 'web', rolloutStatus: 'complete' }),
      attestApprovalReceipt({ receiptId: 'approval-1', scope: 'deploy:web', status: 'approved' }),
    ];

    expect(collectValidAttestations(evidence)).toHaveLength(3);
    expect(evidence.map((entry) => entry.verdict)).toEqual(['pass', 'pass', 'pass']);
  });

  test('drops tampered attestation records', () => {
    const receipt = attestTestResult({ command: 'npm test', exitCode: 0, failed: 0 });
    expect(collectValidAttestations([{ ...receipt, verdict: 'fail' }])).toEqual([]);
  });
});
