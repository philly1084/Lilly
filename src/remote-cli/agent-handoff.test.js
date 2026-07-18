'use strict';

const crypto = require('crypto');
const {
  REMOTE_AGENT_HANDOFF_VERSION,
  REMOTE_AGENT_RESULT_FILES_VERSION,
  buildRemoteAgentHandoffPrompt,
  createRemoteAgentHandoff,
  normalizeHandoffFiles,
} = require('./agent-handoff');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

describe('RemoteAgentHandoff', () => {
  test('preserves XML, SVG, binary, and session-owned artifacts with checksums', async () => {
    const artifactBytes = Buffer.from([0x00, 0xff, 0x42, 0x19]);
    const artifactService = {
      getArtifact: jest.fn(async (id, options) => ({
        id,
        sessionId: 'session-1',
        filename: 'reference.bin',
        mimeType: 'application/octet-stream',
        contentBuffer: artifactBytes,
        sizeBytes: artifactBytes.length,
        sha256: sha256(artifactBytes),
        metadata: { title: 'Binary design reference' },
        options,
      })),
    };
    const xml = '<document><title>Design brief</title></document>';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>';

    const handoff = await createRemoteAgentHandoff({
      artifactIds: ['artifact-1'],
      contextFiles: [
        { filename: 'brief.xml', mimeType: 'application/xml', content: xml },
        { filename: 'diagram.svg', mimeType: 'image/svg+xml', contentBase64: Buffer.from(svg).toString('base64') },
      ],
      resultFileGlobs: ['dist/*.html', 'artifacts/*.svg'],
    }, {
      sessionId: 'session-1',
    }, {
      artifactService,
      operationId: '11111111-2222-4333-8444-555555555555',
    });

    expect(handoff).toMatchObject({
      version: REMOTE_AGENT_HANDOFF_VERSION,
      operationId: '11111111-2222-4333-8444-555555555555',
      contextDirectory: '.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/input',
      manifestPath: '.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/input/manifest.json',
      sourceArtifactIds: ['artifact-1'],
      output: {
        version: REMOTE_AGENT_RESULT_FILES_VERSION,
        enabled: true,
        directory: '.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/output',
        filesDirectory: '.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/output/files',
        manifestPath: '.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/output/manifest.json',
        requestedGlobs: ['dist/*.html', 'artifacts/*.svg'],
      },
    });
    expect(artifactService.getArtifact).toHaveBeenNthCalledWith(1, 'artifact-1');
    expect(artifactService.getArtifact).toHaveBeenCalledWith('artifact-1', { includeContent: true });
    expect(handoff.files.map((file) => file.filename)).toEqual([
      'brief.xml',
      'diagram.svg',
      'reference.bin',
    ]);
    expect(Buffer.from(handoff.files[0].contentBase64, 'base64').toString('utf8')).toBe(xml);
    expect(Buffer.from(handoff.files[1].contentBase64, 'base64').toString('utf8')).toBe(svg);
    expect(Buffer.from(handoff.files[2].contentBase64, 'base64')).toEqual(artifactBytes);
    handoff.files.forEach((file) => {
      expect(file.sha256).toBe(sha256(Buffer.from(file.contentBase64, 'base64')));
    });

    const prompt = buildRemoteAgentHandoffPrompt(handoff);
    expect(prompt).toContain('RemoteAgentHandoff/v1');
    expect(prompt).toContain('Never git-add, commit, publish, or deploy');
    expect(prompt).toContain('.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/input/manifest.json');
    expect(prompt).toContain('brief.xml (application/xml');
    expect(prompt).toContain('diagram.svg (image/svg+xml');
    expect(prompt).toContain('RESULT_FILES_MANIFEST=.kimibuilt/agent-runs/11111111-2222-4333-8444-555555555555/output/manifest.json');
  });

  test('fails closed when artifact ownership cannot be proven', async () => {
    const artifactService = {
      getArtifact: jest.fn(async () => ({
        id: 'artifact-1',
        sessionId: 'session-other',
        filename: 'secret.txt',
        contentBuffer: Buffer.from('secret'),
      })),
    };

    await expect(createRemoteAgentHandoff({
      artifactIds: ['artifact-1'],
    }, {}, { artifactService })).rejects.toMatchObject({
      code: 'REMOTE_AGENT_HANDOFF_SESSION_REQUIRED',
    });

    await expect(createRemoteAgentHandoff({
      artifactIds: ['artifact-1'],
    }, { sessionId: 'session-1' }, { artifactService })).rejects.toMatchObject({
      code: 'REMOTE_AGENT_HANDOFF_ARTIFACT_SCOPE_MISMATCH',
    });
  });

  test('does not create a handoff for read-only calls without selected files', async () => {
    await expect(createRemoteAgentHandoff({
      task: 'Inspect the remote service.',
    })).resolves.toBeNull();
  });

  test('uses a distinct isolated directory for every invocation', async () => {
    const first = await createRemoteAgentHandoff(
      { collectResultFiles: true },
      { sessionId: 'session-1' },
    );
    const second = await createRemoteAgentHandoff(
      { collectResultFiles: true },
      { sessionId: 'session-1' },
    );

    expect(first.operationId).not.toBe(second.operationId);
    expect(first.runDirectory).not.toBe(second.runDirectory);
    expect(first.manifestPath).not.toBe(second.manifestPath);
    expect(first.output.manifestPath).not.toBe(second.output.manifestPath);
  });

  test('rejects unsafe output globs and invalid file checksums', async () => {
    await expect(createRemoteAgentHandoff({
      collectResultFiles: true,
      resultFileGlobs: ['../outside/*'],
    })).rejects.toMatchObject({
      code: 'REMOTE_AGENT_HANDOFF_UNSAFE_PATH',
    });

    expect(() => normalizeHandoffFiles([{
      filename: 'diagram.svg',
      content: '<svg/>',
      sha256: '0'.repeat(64),
    }])).toThrow('checksum mismatch');
  });

  test('rejects duplicate filenames after sanitization', () => {
    expect(() => normalizeHandoffFiles([
      { filename: 'design/brief.xml', content: '<one/>' },
      { filename: 'design\\brief.xml', content: '<two/>' },
    ])).toThrow('duplicate filename');
  });

  test('reserves manifest.json for gateway metadata', () => {
    expect(() => normalizeHandoffFiles([
      { filename: 'manifest.json', content: '{}' },
    ])).toThrow('reserved for gateway metadata');
  });

  test('preflights oversized artifacts before loading their content', async () => {
    const artifactService = {
      getArtifact: jest.fn(async (_id, options) => {
        if (options?.includeContent) {
          throw new Error('content must not be loaded');
        }
        return {
          id: 'artifact-large',
          sessionId: 'session-1',
          filename: 'large.zip',
          sizeBytes: (4 * 1024 * 1024) + 1,
        };
      }),
    };

    await expect(createRemoteAgentHandoff({
      artifactIds: ['artifact-large'],
    }, { sessionId: 'session-1' }, { artifactService })).rejects.toMatchObject({
      code: 'REMOTE_AGENT_HANDOFF_FILE_TOO_LARGE',
    });
    expect(artifactService.getArtifact).toHaveBeenCalledTimes(1);
    expect(artifactService.getArtifact).toHaveBeenCalledWith('artifact-large');
  });

  test('requires an active session before creating an output-enabled handoff', async () => {
    await expect(createRemoteAgentHandoff({
      collectResultFiles: true,
    })).rejects.toMatchObject({
      code: 'REMOTE_AGENT_HANDOFF_SESSION_REQUIRED',
    });
  });

  test.each([
    ['mimeType', 'x'.repeat(257)],
    ['source', 'x'.repeat(65)],
    ['sourceUrl', 'x'.repeat(2049)],
    ['artifactId', 'x'.repeat(257)],
    ['description', 'x'.repeat(2001)],
  ])('rejects %s values longer than the nuts handoff contract', (field, value) => {
    expect(() => normalizeHandoffFiles([{
      filename: 'brief.xml',
      content: '<brief/>',
      [field]: value,
    }])).toThrow(expect.objectContaining({
      code: 'REMOTE_AGENT_HANDOFF_FIELD_TOO_LONG',
    }));
  });

  test('rejects overlong result globs and source artifact IDs before gateway submission', async () => {
    await expect(createRemoteAgentHandoff({
      collectResultFiles: true,
      resultFileGlobs: ['x'.repeat(513)],
    }, { sessionId: 'session-1' })).rejects.toMatchObject({
      code: 'REMOTE_AGENT_HANDOFF_FIELD_TOO_LONG',
    });

    const artifactService = { getArtifact: jest.fn() };
    await expect(createRemoteAgentHandoff({
      artifactIds: ['x'.repeat(257)],
      collectResultFiles: false,
    }, { sessionId: 'session-1' }, { artifactService })).rejects.toMatchObject({
      code: 'REMOTE_AGENT_HANDOFF_FIELD_TOO_LONG',
    });
    expect(artifactService.getArtifact).not.toHaveBeenCalled();
  });

  test('fails closed before content loading for PII-protected uploaded artifacts', async () => {
    const artifactService = {
      getArtifact: jest.fn(async () => ({
        id: 'artifact-private-1',
        sessionId: 'session-1',
        direction: 'uploaded',
        filename: 'customers.csv',
        mimeType: 'text/csv',
        sizeBytes: 24,
        metadata: {
          privacyPreviewSuppressed: true,
          piiCleansing: { uploadPreviewSuppressed: true },
        },
      })),
    };

    await expect(createRemoteAgentHandoff({
      artifactIds: ['artifact-private-1'],
    }, { sessionId: 'session-1' }, { artifactService })).rejects.toMatchObject({
      code: 'REMOTE_AGENT_HANDOFF_ARTIFACT_PRIVACY_RESTRICTED',
    });
    expect(artifactService.getArtifact).toHaveBeenCalledTimes(1);
    expect(artifactService.getArtifact).toHaveBeenCalledWith('artifact-private-1');
  });
});
