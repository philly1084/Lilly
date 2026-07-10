'use strict';

const ARTIFACT_LINEAGE_VERSION = 'ArtifactLineage/v1';

function normalizeText(value = '', limit = 240) {
  return String(value || '').trim().slice(0, limit);
}

function normalizeRevision(value, fallback = 1) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision > 0 ? revision : fallback;
}

function buildArtifactLineageMetadata({
  metadata = {},
  parentArtifact = null,
  parentArtifactId = '',
  missionId = '',
  revision = null,
  provenance = {},
  session = null,
  toolContext = {},
  sourceMode = '',
  sourceArtifactIds = [],
} = {}) {
  const parentMetadata = parentArtifact?.metadata && typeof parentArtifact.metadata === 'object'
    ? parentArtifact.metadata
    : {};
  const resolvedParentId = normalizeText(parentArtifactId || parentArtifact?.id);
  if (resolvedParentId && !parentArtifact) {
    throw new Error(`Artifact lineage parent ${resolvedParentId} could not be verified.`);
  }
  if (parentArtifact && parentArtifactId && normalizeText(parentArtifact.id) !== normalizeText(parentArtifactId)) {
    throw new Error('Artifact lineage parent id does not match the loaded parent artifact.');
  }
  const parentSessionId = normalizeText(parentMetadata.provenance?.sessionId);
  const currentSessionId = normalizeText(session?.id);
  if (parentSessionId && currentSessionId && parentSessionId !== currentSessionId) {
    throw new Error('Artifact lineage cannot cross session ownership boundaries.');
  }
  const resolvedMissionId = normalizeText(
    parentMetadata.missionId
      || toolContext.missionId
      || session?.metadata?.missionId
      || session?.metadata?.activeMissionId
      || missionId
      || metadata.missionId
      || toolContext.runId
      || toolContext.agentRunId
      || session?.metadata?.activeAgentRunId,
  );
  const parentRevision = normalizeRevision(parentMetadata.revision, 0);
  const resolvedRevision = resolvedParentId
    ? Math.max(1, parentRevision + 1)
    : normalizeRevision(revision || metadata.revision, 1);
  const explicitProvenance = provenance && typeof provenance === 'object' && !Array.isArray(provenance)
    ? provenance
    : {};
  const createdFromArtifactIds = Array.from(new Set([
    ...(Array.isArray(sourceArtifactIds) ? sourceArtifactIds : []),
    ...(Array.isArray(metadata.artifactIds) ? metadata.artifactIds : []),
  ].map((value) => normalizeText(value)).filter(Boolean))).slice(0, 32);
  const resolvedProvenance = {
    schemaVersion: 'ArtifactProvenance/v1',
    sourceSurface: normalizeText(toolContext.clientSurface || sourceMode || explicitProvenance.sourceSurface || 'artifact-generation'),
    runId: normalizeText(
      toolContext.runId
      || toolContext.agentRunId
      || session?.metadata?.activeAgentRunId
      || explicitProvenance.runId,
    ),
    sessionId: currentSessionId,
    createdFromArtifactIds,
    createdAt: new Date().toISOString(),
  };

  return {
    ...metadata,
    lineageVersion: ARTIFACT_LINEAGE_VERSION,
    ...(resolvedMissionId ? { missionId: resolvedMissionId } : {}),
    ...(resolvedParentId ? { parentArtifactId: resolvedParentId } : {}),
    revision: resolvedRevision,
    provenance: resolvedProvenance,
  };
}

module.exports = {
  ARTIFACT_LINEAGE_VERSION,
  buildArtifactLineageMetadata,
};
