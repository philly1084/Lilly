const fs = require('fs/promises');
const path = require('path');
const {
  deleteSandboxWorkspace,
  deleteSandboxWorkspacesForArtifacts,
  getArtifactSandboxWorkspaceId,
  normalizeSandboxWorkspaceId,
  resolveSandboxWorkspacePath,
} = require('./sandbox-workspace-storage');

describe('sandbox workspace storage', () => {
  let testRoot;

  beforeEach(async () => {
    const parent = path.join(process.cwd(), 'tmp', 'sandbox-workspace-storage-tests');
    await fs.mkdir(parent, { recursive: true });
    testRoot = await fs.mkdtemp(path.join(parent, 'run-'));
  });

  afterEach(async () => {
    if (testRoot) {
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  });

  test('normalizes one bounded workspace segment and rejects traversal', () => {
    expect(normalizeSandboxWorkspaceId('project-123')).toBe('project-123');
    expect(normalizeSandboxWorkspaceId('../project-123')).toBe('');
    expect(resolveSandboxWorkspacePath('project-123', testRoot)).toBe(path.join(testRoot, 'project-123'));
    expect(resolveSandboxWorkspacePath('..', testRoot)).toBeNull();
  });

  test('deletes only code-sandbox project workspaces linked by artifact metadata', async () => {
    const ownedWorkspaceId = 'owned-project-123';
    const unrelatedWorkspaceId = 'unrelated-project-456';
    await fs.mkdir(path.join(testRoot, ownedWorkspaceId), { recursive: true });
    await fs.mkdir(path.join(testRoot, unrelatedWorkspaceId), { recursive: true });
    await fs.writeFile(path.join(testRoot, ownedWorkspaceId, 'index.html'), '<main>owned</main>');

    const artifact = {
      sourceMode: 'sandbox',
      metadata: {
        createdByAgentTool: true,
        toolId: 'code-sandbox',
        projectMode: 'frontend',
        sandboxWorkspaceId: ownedWorkspaceId,
      },
    };
    expect(getArtifactSandboxWorkspaceId(artifact)).toBe(ownedWorkspaceId);

    await expect(deleteSandboxWorkspacesForArtifacts([
      artifact,
      {
        ...artifact,
        sourceMode: 'artifact-attach',
        metadata: { ...artifact.metadata, sandboxWorkspaceId: unrelatedWorkspaceId },
      },
    ], { root: testRoot })).resolves.toEqual({
      deletedWorkspaceIds: [ownedWorkspaceId],
      missingWorkspaceIds: [],
    });
    await expect(fs.access(path.join(testRoot, ownedWorkspaceId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(testRoot, unrelatedWorkspaceId))).resolves.toBeUndefined();
  });

  test('treats an already absent exact workspace as an idempotent miss', async () => {
    await expect(deleteSandboxWorkspace('missing-project', { root: testRoot })).resolves.toBe(false);
  });
});
