const fs = require('fs/promises');
const path = require('path');

const SANDBOX_ROOT = path.resolve(process.cwd(), 'output', 'sandboxes');
const SANDBOX_WORKSPACE_ID_PATTERN = /^[a-z0-9._-]{1,140}$/i;

function normalizeSandboxWorkspaceId(value = '') {
  return String(value || '').trim().match(SANDBOX_WORKSPACE_ID_PATTERN)?.[0] || '';
}

function resolveSandboxWorkspacePath(workspaceId = '', root = SANDBOX_ROOT) {
  const normalizedWorkspaceId = normalizeSandboxWorkspaceId(workspaceId);
  if (!normalizedWorkspaceId) {
    return null;
  }

  const normalizedRoot = path.resolve(root);
  const workspacePath = path.resolve(normalizedRoot, normalizedWorkspaceId);
  if (path.dirname(workspacePath) !== normalizedRoot) {
    return null;
  }
  return workspacePath;
}

function getArtifactSandboxWorkspaceId(artifact = null) {
  const metadata = artifact?.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
    ? artifact.metadata
    : {};
  if (String(artifact?.sourceMode || '').trim().toLowerCase() !== 'sandbox'
    || metadata.createdByAgentTool !== true
    || String(metadata.toolId || '').trim() !== 'code-sandbox'
    || String(metadata.projectMode || '').trim() !== 'frontend') {
    return '';
  }
  return normalizeSandboxWorkspaceId(metadata.sandboxWorkspaceId);
}

async function deleteSandboxWorkspace(workspaceId = '', options = {}) {
  const workspacePath = resolveSandboxWorkspacePath(workspaceId, options.root || SANDBOX_ROOT);
  if (!workspacePath) {
    return false;
  }

  try {
    await (options.fsImpl || fs).rm(workspacePath, { recursive: true, force: false });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function deleteSandboxWorkspacesForArtifacts(artifacts = [], options = {}) {
  const workspaceIds = [...new Set((Array.isArray(artifacts) ? artifacts : [])
    .map((artifact) => getArtifactSandboxWorkspaceId(artifact))
    .filter(Boolean))];
  const deletedWorkspaceIds = [];
  const missingWorkspaceIds = [];

  for (const workspaceId of workspaceIds) {
    if (await deleteSandboxWorkspace(workspaceId, options)) {
      deletedWorkspaceIds.push(workspaceId);
    } else {
      missingWorkspaceIds.push(workspaceId);
    }
  }

  return {
    deletedWorkspaceIds,
    missingWorkspaceIds,
  };
}

module.exports = {
  SANDBOX_ROOT,
  deleteSandboxWorkspace,
  deleteSandboxWorkspacesForArtifacts,
  getArtifactSandboxWorkspaceId,
  normalizeSandboxWorkspaceId,
  resolveSandboxWorkspacePath,
};
