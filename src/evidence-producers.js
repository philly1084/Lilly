'use strict';

const {
  createEvidenceAttestation,
  normalizeEvidenceAttestation,
  redactSecrets,
} = require('./agent-evidence');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeExitCode(value) {
  if (value === null || value === undefined || value === '') return null;
  const exitCode = Number(value);
  return Number.isInteger(exitCode) ? exitCode : null;
}

function normalizeSourceInvocationId(input = {}) {
  return normalizeText(input.sourceInvocationId || input.invocationId) || null;
}

function createReceipt(kind, subject, verdict, input = {}, details = {}) {
  return createEvidenceAttestation({
    kind,
    subject,
    verdict,
    sourceInvocationId: normalizeSourceInvocationId(input),
    observedAt: input.observedAt,
    details: redactSecrets(details),
  });
}

function attestTestResult(input = {}) {
  const exitCode = normalizeExitCode(input.exitCode);
  const failed = Number(input.failed ?? input.failedTests ?? 0);
  const hasResult = exitCode !== null && Number.isFinite(failed);
  const verdict = !hasResult ? 'unknown' : (exitCode === 0 && failed === 0 ? 'pass' : 'fail');
  return createReceipt('test', normalizeText(input.subject || input.command) || 'Test run', verdict, input, {
    command: normalizeText(input.command) || null,
    exitCode,
    passed: Number.isFinite(Number(input.passed ?? input.passedTests))
      ? Number(input.passed ?? input.passedTests)
      : null,
    failed: Number.isFinite(failed) ? failed : null,
    suites: Number.isFinite(Number(input.suites)) ? Number(input.suites) : null,
    durationMs: Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : null,
  });
}

function attestCommandResult(input = {}) {
  const exitCode = normalizeExitCode(input.exitCode);
  const verdict = exitCode === null ? 'unknown' : (exitCode === 0 ? 'pass' : 'fail');
  return createReceipt('command', normalizeText(input.subject || input.command) || 'Command result', verdict, input, {
    command: normalizeText(input.command) || null,
    exitCode,
    durationMs: Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : null,
    outputDigest: normalizeText(input.outputDigest) || null,
  });
}

function attestGitResult(input = {}) {
  const changedFiles = asArray(input.changedFiles).map(normalizeText).filter(Boolean);
  const hasProof = Boolean(normalizeText(input.commit) || normalizeText(input.diffDigest) || changedFiles.length > 0);
  return createReceipt('git', normalizeText(input.subject) || 'Git change', hasProof ? 'pass' : 'unknown', input, {
    commit: normalizeText(input.commit) || null,
    branch: normalizeText(input.branch) || null,
    diffDigest: normalizeText(input.diffDigest) || null,
    changedFiles,
    pushed: input.pushed === true,
  });
}

function attestArtifactRender(input = {}) {
  const rendered = input.rendered === true;
  const inspected = input.inspected === true || Boolean(normalizeText(input.inspectionDigest));
  const verdict = rendered && inspected && input.complete !== false && input.placeholder !== true
    ? 'pass' : (input.failed === true || input.placeholder === true || input.complete === false ? 'fail' : 'unknown');
  return createReceipt('artifact_render', normalizeText(input.subject || input.artifactId) || 'Artifact render', verdict, input, {
    artifactId: normalizeText(input.artifactId) || null,
    format: normalizeText(input.format) || null,
    path: normalizeText(input.path) || null,
    previewUrl: normalizeText(input.previewUrl) || null,
    rendered,
    inspected,
    inspectionDigest: normalizeText(input.inspectionDigest) || null,
    complete: input.complete !== false,
    placeholder: input.placeholder === true,
  });
}

function attestBrowserCheck(input = {}) {
  const exitCode = normalizeExitCode(input.exitCode);
  const screenshots = asArray(input.screenshots).map(normalizeText).filter(Boolean);
  const blockers = asArray(input.blockers).map(normalizeText).filter(Boolean);
  const inspectedViewports = asArray(input.viewports).map(normalizeText).filter(Boolean);
  const hasRequiredReceipt = exitCode !== null && Boolean(normalizeText(input.url)) && screenshots.length > 0;
  const verdict = hasRequiredReceipt && exitCode === 0 && blockers.length === 0
    ? 'pass'
    : (exitCode !== null && (exitCode !== 0 || blockers.length > 0) ? 'fail' : 'unknown');
  return createReceipt('browser_ui', normalizeText(input.subject || input.url) || 'Browser UI check', verdict, input, {
    url: normalizeText(input.url) || null,
    exitCode,
    screenshots,
    reportPath: normalizeText(input.reportPath) || null,
    reportDigest: normalizeText(input.reportDigest) || null,
    blockers,
    viewports: inspectedViewports,
  });
}

function attestUrlTlsCheck(input = {}) {
  const statusCode = Number(input.statusCode);
  const hasStatus = Number.isInteger(statusCode);
  const https = /^https:\/\//i.test(normalizeText(input.url));
  const tlsValid = input.tlsValid === true || !https;
  const contentMatched = input.contentMatched === true;
  const verdict = hasStatus && statusCode >= 200 && statusCode < 400 && tlsValid && contentMatched
    ? 'pass'
    : (hasStatus || input.tlsValid === false || input.contentMatched === false ? 'fail' : 'unknown');
  return createReceipt('url_tls', normalizeText(input.subject || input.url) || 'URL and TLS check', verdict, input, {
    url: normalizeText(input.url) || null,
    statusCode: hasStatus ? statusCode : null,
    tlsValid: https ? input.tlsValid === true : null,
    contentMatched,
    responseDigest: normalizeText(input.responseDigest) || null,
  });
}

function attestDeploymentResult(input = {}) {
  const rolloutStatus = normalizeText(input.rolloutStatus).toLowerCase();
  const passed = ['available', 'complete', 'completed', 'ready', 'succeeded', 'success'].includes(rolloutStatus);
  const failed = ['failed', 'error', 'timed_out', 'timeout'].includes(rolloutStatus);
  return createReceipt('deployment', normalizeText(input.subject || input.deployment) || 'Deployment rollout', passed ? 'pass' : (failed ? 'fail' : 'unknown'), input, {
    deployment: normalizeText(input.deployment) || null,
    namespace: normalizeText(input.namespace) || null,
    revision: normalizeText(input.revision) || null,
    image: normalizeText(input.image) || null,
    rolloutStatus: rolloutStatus || null,
    liveUrl: normalizeText(input.liveUrl) || null,
  });
}

function attestApprovalReceipt(input = {}) {
  const status = normalizeText(input.status).toLowerCase();
  const approved = status === 'approved' && Boolean(normalizeText(input.receiptId));
  const blocked = ['pending', 'required', 'blocked'].includes(status);
  return createReceipt('approval', normalizeText(input.subject || input.scope) || 'Scoped approval', approved ? 'pass' : (blocked ? 'blocked' : 'fail'), input, {
    receiptId: normalizeText(input.receiptId) || null,
    scope: normalizeText(input.scope) || null,
    action: normalizeText(input.action) || null,
    risk: normalizeText(input.risk) || null,
    status: status || 'unknown',
    grantedBy: normalizeText(input.grantedBy) || null,
    expiresAt: normalizeText(input.expiresAt) || null,
  });
}

function collectValidAttestations(values = []) {
  return asArray(values).map(normalizeEvidenceAttestation).filter(Boolean);
}

module.exports = {
  attestApprovalReceipt,
  attestArtifactRender,
  attestBrowserCheck,
  attestCommandResult,
  attestDeploymentResult,
  attestGitResult,
  attestTestResult,
  attestUrlTlsCheck,
  collectValidAttestations,
};
