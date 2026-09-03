'use strict';

// Validate metadata, not authorization: the target still enforces allowed roots.
function normalizeRemoteWorkspace(value) {
  const path = String(value || '').trim().replace(/^`([^`]+)`$/, '$1');
  if (!path.startsWith('/') || path.startsWith('//') || path.length > 1024
    || /[\r\n\t\\"'`{}<>|;&]/.test(path) || path.split('/').includes('..')) {
    return '';
  }
  return path;
}

function resolveTargetDefaultWorkspace(targetId, config = {}) {
  // A different target owns its default. Never borrow the primary host's cwd.
  return !targetId || targetId === config.defaultTargetId
    ? normalizeRemoteWorkspace(config.defaultCwd)
    : '';
}

function normalizeInheritedRemoteWorkspace(value, targetId, config = {}) {
  const path = normalizeRemoteWorkspace(value);
  return targetId && targetId !== config.defaultTargetId && path === normalizeRemoteWorkspace(config.defaultCwd)
    ? '' : path;
}

module.exports = { normalizeRemoteWorkspace, normalizeInheritedRemoteWorkspace, resolveTargetDefaultWorkspace };
