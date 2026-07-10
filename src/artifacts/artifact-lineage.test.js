'use strict';

const { buildArtifactLineageMetadata } = require('./artifact-lineage');

describe('artifact lineage', () => {
  test('starts generated artifacts at revision one with mission provenance', () => {
    expect(buildArtifactLineageMetadata({
      missionId: 'mission-1',
      session: { id: 'session-1', metadata: { activeAgentRunId: 'run-1' } },
      toolContext: { clientSurface: 'web-chat' },
    })).toEqual(expect.objectContaining({
      lineageVersion: 'ArtifactLineage/v1',
      missionId: 'mission-1',
      revision: 1,
      provenance: expect.objectContaining({
        sourceSurface: 'web-chat',
        runId: 'run-1',
        sessionId: 'session-1',
      }),
    }));
  });

  test('inherits the mission and increments the parent revision', () => {
    const metadata = buildArtifactLineageMetadata({
      parentArtifact: {
        id: 'artifact-parent',
        metadata: { missionId: 'mission-parent', revision: 3 },
      },
      sourceArtifactIds: ['artifact-parent'],
    });
    expect(metadata).toEqual(expect.objectContaining({
      missionId: 'mission-parent',
      parentArtifactId: 'artifact-parent',
      revision: 4,
    }));
    expect(metadata.provenance.createdFromArtifactIds).toEqual(['artifact-parent']);
  });

  test('deduplicates and bounds provenance artifact references', () => {
    const metadata = buildArtifactLineageMetadata({
      metadata: { artifactIds: ['a', 'b'] },
      sourceArtifactIds: ['a', 'c'],
    });
    expect(metadata.provenance.createdFromArtifactIds).toEqual(['a', 'c', 'b']);
  });

  test('parent lineage overrides caller mission and revision claims', () => {
    const metadata = buildArtifactLineageMetadata({
      parentArtifact: {
        id: 'artifact-parent',
        metadata: { missionId: 'mission-parent', revision: 3 },
      },
      parentArtifactId: 'artifact-parent',
      missionId: 'forged-mission',
      revision: 1,
      provenance: { runId: 'forged-run', createdAt: '2000-01-01T00:00:00.000Z' },
      toolContext: { runId: 'run-current' },
    });

    expect(metadata.missionId).toBe('mission-parent');
    expect(metadata.revision).toBe(4);
    expect(metadata.provenance.runId).toBe('run-current');
    expect(metadata.provenance.createdAt).not.toBe('2000-01-01T00:00:00.000Z');
  });

  test('rejects an unverified or cross-session parent', () => {
    expect(() => buildArtifactLineageMetadata({ parentArtifactId: 'missing-parent' }))
      .toThrow('could not be verified');
    expect(() => buildArtifactLineageMetadata({
      parentArtifact: {
        id: 'artifact-parent',
        metadata: { provenance: { sessionId: 'session-a' } },
      },
      session: { id: 'session-b' },
    })).toThrow('cross session');
  });
});
