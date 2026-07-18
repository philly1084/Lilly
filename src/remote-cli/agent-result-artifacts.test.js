'use strict';

const crypto = require('crypto');
const {
  persistRemoteAgentResultArtifacts,
} = require('./agent-result-artifacts');
const { createRemoteAgentHandoff } = require('./agent-handoff');

function buildFixture() {
  const operationId = '11111111-2222-4333-8444-555555555555';
  const filesDirectory = `.kimibuilt/agent-runs/${operationId}/output/files`;
  const html = Buffer.from('<!doctype html><title>Agent design</title><main>Ready</main>');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="8"/></svg>');
  const makeFile = (filename, mimeType, buffer, role) => ({
    path: `${filesDirectory}/${filename}`,
    filename,
    mimeType,
    role,
    description: `${role} file`,
    sizeBytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    contentBase64: buffer.toString('base64'),
  });
  const handoff = {
    version: 'RemoteAgentHandoff/v1',
    operationId,
    sourceArtifactIds: ['artifact-source-1'],
    output: {
      enabled: true,
      filesDirectory,
      manifestPath: `.kimibuilt/agent-runs/${operationId}/output/manifest.json`,
    },
  };
  return {
    handoff,
    html,
    svg,
    resultFiles: {
      version: 'RemoteAgentResultFiles/v1',
      gatewayVerified: true,
      operationId,
      manifestPath: handoff.output.manifestPath,
      files: [
        makeFile('index.html', 'text/html', html, 'preview'),
        makeFile('diagram.svg', 'image/svg+xml', svg, 'diagram'),
      ],
    },
  };
}

describe('remote agent result artifacts', () => {
  test('persists gateway-verified files with source lineage and removes base64 from results', async () => {
    const fixture = buildFixture();
    let counter = 0;
    const artifactService = {
      createStoredArtifact: jest.fn(async (input) => ({
        ...input,
        id: `artifact-output-${++counter}`,
        sizeBytes: input.buffer.length,
      })),
      serializeArtifact: jest.fn((artifact) => ({
        id: artifact.id,
        filename: artifact.filename,
        parentArtifactId: artifact.parentArtifactId,
        metadata: artifact.metadata,
      })),
      deleteArtifact: jest.fn(),
    };

    const persisted = await persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService,
      context: { sessionId: 'session-1' },
      runResult: {
        transport: 'codex-agent',
        codexAgentRunId: 'run-1',
        targetId: 'k3s-prod',
        cwd: '/srv/apps/design',
      },
    });

    expect(persisted.artifactIds).toEqual(['artifact-output-1', 'artifact-output-2']);
    expect(persisted.resultFiles).toEqual([
      expect.objectContaining({ filename: 'index.html', role: 'preview' }),
      expect.objectContaining({ filename: 'diagram.svg', role: 'diagram' }),
    ]);
    expect(persisted.resultFiles[0]).not.toHaveProperty('contentBase64');
    expect(artifactService.createStoredArtifact).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'session-1',
      parentArtifactId: 'artifact-source-1',
      sourceMode: 'remote-cli-agent',
      filename: 'index.html',
      previewHtml: fixture.html.toString('utf8'),
      metadata: expect.objectContaining({
        remotePath: expect.stringContaining('/output/files/index.html'),
        remoteAgentHandoff: expect.objectContaining({ operationId: fixture.handoff.operationId }),
      }),
    }));
  });

  test('rejects files outside the isolated output directory', async () => {
    const fixture = buildFixture();
    fixture.resultFiles.files[0].path = '.env';

    await expect(persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService: { createStoredArtifact: jest.fn() },
      context: { sessionId: 'session-1' },
    })).rejects.toMatchObject({
      code: 'REMOTE_AGENT_RESULT_FILES_UNSAFE_PATH',
    });
  });

  test('rejects unverified payloads and checksum mismatches', async () => {
    const fixture = buildFixture();
    fixture.resultFiles.gatewayVerified = false;
    await expect(persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService: { createStoredArtifact: jest.fn() },
      context: { sessionId: 'session-1' },
    })).rejects.toMatchObject({ code: 'REMOTE_AGENT_RESULT_FILES_UNVERIFIED' });

    fixture.resultFiles.gatewayVerified = true;
    fixture.resultFiles.files[0].sha256 = '0'.repeat(64);
    await expect(persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService: { createStoredArtifact: jest.fn() },
      context: { sessionId: 'session-1' },
    })).rejects.toMatchObject({ code: 'REMOTE_AGENT_RESULT_FILES_CHECKSUM_MISMATCH' });
  });

  test('rolls back already-created artifacts when later persistence fails', async () => {
    const fixture = buildFixture();
    const artifactService = {
      createStoredArtifact: jest.fn()
        .mockResolvedValueOnce({ id: 'artifact-output-1' })
        .mockRejectedValueOnce(new Error('store unavailable')),
      serializeArtifact: jest.fn((value) => value),
      deleteArtifact: jest.fn(async () => true),
    };

    await expect(persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService,
      context: { sessionId: 'session-1' },
    })).rejects.toThrow('store unavailable');
    expect(artifactService.deleteArtifact).toHaveBeenCalledWith('artifact-output-1');
  });

  test('preserves nested result identity across duplicate basenames and a second handoff', async () => {
    const fixture = buildFixture();
    const makeNestedFile = (relativePath, content) => {
      const buffer = Buffer.from(content);
      return {
        path: `${fixture.handoff.output.filesDirectory}/${relativePath}`,
        filename: 'index.css',
        mimeType: 'text/css',
        role: 'source',
        description: `${relativePath} stylesheet`,
        sizeBytes: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        contentBase64: buffer.toString('base64'),
      };
    };
    fixture.resultFiles.files = [
      makeNestedFile('css/index.css', 'body { color: navy; }'),
      makeNestedFile('theme/index.css', 'body { background: ivory; }'),
    ];

    const records = new Map();
    let counter = 0;
    const artifactService = {
      createStoredArtifact: jest.fn(async (input) => {
        const stored = {
          ...input,
          id: `artifact-nested-${++counter}`,
          sizeBytes: input.buffer.length,
          contentBuffer: input.buffer,
        };
        records.set(stored.id, stored);
        return stored;
      }),
      serializeArtifact: jest.fn((artifact) => ({
        id: artifact.id,
        sessionId: artifact.sessionId,
        filename: artifact.filename,
        metadata: artifact.metadata,
      })),
      getArtifact: jest.fn(async (id) => records.get(id) || null),
      deleteArtifact: jest.fn(),
    };

    const persisted = await persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService,
      context: { sessionId: 'session-1' },
    });

    expect(persisted.artifacts.map((artifact) => artifact.filename)).toEqual([
      expect.stringMatching(/^css-index-[a-f0-9]{10}\.css$/),
      expect.stringMatching(/^theme-index-[a-f0-9]{10}\.css$/),
    ]);
    expect(new Set(persisted.artifacts.map((artifact) => artifact.filename)).size).toBe(2);
    expect(persisted.resultFiles).toEqual([
      expect.objectContaining({
        filename: 'index.css',
        relativePath: 'css/index.css',
        storedFilename: persisted.artifacts[0].filename,
      }),
      expect.objectContaining({
        filename: 'index.css',
        relativePath: 'theme/index.css',
        storedFilename: persisted.artifacts[1].filename,
      }),
    ]);

    const secondHandoff = await createRemoteAgentHandoff({
      artifactIds: persisted.artifactIds,
      collectResultFiles: false,
    }, { sessionId: 'session-1' }, {
      artifactService,
      operationId: '99999999-8888-4777-8666-555555555555',
    });

    expect(secondHandoff.files.map((file) => file.filename)).toEqual(
      persisted.artifacts.map((artifact) => artifact.filename),
    );
    expect(secondHandoff.files[0].description).toContain('Original relative path: css/index.css.');
    expect(secondHandoff.files[1].description).toContain('Original relative path: theme/index.css.');
  });
});
