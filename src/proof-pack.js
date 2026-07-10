'use strict';

const { assessAgentQuality } = require('./agent-quality-contract');
const { normalizeEvidenceAttestation, redactSecrets } = require('./agent-evidence');

const PROOF_PACK_VERSION = 'ProofPack/v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeAttestations(values = []) {
  return asArray(values).map(normalizeEvidenceAttestation).filter(Boolean);
}

function buildCheck(attestation = {}) {
  return {
    id: attestation.id,
    kind: attestation.kind,
    label: attestation.subject,
    status: attestation.verdict,
    digest: attestation.digest,
    observedAt: attestation.observedAt,
    sourceInvocationId: attestation.sourceInvocationId,
  };
}

function normalizeArtifact(output = {}) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return null;
  }
  const id = normalizeText(output.id || output.artifactId);
  const url = normalizeText(output.previewUrl || output.downloadUrl || output.url);
  const path = normalizeText(output.path || output.filename);
  if (!id && !url && !path) {
    return null;
  }
  return redactSecrets({
    id: id || null,
    title: normalizeText(output.title || output.name || output.filename) || 'Artifact',
    format: normalizeText(output.format || output.type) || null,
    url: url || null,
    path: path || null,
    missionId: normalizeText(output.missionId) || null,
    parentArtifactId: normalizeText(output.parentArtifactId) || null,
    revision: output.revision ?? null,
  });
}

function buildProofPack({ run = {}, attestations = null, quality = null } = {}) {
  const evidence = normalizeAttestations(attestations === null ? run.evidence : attestations);
  const outputs = asArray(run.outputs);
  const artifacts = outputs.map(normalizeArtifact).filter(Boolean);
  const approvalAttestations = evidence.filter((entry) => entry.kind === 'approval');
  const recordedApprovals = asArray(run.approvals).map((approval) => redactSecrets({
    id: normalizeText(approval?.id || approval?.receiptId) || null,
    scope: normalizeText(approval?.scope || approval?.action) || null,
    status: normalizeText(approval?.status) || 'unknown',
    reason: normalizeText(approval?.reason) || null,
    resolvedAt: normalizeText(approval?.resolvedAt) || null,
  }));

  const changedFiles = unique(evidence
    .filter((entry) => entry.kind === 'git')
    .flatMap((entry) => asArray(entry.details?.changedFiles).map(normalizeText)));
  const screenshots = unique(evidence
    .filter((entry) => entry.kind === 'browser_ui')
    .flatMap((entry) => asArray(entry.details?.screenshots).map(normalizeText)));
  const urls = unique([
    ...evidence.filter((entry) => entry.kind === 'url_tls' && entry.verdict === 'pass')
      .map((entry) => normalizeText(entry.details?.url)),
    ...evidence.filter((entry) => entry.kind === 'deployment' && entry.verdict === 'pass')
      .map((entry) => normalizeText(entry.details?.liveUrl)),
    ...artifacts.map((artifact) => artifact.url),
  ]);
  const blockers = evidence
    .filter((entry) => ['blocked', 'fail'].includes(entry.verdict))
    .map((entry) => ({
      kind: entry.kind,
      label: entry.subject,
      status: entry.verdict,
      digest: entry.digest,
    }));
  if (run.completion?.reason && ['blocked', 'failed'].includes(normalizeText(run.state || run.completion?.status))) {
    blockers.push({
      kind: 'run',
      label: normalizeText(run.completion.reason),
      status: normalizeText(run.state || run.completion.status),
      digest: null,
    });
  }

  const derivedQuality = quality || assessAgentQuality({
    task: normalizeText(run.objective),
    metadata: {
      completionStatus: normalizeText(run.state || run.completion?.status),
      evidenceAttestations: evidence,
      changedFiles,
      publicUrl: urls[0] || null,
      uiScreenshots: screenshots,
      outputs,
    },
  });
  const missingGateLabels = new Map(asArray(derivedQuality?.surfaces).flatMap((surface) => (
    asArray(surface?.checks).map((check) => [normalizeText(check?.id), normalizeText(check?.label || check?.id)])
  )));
  const requiredMissing = unique(asArray(derivedQuality?.requiredMissing).map((entry) => {
    const id = typeof entry === 'string' ? normalizeText(entry) : normalizeText(entry?.id);
    return normalizeText(entry?.label) || missingGateLabels.get(id) || id;
  }));
  const passedEvidence = evidence.filter((entry) => entry.verdict === 'pass').length;
  const completed = normalizeText(run.state || run.completion?.status) === 'completed';
  const verified = completed
    && evidence.length > 0
    && passedEvidence === evidence.length
    && requiredMissing.length === 0
    && derivedQuality?.status === 'passed'
    && blockers.length === 0;

  return redactSecrets({
    version: PROOF_PACK_VERSION,
    runId: normalizeText(run.id) || null,
    missionId: normalizeText(run.missionId || run.id) || null,
    status: evidence.length === 0 ? 'unavailable' : (verified ? 'verified' : 'partial'),
    summary: normalizeText(run.completion?.summary || run.completion?.reason) || null,
    artifacts,
    changedFiles,
    checks: evidence.filter((entry) => entry.kind !== 'approval').map(buildCheck),
    screenshots,
    urls,
    liveUrl: urls[0] || null,
    approvals: [
      ...recordedApprovals,
      ...approvalAttestations.map((entry) => ({
        id: normalizeText(entry.details?.receiptId || entry.id) || null,
        scope: normalizeText(entry.details?.scope || entry.subject) || null,
        status: entry.verdict === 'pass' ? 'approved' : entry.verdict,
        digest: entry.digest,
        observedAt: entry.observedAt,
      })),
    ],
    blockers,
    missingGates: requiredMissing,
    usage: redactSecrets(run.usage || {}),
    durationMs: Number.isFinite(Number(run.completion?.durationMs ?? run.usage?.durationMs))
      ? Number(run.completion?.durationMs ?? run.usage?.durationMs)
      : null,
    costUsd: Number.isFinite(Number(run.usage?.costUsd)) ? Number(run.usage.costUsd) : null,
    evidence: {
      version: 'EvidenceBundle/v1',
      total: evidence.length,
      passed: passedEvidence,
      digests: evidence.map((entry) => entry.digest),
    },
    agentQuality: derivedQuality,
  });
}

module.exports = {
  PROOF_PACK_VERSION,
  buildProofPack,
};
