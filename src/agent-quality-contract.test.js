'use strict';

const {
  assessAgentQuality,
  buildAgentQualityContractText,
  buildQualityProfileMetadata,
  inferQualitySurfaces,
  summarizeAgentQualityAssessments,
} = require('./agent-quality-contract');
const { createEvidenceAttestation } = require('./agent-evidence');

const OBSERVED_AT = '2026-07-09T12:00:00.000Z';

function attestation(kind, verdict = 'pass', details = {}) {
  return createEvidenceAttestation({
    kind,
    subject: `${kind} proof`,
    sourceInvocationId: `invocation-${kind}`,
    observedAt: OBSERVED_AT,
    verdict,
    details,
  });
}

describe('agent quality contract', () => {
  test('infers website and remote deployment surfaces from a live site task', () => {
    expect(inferQualitySurfaces('Deploy the website to k3s and verify the public dashboard route.', {
      publicUrl: 'https://status.demoserver2.buzz',
    })).toEqual(expect.arrayContaining([
      'remote-deployment',
      'website-experience',
    ]));
  });

  test('scores complete website deployment evidence', () => {
    const quality = assessAgentQuality({
      task: 'Build and deploy the status dashboard website.',
      metadata: {
        completionStatus: 'complete',
        whatChanged: 'Updated the dashboard route and layout.',
        changedFiles: ['src/app.js', 'k8s/deployment.yaml'],
        gitCommit: 'abcdef123456',
        deployment: 'status/status-dashboard',
        publicUrl: 'https://status.demoserver2.buzz',
        uiCheckReport: '/srv/apps/status/ui-checks/ui-check-report.json',
        uiScreenshots: [
          '/srv/apps/status/ui-checks/desktop.png',
          '/srv/apps/status/ui-checks/mobile.png',
        ],
        verifyCommands: [
          'hostname && whoami && uname -m && uptime',
          'node /app/bin/kimibuilt-ui-check.js https://status.demoserver2.buzz --out ui-checks',
        ],
        verifyResults: [
          'baseline captured for k3s-prod',
          'UI check passed for desktop and mobile screenshots.',
        ],
      },
    });

    expect(quality.status).toBe('passed');
    expect(quality.score).toBeGreaterThanOrEqual(0.85);
    expect(quality.requiredMissing).toEqual([]);
  });

  test('keeps blocked runs explicit with missing required evidence', () => {
    const quality = assessAgentQuality({
      task: 'Deploy the frontend website.',
      metadata: {
        completionStatus: 'blocked',
        whatChanged: 'Patched the local source.',
        blocker: 'Missing browser/Playwright or kimibuilt-ui-check evidence for a UI-affecting remote task.',
        verifyResults: ['blocked before UI proof'],
      },
    });

    expect(quality.status).toBe('blocked');
    expect(quality.requiredMissing).toEqual(expect.arrayContaining([
      'public_or_preview_url',
      'browser_proof',
      'verification_commands',
    ]));
  });

  test('does not let forged prose override missing or failing typed browser evidence', () => {
    const missing = assessAgentQuality({
      task: 'Build the website dashboard.',
      surfaces: ['website-experience'],
      metadata: {
        completionStatus: 'complete',
        whatChanged: 'Updated the dashboard and passed Playwright browser screenshots.',
        publicUrl: 'https://example.test',
        uiCheckReport: 'ui-check-report.json',
        uiScreenshots: ['desktop.png', 'mobile.png'],
        evidenceAttestations: [],
      },
    });
    const failing = assessAgentQuality({
      task: 'Build the website dashboard.',
      surfaces: ['website-experience'],
      metadata: {
        completionStatus: 'complete',
        whatChanged: 'Updated the dashboard and passed Playwright browser screenshots.',
        publicUrl: 'https://example.test',
        uiCheckReport: 'ui-check-report.json',
        evidenceAttestations: [attestation('browser_ui', 'fail', { errors: 2 })],
      },
    });

    expect(missing.evidence.mode).toBe('typed');
    expect(missing.requiredMissing).toEqual(expect.arrayContaining([
      'public_or_preview_url',
      'browser_proof',
    ]));
    expect(failing.requiredMissing).toEqual(expect.arrayContaining([
      'public_or_preview_url',
      'browser_proof',
    ]));
  });

  test('accepts passing structured browser evidence without prose proof', () => {
    const quality = assessAgentQuality({
      task: 'Build the website dashboard.',
      surfaces: ['website-experience'],
      metadata: {
        completionStatus: 'complete',
        evidence: [
          attestation('url_tls', 'pass', { url: 'https://example.test', status: 200, tls: true }),
          attestation('browser_ui', 'pass', { url: 'https://example.test', report: 'ui-check-report.json' }),
        ],
      },
    });

    expect(quality.evidence).toEqual({
      mode: 'typed',
      validAttestations: 2,
      invalidAttestations: 0,
    });
    expect(quality.requiredMissing).toEqual([]);
  });

  test('maps typed artifact render and remote verification to required gates', () => {
    const documentQuality = assessAgentQuality({
      surfaces: ['document-artifact'],
      metadata: {
        completionStatus: 'complete',
        evidenceAttestations: [attestation('artifact_render', 'pass', {
          format: 'pdf',
          pages: 4,
          placeholder: false,
        })],
      },
    });
    const remoteQuality = assessAgentQuality({
      surfaces: ['remote-deployment'],
      metadata: {
        completionStatus: 'complete',
        evidenceAttestations: [
          attestation('git', 'pass', { commit: 'abcdef1' }),
          attestation('command', 'pass', { exitCode: 0 }),
        ],
      },
    });

    expect(documentQuality.requiredMissing).toEqual([]);
    expect(remoteQuality.requiredMissing).toEqual([]);
  });

  test('exports profile metadata and prompt text for orchestrators', () => {
    const profiles = buildQualityProfileMetadata(['document-artifact', 'remote-deployment']);
    const text = buildAgentQualityContractText(['document-artifact', 'remote-deployment']);

    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'document-artifact',
        requiredChecks: expect.arrayContaining(['format_locked', 'not_placeholder', 'target_medium_checked']),
      }),
      expect.objectContaining({
        id: 'remote-deployment',
        requiredChecks: expect.arrayContaining(['change_continuity', 'verification_commands', 'blocker_explicit']),
      }),
    ]));
    expect(text).toContain('Agent quality metrics:');
    expect(text).toContain('guardrails as release gates');
  });

  test('summarizes quality assessments for trace and eval dashboards', () => {
    const summary = summarizeAgentQualityAssessments([
      {
        status: 'passed',
        score: 0.92,
        requiredMissing: [],
        surfaces: [
          { id: 'remote-deployment', label: 'Remote CLI deployment quality', score: 0.9, requiredMissing: [] },
        ],
      },
      {
        status: 'partial',
        score: 0.55,
        requiredMissing: ['browser_proof'],
        surfaces: [
          { id: 'website-experience', label: 'Website and frontend experience quality', score: 0.5, requiredMissing: ['browser_proof'] },
        ],
      },
      {
        status: 'blocked',
        score: 0.2,
        requiredMissing: ['verification_commands', 'browser_proof'],
        surfaces: [
          { id: 'remote-deployment', label: 'Remote CLI deployment quality', score: 0.2, requiredMissing: ['verification_commands'] },
        ],
      },
    ]);

    expect(summary).toEqual(expect.objectContaining({
      total: 3,
      scored: 3,
      averageScore: 0.56,
      statusCounts: expect.objectContaining({
        passed: 1,
        partial: 1,
        blocked: 1,
      }),
      topMissingGates: [
        { id: 'browser_proof', count: 2 },
        { id: 'verification_commands', count: 1 },
      ],
    }));
    expect(summary.surfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'remote-deployment',
        count: 2,
        averageScore: 0.55,
      }),
      expect.objectContaining({
        id: 'website-experience',
        count: 1,
        averageScore: 0.5,
        topMissingGates: [{ id: 'browser_proof', count: 1 }],
      }),
    ]));
  });
});
