'use strict';

const { normalizeEvidenceAttestation } = require('../agent-evidence');

const KIND_TYPES = {
  test: 'tests-verified', artifact_render: 'artifact-verified', browser_ui: 'visual-verification',
  url_tls: 'public-verification', deployment: 'deployment-verified', source: 'research-fetch',
  git: 'repository-implemented', command: 'remote-inspection',
};

function verifiedAttestations(result = {}) {
  const candidates = [result.evidenceAttestations, result.data?.evidenceAttestations,
    result.invocation?.evidence, result.evidence].flatMap((items) => Array.isArray(items) ? items : []);
  return candidates.map(normalizeEvidenceAttestation).filter((entry) => entry?.verdict === 'pass');
}

function attestedCompletionEvidence(result = {}, extra = {}) {
  return verifiedAttestations(result).filter((entry) => KIND_TYPES[entry.kind]).map((entry) => ({
    ...extra, id: entry.id, type: KIND_TYPES[entry.kind], summary: `${entry.kind}: ${entry.subject}`,
    target: entry.subject, expectedState: entry.details?.expectedState || null,
    verificationMethod: entry.kind, verified: true, createdAt: entry.observedAt,
    attestation: entry,
  }));
}

function matchesCompletionEvidence(evidence = {}, criterion = {}) {
  if (evidence.verified !== true) return false;
  if (criterion.target && criterion.target !== evidence.target) return false;
  if (criterion.expectedState && criterion.expectedState !== evidence.expectedState) return false;
  if (criterion.verificationMethod && criterion.verificationMethod !== evidence.verificationMethod) return false;
  if (Array.isArray(criterion.evidenceTypes) && criterion.evidenceTypes.length) {
    return criterion.evidenceTypes.includes(evidence.type);
  }
  const text = String(criterion.text || '').toLowerCase();
  let types = [];
  // Validation is deliberately distinct from creation and deployment initiation.
  if (/\b(test|tests)\b/.test(text)) types = ['tests-verified'];
  else if (/\b(visual|browser|responsive)\b/.test(text)) types = ['visual-verification'];
  else if (/\b(verify|verified|verification|validate|review the result)\b/.test(text)) {
    types = /\b(document|artifact|pdf|slides?)\b/.test(text)
      ? ['artifact-verified'] : ['deployment-verified', 'public-verification', 'artifact-verified', 'visual-verification', 'tests-verified'];
  } else if (/\b(inspect|inspection|current state)\b/.test(text)) types = ['remote-inspection', 'k8s-inspection', 'research-fetch'];
  else if (/\b(deploy|deployment)\b/.test(text)) types = ['deployment-applied', 'deployment-verified'];
  else if (/\b(implement|implementation)\b/.test(text)) types = ['repository-implemented', 'code-change'];
  else if (/\b(build|built)\b/.test(text)) types = ['build-complete'];
  else if (/\b(research)\b/.test(text)) types = ['research-fetch'];
  else if (/\b(produce|deliverable|deliver|document|artifact)\b/.test(text)) types = ['document-generated', 'artifact-created'];
  return types.includes(evidence.type);
}

module.exports = { attestedCompletionEvidence, matchesCompletionEvidence, verifiedAttestations };
