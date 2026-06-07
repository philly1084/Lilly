const { config } = require('./config');

const DEFAULT_SESSION_SCOPE = 'global';
const USER_GLOBAL_MEMORY_NAMESPACE = 'user_global';
const PROJECT_SHARED_MEMORY_NAMESPACE = 'project_shared';
const SURFACE_LOCAL_MEMORY_NAMESPACE = 'surface_local';
const SESSION_LOCAL_MEMORY_NAMESPACE = 'session_local';
const DEFAULT_MEMORY_CLASS = 'conversation';
const SURFACE_ONLY_SCOPE_KEYS = new Set([
  DEFAULT_SESSION_SCOPE,
  'default',
  'shared',
  'chat',
  'web-chat',
  'openai-chat',
  'openai-responses',
  'canvas',
  'notation',
  'notes',
  'notes-app',
  'notes-editor',
]);

function normalizeScopeValue(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || null;
}

function firstNormalizedValue(candidates = []) {
  for (const candidate of candidates) {
    const normalized = normalizeScopeValue(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeBooleanValue(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return null;
}

function resolveBooleanValue(value) {
  return normalizeBooleanValue(value);
}

function normalizeMemoryClass(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || DEFAULT_MEMORY_CLASS;
}

function getPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function resolveSessionIsolation(value = {}, session = null, fallback = null) {
  const source = getPlainObject(value);
  const nested = getPlainObject(source.metadata);
  const sessionMetadata = getPlainObject(session?.metadata);
  const clientSurface = resolveClientSurface(source, session, source.sourceSurface || source.source_surface || '');

  if (clientSurface === 'web-chat') {
    return true;
  }

  const candidates = [
    source.sessionIsolation,
    source.session_isolation,
    nested.sessionIsolation,
    nested.session_isolation,
    sessionMetadata.sessionIsolation,
    sessionMetadata.session_isolation,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeBooleanValue(candidate);
    if (normalized != null) {
      return normalized;
    }
  }

  const normalizedFallback = normalizeBooleanValue(fallback);
  return normalizedFallback != null ? normalizedFallback : null;
}

function isSessionIsolationEnabled(value = {}, session = null) {
  const defaultIsolation = resolveClientSurface(value, session) === 'web-chat';
  return resolveSessionIsolation(value, session, defaultIsolation) === true;
}

function hasSessionScopeHints(value = {}) {
  const source = getPlainObject(value);
  const nested = getPlainObject(source.metadata);

  return [
    source.memoryScope,
    source.memory_scope,
    source.projectScope,
    source.project_scope,
    source.projectId,
    source.project_id,
    source.projectKey,
    source.project_key,
    source.workspaceId,
    source.workspace_id,
    source.workspaceKey,
    source.workspace_key,
    source.namespace,
    source.clientSurface,
    source.client_surface,
    source.taskType,
    source.task_type,
    source.mode,
    nested.memoryScope,
    nested.memory_scope,
    nested.projectScope,
    nested.project_scope,
    nested.projectId,
    nested.project_id,
    nested.projectKey,
    nested.project_key,
    nested.workspaceId,
    nested.workspace_id,
    nested.workspaceKey,
    nested.workspace_key,
    nested.namespace,
    nested.clientSurface,
    nested.client_surface,
    nested.taskType,
    nested.task_type,
    nested.mode,
  ].some((candidate) => Boolean(normalizeScopeValue(candidate)));
}

function resolveClientSurface(value = {}, session = null, fallback = '') {
  const source = getPlainObject(value);
  const nested = getPlainObject(source.metadata);
  const sessionMetadata = getPlainObject(session?.metadata);

  return firstNormalizedValue([
    source.clientSurface,
    source.client_surface,
    nested.clientSurface,
    nested.client_surface,
    sessionMetadata.clientSurface,
    sessionMetadata.client_surface,
    fallback,
  ]) || '';
}

function isStrongProjectScopeCandidate(candidate = '', { clientSurface = '', taskType = '', mode = '' } = {}) {
  const normalized = normalizeWebChatWorkspaceScopeKey(candidate);
  if (!normalized) {
    return false;
  }

  if (SURFACE_ONLY_SCOPE_KEYS.has(normalized)) {
    return false;
  }

  const weakMatches = [
    clientSurface,
    taskType,
    mode,
  ]
    .map((entry) => normalizeScopeValue(entry))
    .filter(Boolean);

  return !weakMatches.includes(normalized);
}

function resolveProjectKey(value = {}, session = null, fallback = '') {
  const source = getPlainObject(value);
  const nested = getPlainObject(source.metadata);
  const sessionMetadata = getPlainObject(session?.metadata);
  const context = {
    clientSurface: resolveClientSurface(source, session),
    taskType: firstNormalizedValue([
      source.taskType,
      source.task_type,
      nested.taskType,
      nested.task_type,
      sessionMetadata.taskType,
      sessionMetadata.task_type,
    ]) || '',
    mode: firstNormalizedValue([
      source.mode,
      nested.mode,
      sessionMetadata.mode,
    ]) || '',
  };

  const candidates = [
    source.projectKey,
    source.project_key,
    source.projectId,
    source.project_id,
    source.workspaceKey,
    source.workspace_key,
    source.workspaceId,
    source.workspace_id,
    source.projectScope,
    source.project_scope,
    source.namespace,
    nested.projectKey,
    nested.project_key,
    nested.projectId,
    nested.project_id,
    nested.workspaceKey,
    nested.workspace_key,
    nested.workspaceId,
    nested.workspace_id,
    nested.projectScope,
    nested.project_scope,
    nested.namespace,
    sessionMetadata.projectKey,
    sessionMetadata.project_key,
    sessionMetadata.projectId,
    sessionMetadata.project_id,
    sessionMetadata.workspaceKey,
    sessionMetadata.workspace_key,
    sessionMetadata.workspaceId,
    sessionMetadata.workspace_id,
    sessionMetadata.projectScope,
    sessionMetadata.project_scope,
    sessionMetadata.namespace,
    source.memoryScope,
    source.memory_scope,
    nested.memoryScope,
    nested.memory_scope,
    sessionMetadata.memoryScope,
    sessionMetadata.memory_scope,
    fallback,
  ];

  for (const candidate of candidates) {
    if (isStrongProjectScopeCandidate(candidate, context)) {
      return normalizeWebChatWorkspaceScopeKey(candidate);
    }
  }

  return '';
}

function resolveSessionScope(value = {}, session = null) {
  const source = getPlainObject(value);
  const nested = getPlainObject(source.metadata);
  const sessionMetadata = getPlainObject(session?.metadata);
  const clientSurface = resolveClientSurface(source, session);

  const resolvedScope = normalizeWebChatWorkspaceScopeKey(firstNormalizedValue([
    source.memoryScope,
    source.memory_scope,
    source.projectScope,
    source.project_scope,
    source.projectId,
    source.project_id,
    source.projectKey,
    source.project_key,
    source.workspaceId,
    source.workspace_id,
    source.workspaceKey,
    source.workspace_key,
    source.namespace,
    nested.memoryScope,
    nested.memory_scope,
    nested.projectScope,
    nested.project_scope,
    nested.projectId,
    nested.project_id,
    nested.projectKey,
    nested.project_key,
    nested.workspaceId,
    nested.workspace_id,
    nested.workspaceKey,
    nested.workspace_key,
    nested.namespace,
    sessionMetadata.memoryScope,
    sessionMetadata.memory_scope,
    sessionMetadata.projectScope,
    sessionMetadata.project_scope,
    sessionMetadata.projectId,
    sessionMetadata.project_id,
    sessionMetadata.projectKey,
    sessionMetadata.project_key,
    sessionMetadata.workspaceId,
    sessionMetadata.workspace_id,
    sessionMetadata.workspaceKey,
    sessionMetadata.workspace_key,
    sessionMetadata.namespace,
    clientSurface,
    source.taskType,
    source.task_type,
    nested.taskType,
    nested.task_type,
    sessionMetadata.taskType,
    sessionMetadata.task_type,
    source.mode,
    nested.mode,
    sessionMetadata.mode,
  ]) || DEFAULT_SESSION_SCOPE);

  if (
    clientSurface === 'web-chat'
    && [DEFAULT_SESSION_SCOPE, 'global', 'default', 'chat'].includes(resolvedScope)
  ) {
    return 'web-chat';
  }

  return resolvedScope;
}

function defaultShareAcrossSurfaces(memoryClass = DEFAULT_MEMORY_CLASS) {
  return [
    'user_preference',
    'collaboration_preference',
    'tool_preference',
    'reusable_skill',
    'project_fact',
    'project_task',
    'workflow_summary',
    'tool_result',
    'production_context',
    'artifact',
    'artifact_summary',
    'artifact_source',
    'research_note',
  ].includes(normalizeMemoryClass(memoryClass));
}

function isProjectContinuityMemoryClass(memoryClass = DEFAULT_MEMORY_CLASS) {
  return [
    'project_fact',
    'project_task',
    'workflow_summary',
    'tool_result',
    'production_context',
  ].includes(normalizeMemoryClass(memoryClass));
}

function resolveMemoryNamespace(value = {}, session = null, fallback = '') {
  const source = getPlainObject(value);
  const nested = getPlainObject(source.metadata);
  const clientSurface = resolveClientSurface(source, session, source.sourceSurface || source.source_surface || '');
  const sessionIsolation = resolveSessionIsolation(
    source,
    session,
    clientSurface === 'web-chat',
  );
  const memoryClass = normalizeMemoryClass(
    source.memoryClass
    || source.memory_class
    || nested.memoryClass
    || nested.memory_class
    || fallback,
  );
  const projectKey = resolveProjectKey(source, session);
  const shareAcrossSurfaces = resolveBooleanValue(
    source.shareAcrossSurfaces
    || source.share_across_surfaces
    || nested.shareAcrossSurfaces
    || nested.share_across_surfaces,
  );
  const shouldShareAcrossSurfaces = shareAcrossSurfaces != null
    ? shareAcrossSurfaces
    : defaultShareAcrossSurfaces(memoryClass);

  if (['user_preference', 'collaboration_preference', 'tool_preference', 'reusable_skill'].includes(memoryClass)) {
    return USER_GLOBAL_MEMORY_NAMESPACE;
  }

  if (projectKey && shouldShareAcrossSurfaces && isProjectContinuityMemoryClass(memoryClass)) {
    return PROJECT_SHARED_MEMORY_NAMESPACE;
  }

  if (sessionIsolation || !projectKey) {
    return SESSION_LOCAL_MEMORY_NAMESPACE;
  }

  return shouldShareAcrossSurfaces
    ? PROJECT_SHARED_MEMORY_NAMESPACE
    : SURFACE_LOCAL_MEMORY_NAMESPACE;
}

function buildScopedMemoryMetadata(metadata = {}, session = null) {
  const source = getPlainObject(metadata);
  const clientSurface = resolveClientSurface(source, session, source.sourceSurface || source.source_surface || '');
  const memoryScope = normalizeWebChatWorkspaceScopeKey(firstNormalizedValue([
    source.memoryScope,
    source.memory_scope,
    resolveSessionScope(source, session),
  ]) || DEFAULT_SESSION_SCOPE);
  const projectKey = resolveProjectKey(source, session);
  const memoryClass = normalizeMemoryClass(source.memoryClass || source.memory_class);
  const shareAcrossSurfaces = resolveBooleanValue(source.shareAcrossSurfaces || source.share_across_surfaces);
  const sessionIsolation = resolveSessionIsolation(
    source,
    session,
    clientSurface === 'web-chat',
  );
  const sourceSurface = firstNormalizedValue([
    source.sourceSurface,
    source.source_surface,
    clientSurface,
  ]) || null;

  return {
    ...source,
    ...(clientSurface ? { clientSurface } : {}),
    ...(sourceSurface ? { sourceSurface } : {}),
    memoryScope,
    ...(projectKey ? { projectKey } : {}),
    memoryNamespace: resolveMemoryNamespace({
      ...source,
      clientSurface,
      memoryClass,
      ...(shareAcrossSurfaces != null ? { shareAcrossSurfaces } : {}),
    }, session),
    memoryClass,
    shareAcrossSurfaces: shareAcrossSurfaces != null
      ? shareAcrossSurfaces
      : defaultShareAcrossSurfaces(memoryClass),
    ...(sessionIsolation != null ? { sessionIsolation } : {}),
  };
}

function buildScopedSessionMetadata(metadata = {}, session = null) {
  const source = getPlainObject(metadata);
  const clientSurface = resolveClientSurface(source, session);
  const memoryScope = resolveSessionScope(source, session);
  const sessionIsolation = resolveSessionIsolation(
    source,
    session,
    clientSurface === 'web-chat',
  );
  const projectKey = resolveProjectKey(source, session);

  return {
    ...source,
    ...(clientSurface ? { clientSurface } : {}),
    memoryScope,
    ...(projectKey ? { projectKey } : {}),
    ...(sessionIsolation != null ? { sessionIsolation } : {}),
  };
}

function normalizeSessionScopeKey(scopeKey = '') {
  return normalizeScopeValue(scopeKey) || DEFAULT_SESSION_SCOPE;
}

function normalizeWebChatWorkspaceScopeKey(scopeKey = '') {
  const normalizedScopeKey = normalizeSessionScopeKey(scopeKey);
  const workspaceMatch = normalizedScopeKey.match(/^workspace-(\d+)$/);

  if (!workspaceMatch) {
    return normalizedScopeKey;
  }

  return workspaceMatch[1] === '1'
    ? 'web-chat'
    : `web-chat-workspace-${workspaceMatch[1]}`;
}

function sessionMatchesScope(session = null, scopeKey = DEFAULT_SESSION_SCOPE) {
  if (!session) {
    return false;
  }

  const normalizedScopeKey = normalizeWebChatWorkspaceScopeKey(scopeKey);
  const metadata = getPlainObject(session?.metadata);
  const rawSessionScope = session?.scopeKey || session?.scope_key || '';
  const sessionScope = rawSessionScope
    ? normalizeWebChatWorkspaceScopeKey(rawSessionScope)
    : '';
  const explicitWorkspaceScope = firstNormalizedValue([
    session?.workspaceKey,
    session?.workspace_key,
    metadata.workspaceKey,
    metadata.workspace_key,
    metadata.workspaceId,
    metadata.workspace_id,
  ]);
  const inferredWorkspaceScope = firstNormalizedValue([
    sessionScope,
    metadata.memoryScope,
    metadata.memory_scope,
    metadata.projectScope,
    metadata.project_scope,
  ]);
  const explicitWebChatWorkspaceScope = [
    explicitWorkspaceScope,
    inferredWorkspaceScope,
  ]
    .map((candidate) => normalizeWebChatWorkspaceScopeKey(candidate))
    .find((candidate) => candidate === 'web-chat' || candidate.startsWith('web-chat-workspace-'))
    || null;
  const isWebChatWorkspaceScope = normalizedScopeKey === 'web-chat'
    || normalizedScopeKey.startsWith('web-chat-workspace-');

  if (explicitWebChatWorkspaceScope && isWebChatWorkspaceScope && explicitWebChatWorkspaceScope !== normalizedScopeKey) {
    return false;
  }

  if (
    isWebChatWorkspaceScope
    && !explicitWebChatWorkspaceScope
    && [sessionScope, inferredWorkspaceScope, explicitWorkspaceScope]
      .filter(Boolean)
      .map((candidate) => normalizeWebChatWorkspaceScopeKey(candidate))
      .some((candidate) => [DEFAULT_SESSION_SCOPE, 'global', 'default', 'chat'].includes(candidate))
  ) {
    return false;
  }

  const candidateScopes = new Set([
    sessionScope,
    normalizeWebChatWorkspaceScopeKey(explicitWorkspaceScope),
    explicitWebChatWorkspaceScope,
    resolveSessionScope(metadata, session),
    resolveClientSurface(metadata, session),
    firstNormalizedValue([
      metadata.taskType,
      metadata.task_type,
      metadata.mode,
    ]),
  ].filter(Boolean));

  return candidateScopes.has(normalizedScopeKey);
}

module.exports = {
  DEFAULT_SESSION_SCOPE,
  DEFAULT_MEMORY_CLASS,
  USER_GLOBAL_MEMORY_NAMESPACE,
  PROJECT_SHARED_MEMORY_NAMESPACE,
  SURFACE_LOCAL_MEMORY_NAMESPACE,
  SESSION_LOCAL_MEMORY_NAMESPACE,
  buildScopedMemoryMetadata,
  buildScopedSessionMetadata,
  defaultShareAcrossSurfaces,
  hasSessionScopeHints,
  isSessionIsolationEnabled,
  normalizeMemoryClass,
  normalizeSessionScopeKey,
  normalizeWebChatWorkspaceScopeKey,
  resolveClientSurface,
  resolveMemoryNamespace,
  resolveProjectKey,
  resolveSessionIsolation,
  resolveSessionScope,
  sessionMatchesScope,
};
