'use strict';

const crypto = require('crypto');
const {
  buildRemoteAgentSiteBundlePlan,
  persistRemoteAgentResultArtifacts,
} = require('./agent-result-artifacts');
const { createRemoteAgentHandoff } = require('./agent-handoff');
const { readZipEntries } = require('../utils/zip');

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
    const records = new Map();
    let counter = 0;
    const artifactService = {
      createStoredArtifact: jest.fn(async (input) => {
        const stored = {
          ...input,
          id: `artifact-output-${++counter}`,
          sizeBytes: input.buffer.length,
          contentBuffer: input.buffer,
        };
        records.set(stored.id, stored);
        return stored;
      }),
      getArtifact: jest.fn(async (id) => records.get(id) || null),
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
    expect(persisted.artifactQuality).toMatchObject({
      version: 'ArtifactStructuralQuality/v1',
      status: 'passed',
      blockers: [],
    });
    expect(persisted).not.toHaveProperty('siteBundleArtifact');
    expect(persisted).not.toHaveProperty('siteBundleArtifactId');
    expect(persisted.resultFiles).toEqual([
      expect.objectContaining({
        filename: 'index.html',
        role: 'preview',
        artifactQuality: expect.objectContaining({
          status: 'passed',
          scope: 'file',
          basis: 'persisted-result-set',
          format: 'html',
        }),
      }),
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
        artifactQuality: expect.objectContaining({
          status: 'passed',
          scope: 'file',
          basis: 'normalized-result-set',
        }),
        remoteAgentHandoff: expect.objectContaining({ operationId: fixture.handoff.operationId }),
      }),
    }));
    expect(artifactService.getArtifact).toHaveBeenNthCalledWith(
      1,
      'artifact-output-1',
      { includeContent: true },
    );
    expect(artifactService.getArtifact).toHaveBeenNthCalledWith(
      2,
      'artifact-output-2',
      { includeContent: true },
    );
    expect(persisted.sourceArtifactQuality).toMatchObject({
      status: 'passed',
      basis: 'normalized-result-set',
    });
    expect(persisted.artifactQuality).toMatchObject({
      status: 'passed',
      basis: 'persisted-result-set',
    });
    expect(persisted.resultFiles[0].artifactQuality).not.toHaveProperty('promotionEligible');
  });

  test('blocks the entire normalized set before writes with a stable quality error', async () => {
    const fixture = buildFixture();
    const invalidJson = Buffer.from('{"ready":}');
    fixture.resultFiles.files.push({
      path: `${fixture.handoff.output.filesDirectory}/data.json`,
      filename: 'data.json',
      mimeType: 'application/json',
      role: 'data',
      description: 'Invalid data file',
      sizeBytes: invalidJson.length,
      sha256: crypto.createHash('sha256').update(invalidJson).digest('hex'),
      contentBase64: invalidJson.toString('base64'),
    });
    const artifactService = { createStoredArtifact: jest.fn() };
    let thrown = null;

    try {
      await persistRemoteAgentResultArtifacts({
        ...fixture,
        artifactService,
        context: { sessionId: 'session-1' },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'REMOTE_AGENT_ARTIFACT_QUALITY_BLOCKED',
      artifactQuality: {
        version: 'ArtifactStructuralQuality/v1',
        status: 'blocked',
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: 'REMOTE_AGENT_ARTIFACT_JSON_INVALID', path: 'data.json' }),
        ]),
      },
    });
    expect(thrown.message).toBe('Remote agent artifact structural quality validation blocked 1 issue.');
    expect(artifactService.createStoredArtifact).not.toHaveBeenCalled();
  });

  test.each([
    {
      label: 'JSON',
      filename: 'data.json',
      mimeType: 'application/json',
      source: '{"ready":true}',
      persisted: '{"ready":}',
      blockerCode: 'REMOTE_AGENT_ARTIFACT_JSON_INVALID',
    },
    {
      label: 'XML',
      filename: 'brief.xml',
      mimeType: 'application/xml',
      source: '<brief><status>ready</status></brief>',
      persisted: '<brief><status></brief>',
      blockerCode: 'REMOTE_AGENT_ARTIFACT_XML_INVALID',
    },
    {
      label: 'SVG',
      filename: 'diagram.svg',
      mimeType: 'image/svg+xml',
      source: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="8"/></svg>',
      persisted: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      blockerCode: 'REMOTE_AGENT_ARTIFACT_SVG_ACTIVE_CONTENT',
    },
    {
      label: 'HTML',
      filename: 'index.html',
      mimeType: 'text/html',
      source: '<!doctype html><main>Ready</main>',
      persisted: '<!doctype html><html><head><title>Empty</title></head><body></body></html>',
      blockerCode: 'REMOTE_AGENT_ARTIFACT_HTML_EMPTY',
    },
  ])('rolls back an invalid $label rewrite found in reloaded storage bytes', async ({
    filename,
    mimeType,
    source,
    persisted,
    blockerCode,
  }) => {
    const fixture = buildFixture();
    const sourceBuffer = Buffer.from(source);
    const persistedBuffer = Buffer.from(persisted);
    fixture.resultFiles.files = [{
      path: `${fixture.handoff.output.filesDirectory}/${filename}`,
      filename,
      mimeType,
      role: 'deliverable',
      description: `Valid ${filename} before storage restoration`,
      sizeBytes: sourceBuffer.length,
      sha256: crypto.createHash('sha256').update(sourceBuffer).digest('hex'),
      contentBase64: sourceBuffer.toString('base64'),
    }];
    const records = new Map();
    const artifactService = {
      createStoredArtifact: jest.fn(async (input) => {
        const stored = {
          ...input,
          id: `artifact-rewritten-${filename}`,
          contentBuffer: persistedBuffer,
          sizeBytes: persistedBuffer.length,
        };
        records.set(stored.id, stored);
        return stored;
      }),
      getArtifact: jest.fn(async (id) => records.get(id) || null),
      serializeArtifact: jest.fn((artifact) => artifact),
      deleteArtifact: jest.fn(async (id) => records.delete(id)),
    };

    await expect(persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService,
      context: { sessionId: 'session-1' },
    })).rejects.toMatchObject({
      code: 'REMOTE_AGENT_ARTIFACT_QUALITY_BLOCKED',
      artifactQualityBasis: 'persisted-result-set',
      artifactQuality: {
        status: 'blocked',
        basis: 'persisted-result-set',
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: blockerCode, path: filename }),
        ]),
      },
    });

    expect(artifactService.createStoredArtifact).toHaveBeenCalledTimes(1);
    expect(artifactService.getArtifact).toHaveBeenCalledWith(
      `artifact-rewritten-${filename}`,
      { includeContent: true },
    );
    expect(artifactService.serializeArtifact).not.toHaveBeenCalled();
    expect(artifactService.deleteArtifact).toHaveBeenCalledWith(`artifact-rewritten-${filename}`);
    expect(records.size).toBe(0);
  });

  test('does not let unrelated returned files satisfy explicit site closure', async () => {
    const fixture = buildFixture();
    const html = Buffer.from('<!doctype html><main><script src="private.js"></script></main>');
    const javascript = Buffer.from('console.log("private");');
    fixture.resultFiles.files[0] = {
      ...fixture.resultFiles.files[0],
      role: 'site-entry',
      sizeBytes: html.length,
      sha256: crypto.createHash('sha256').update(html).digest('hex'),
      contentBase64: html.toString('base64'),
    };
    fixture.resultFiles.files[1].role = 'site-file';
    fixture.resultFiles.files.push({
      path: `${fixture.handoff.output.filesDirectory}/private.js`,
      filename: 'private.js',
      mimeType: 'text/javascript',
      role: 'qa',
      description: 'Unrelated QA helper',
      sizeBytes: javascript.length,
      sha256: crypto.createHash('sha256').update(javascript).digest('hex'),
      contentBase64: javascript.toString('base64'),
    });
    const artifactService = { createStoredArtifact: jest.fn() };

    await expect(persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService,
      context: { sessionId: 'session-1' },
    })).rejects.toMatchObject({
      code: 'REMOTE_AGENT_ARTIFACT_QUALITY_BLOCKED',
      artifactQuality: {
        blockers: expect.arrayContaining([
          expect.objectContaining({
            code: 'REMOTE_AGENT_ARTIFACT_SITE_REFERENCE_MISSING',
            reference: 'private.js',
          }),
        ]),
      },
    });
    expect(artifactService.createStoredArtifact).not.toHaveBeenCalled();
  });

  test('assembles explicitly-role-marked stored files into a rooted native site bundle', async () => {
    const fixture = buildFixture();
    const makeSiteFile = (relativePath, mimeType, content, role, description) => {
      const buffer = Buffer.from(content);
      return {
        path: `${fixture.handoff.output.filesDirectory}/${relativePath}`,
        filename: relativePath.split('/').at(-1),
        mimeType,
        role,
        description,
        sizeBytes: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        contentBase64: buffer.toString('base64'),
      };
    };
    fixture.resultFiles.files = [
      makeSiteFile(
        'dist/index.html',
        'text/html',
        '<!doctype html><html><head><title>Agent Atlas</title><link rel="stylesheet" href="styles.css"></head><body><img src="assets/map.svg"></body></html>',
        'site-entry',
        'Site entry',
      ),
      makeSiteFile('dist/styles.css', 'text/css', 'body { color: navy; }', 'site-file', 'Site styles'),
      makeSiteFile('dist/assets/map.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h8v8z"/></svg>', 'site-file', 'Site map'),
      makeSiteFile('dist/data/brief.xml', 'application/xml', '<brief><status>ready</status></brief>', 'site-file', 'Site data'),
      makeSiteFile('qa/report.txt', 'text/plain', 'desktop and mobile passed', 'qa', 'QA evidence'),
    ];

    const records = new Map();
    let counter = 0;
    const artifactService = {
      createStoredArtifact: jest.fn(async (input) => {
        const stored = {
          ...input,
          id: `artifact-site-${++counter}`,
          sizeBytes: input.buffer.length,
          contentBuffer: input.buffer,
        };
        records.set(stored.id, stored);
        return stored;
      }),
      getArtifact: jest.fn(async (id) => records.get(id) || null),
      serializeArtifact: jest.fn((artifact) => ({
        id: artifact.id,
        filename: artifact.filename,
        extension: artifact.extension,
        metadata: artifact.metadata,
      })),
      deleteArtifact: jest.fn(),
    };

    const persisted = await persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService,
      context: { sessionId: 'session-1', ownerId: 'owner-1' },
      runResult: { transport: 'codex-agent', providerId: 'kimi', targetId: 'k3s-prod' },
    });

    expect(persisted.siteBundleArtifactId).toBe('artifact-site-6');
    expect(persisted.siteBundleArtifact).toEqual(expect.objectContaining({
      id: 'artifact-site-6',
      extension: 'zip',
      metadata: expect.objectContaining({
        title: 'Agent Atlas',
        generationStrategy: 'remote-agent-result-site-bundle',
        artifactQuality: expect.objectContaining({
          status: 'passed',
          scope: 'site-bundle',
          basis: 'persisted-result-set',
          entry: 'index.html',
          fileCount: 4,
        }),
        siteBundle: expect.objectContaining({
          entry: 'index.html',
          fileCount: 4,
          htmlPageCount: 1,
        }),
      }),
    }));
    expect(persisted.siteBundleArtifact.metadata.siteBundle.files.map((file) => file.path)).toEqual([
      'index.html',
      'styles.css',
      'assets/map.svg',
      'data/brief.xml',
    ]);
    expect(persisted.resultFiles[4]).toEqual(expect.objectContaining({
      relativePath: 'qa/report.txt',
      artifactId: 'artifact-site-5',
    }));
    expect(records.get('artifact-site-1').metadata.hiddenFromArtifactList).toBe(true);
    expect(records.get('artifact-site-4').metadata.hiddenFromArtifactList).toBe(true);
    expect(records.get('artifact-site-5').metadata.hiddenFromArtifactList).toBeUndefined();
    expect(persisted.siteBundleArtifact.metadata.artifactQuality).not.toHaveProperty('promotionEligible');

    const archive = readZipEntries(records.get('artifact-site-6').contentBuffer);
    expect(Array.from(archive.keys())).toEqual([
      'index.html',
      'styles.css',
      'assets/map.svg',
      'data/brief.xml',
    ]);
    expect(archive.get('assets/map.svg').equals(records.get('artifact-site-3').contentBuffer)).toBe(true);
    expect(archive.get('data/brief.xml').equals(records.get('artifact-site-4').contentBuffer)).toBe(true);
    expect(archive.has('qa/report.txt')).toBe(false);
  });

  test('builds site archives from persisted component bytes after storage processing', async () => {
    const fixture = buildFixture();
    fixture.resultFiles.files[0].role = 'site-entry';
    fixture.resultFiles.files[1].role = 'site-file';
    const restoredHtml = Buffer.from('<!doctype html><title>Restored Site</title><main>Private value restored</main>');
    const records = new Map();
    let counter = 0;
    const artifactService = {
      createStoredArtifact: jest.fn(async (input) => {
        const id = `artifact-restored-${++counter}`;
        const stored = {
          ...input,
          id,
          contentBuffer: counter === 1 ? restoredHtml : input.buffer,
        };
        records.set(id, stored);
        return stored;
      }),
      getArtifact: jest.fn(async (id) => records.get(id) || null),
      serializeArtifact: jest.fn((artifact) => ({ id: artifact.id, filename: artifact.filename, metadata: artifact.metadata })),
      deleteArtifact: jest.fn(),
    };

    const persisted = await persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService,
      context: { sessionId: 'session-1' },
    });
    const archive = readZipEntries(records.get(persisted.siteBundleArtifactId).contentBuffer);

    expect(archive.get('index.html').equals(restoredHtml)).toBe(true);
    expect(records.get(persisted.siteBundleArtifactId).previewHtml).toBe(restoredHtml.toString('utf8'));
    expect(persisted.siteBundleArtifact.metadata.siteBundle.files[0]).toEqual(expect.objectContaining({
      gatewaySha256: fixture.resultFiles.files[0].sha256,
      sha256: crypto.createHash('sha256').update(restoredHtml).digest('hex'),
    }));
  });

  test('requires reload and rollback support before writing site bundle components', async () => {
    const fixture = buildFixture();
    fixture.resultFiles.files[0].role = 'site-entry';
    fixture.resultFiles.files[1].role = 'site-file';
    const artifactService = { createStoredArtifact: jest.fn() };

    await expect(persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService,
      context: { sessionId: 'session-1' },
    })).rejects.toMatchObject({ code: 'REMOTE_AGENT_SITE_BUNDLE_STORE_UNAVAILABLE' });
    expect(artifactService.createStoredArtifact).not.toHaveBeenCalled();
  });

  test.each([
    {
      label: 'has no site entry',
      files: [
        { path: 'site/styles.css', filename: 'styles.css', role: 'site-file', mimeType: 'text/css', sizeBytes: 1 },
      ],
      code: 'REMOTE_AGENT_SITE_BUNDLE_ENTRY_INVALID',
    },
    {
      label: 'has more than one site entry',
      files: [
        { path: 'site/index.html', filename: 'index.html', role: 'site-entry', mimeType: 'text/html', sizeBytes: 1 },
        { path: 'site/nested/index.html', filename: 'index.html', role: 'site-entry', mimeType: 'text/html', sizeBytes: 1 },
        { path: 'site/styles.css', filename: 'styles.css', role: 'site-file', mimeType: 'text/css', sizeBytes: 1 },
      ],
      code: 'REMOTE_AGENT_SITE_BUNDLE_ENTRY_INVALID',
    },
    {
      label: 'uses a non-index entry name',
      files: [
        { path: 'site/home.html', filename: 'home.html', role: 'site-entry', mimeType: 'text/html', sizeBytes: 1 },
        { path: 'site/styles.css', filename: 'styles.css', role: 'site-file', mimeType: 'text/css', sizeBytes: 1 },
      ],
      code: 'REMOTE_AGENT_SITE_BUNDLE_ENTRY_INVALID',
    },
    {
      label: 'includes a member outside the entry root',
      files: [
        { path: 'site/index.html', filename: 'index.html', role: 'site-entry', mimeType: 'text/html', sizeBytes: 1 },
        { path: 'shared/styles.css', filename: 'styles.css', role: 'site-file', mimeType: 'text/css', sizeBytes: 1 },
      ],
      code: 'REMOTE_AGENT_SITE_BUNDLE_ROOT_MISMATCH',
    },
  ])('rejects an explicit site bundle that $label before artifact writes', async ({ files, code }) => {
    const handoff = {
      output: { filesDirectory: 'output/files' },
    };
    const artifactService = { createStoredArtifact: jest.fn() };
    let thrown = null;

    try {
      buildRemoteAgentSiteBundlePlan(files.map((file) => ({
        ...file,
        path: `${handoff.output.filesDirectory}/${file.path}`,
      })), handoff);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code });
    expect(artifactService.createStoredArtifact).not.toHaveBeenCalled();
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
      getArtifact: jest.fn(),
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

  test('rolls back all components when native site bundle persistence fails', async () => {
    const fixture = buildFixture();
    fixture.resultFiles.files[0].role = 'site-entry';
    fixture.resultFiles.files[1].role = 'site-file';
    const records = new Map();
    let counter = 0;
    const artifactService = {
      createStoredArtifact: jest.fn(async (input) => {
        counter += 1;
        if (counter === 3) {
          throw new Error('bundle store unavailable');
        }
        const stored = { ...input, id: `artifact-component-${counter}`, contentBuffer: input.buffer };
        records.set(stored.id, stored);
        return stored;
      }),
      getArtifact: jest.fn(async (id) => records.get(id) || null),
      serializeArtifact: jest.fn((artifact) => artifact),
      deleteArtifact: jest.fn(async () => true),
    };

    await expect(persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService,
      context: { sessionId: 'session-1' },
    })).rejects.toThrow('bundle store unavailable');
    expect(artifactService.deleteArtifact.mock.calls.map(([id]) => id)).toEqual([
      'artifact-component-2',
      'artifact-component-1',
    ]);
  });

  test('rolls back the bundle and components when result serialization fails', async () => {
    const fixture = buildFixture();
    fixture.resultFiles.files[0].role = 'site-entry';
    fixture.resultFiles.files[1].role = 'site-file';
    const records = new Map();
    let counter = 0;
    const artifactService = {
      createStoredArtifact: jest.fn(async (input) => {
        const stored = { ...input, id: `artifact-serialized-${++counter}`, contentBuffer: input.buffer };
        records.set(stored.id, stored);
        return stored;
      }),
      getArtifact: jest.fn(async (id) => records.get(id) || null),
      serializeArtifact: jest.fn(() => null),
      deleteArtifact: jest.fn(async () => true),
    };

    await expect(persistRemoteAgentResultArtifacts({
      ...fixture,
      artifactService,
      context: { sessionId: 'session-1' },
    })).rejects.toMatchObject({ code: 'REMOTE_AGENT_RESULT_ARTIFACT_SERIALIZATION_FAILED' });
    expect(artifactService.deleteArtifact.mock.calls.map(([id]) => id)).toEqual([
      'artifact-serialized-3',
      'artifact-serialized-2',
      'artifact-serialized-1',
    ]);
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
