const {
  buildScopedMemoryMetadata,
  buildScopedSessionMetadata,
  PROJECT_SHARED_MEMORY_NAMESPACE,
  resolveProjectKey,
  SESSION_LOCAL_MEMORY_NAMESPACE,
  SURFACE_LOCAL_MEMORY_NAMESPACE,
  sessionMatchesScope,
  USER_GLOBAL_MEMORY_NAMESPACE,
} = require('./session-scope');

describe('session scope memory routing', () => {
  test('derives a canonical project key from explicit project metadata', () => {
    expect(resolveProjectKey({
      projectKey: 'Acme Platform',
      clientSurface: 'web-chat',
    })).toBe('acme-platform');
  });

  test('does not treat frontend-only scope labels as project keys', () => {
    expect(resolveProjectKey({
      memoryScope: 'web-chat',
      clientSurface: 'web-chat',
    })).toBe('');
  });

  test('routes web-chat artifact memory into session-local namespace even when a project key exists', () => {
    expect(buildScopedMemoryMetadata({
      ownerId: 'phill',
      memoryScope: 'acme-platform',
      sourceSurface: 'web-chat',
      clientSurface: 'web-chat',
      memoryClass: 'artifact',
      sessionIsolation: false,
    })).toEqual(expect.objectContaining({
      projectKey: 'acme-platform',
      memoryNamespace: SESSION_LOCAL_MEMORY_NAMESPACE,
      shareAcrossSurfaces: true,
      sessionIsolation: true,
    }));
  });

  test('routes conversational memory into surface-local namespace inside a project', () => {
    expect(buildScopedMemoryMetadata({
      ownerId: 'phill',
      memoryScope: 'acme-platform',
      sourceSurface: 'canvas',
      memoryClass: 'conversation',
    })).toEqual(expect.objectContaining({
      projectKey: 'acme-platform',
      memoryNamespace: SURFACE_LOCAL_MEMORY_NAMESPACE,
      shareAcrossSurfaces: false,
    }));
  });

  test('routes parallel web-chat workspaces as durable project-scoped memory', () => {
    expect(buildScopedMemoryMetadata({
      ownerId: 'phill',
      memoryScope: 'web-chat-workspace-3',
      sourceSurface: 'web-chat',
      clientSurface: 'web-chat',
      memoryClass: 'conversation',
      sessionIsolation: false,
    })).toEqual(expect.objectContaining({
      memoryScope: 'web-chat-workspace-3',
      projectKey: 'web-chat-workspace-3',
      memoryNamespace: SESSION_LOCAL_MEMORY_NAMESPACE,
      shareAcrossSurfaces: false,
      sessionIsolation: true,
    }));
  });

  test('forces web-chat isolation even when workspace metadata tries to disable it', () => {
    expect(buildScopedMemoryMetadata({
      ownerId: 'phill',
      memoryScope: 'web-chat-workspace-2',
      sourceSurface: 'web-chat',
      clientSurface: 'web-chat',
      memoryClass: 'conversation',
      sessionIsolation: false,
    })).toEqual(expect.objectContaining({
      memoryNamespace: SESSION_LOCAL_MEMORY_NAMESPACE,
      sessionIsolation: true,
    }));
  });

  test('defaults web-chat memory to session-local isolation', () => {
    expect(buildScopedMemoryMetadata({
      ownerId: 'phill',
      memoryScope: 'web-chat-workspace-3',
      sourceSurface: 'web-chat',
      clientSurface: 'web-chat',
      memoryClass: 'conversation',
    })).toEqual(expect.objectContaining({
      memoryScope: 'web-chat-workspace-3',
      projectKey: 'web-chat-workspace-3',
      memoryNamespace: SESSION_LOCAL_MEMORY_NAMESPACE,
      sessionIsolation: true,
    }));
  });

  test('defaults web-chat session metadata to isolated chat memory', () => {
    expect(buildScopedSessionMetadata({
      clientSurface: 'web-chat',
      memoryScope: 'web-chat-workspace-3',
    })).toEqual(expect.objectContaining({
      memoryScope: 'web-chat-workspace-3',
      sessionIsolation: true,
    }));
  });

  test('normalizes legacy global web-chat session metadata back to the web-chat scope', () => {
    expect(buildScopedSessionMetadata({
      clientSurface: 'web-chat',
      memoryScope: 'global',
    })).toEqual(expect.objectContaining({
      memoryScope: 'web-chat',
      sessionIsolation: true,
    }));
  });

  test('routes memory into session-local namespace when no project key exists', () => {
    expect(buildScopedMemoryMetadata({
      ownerId: 'phill',
      memoryScope: 'web-chat',
      sourceSurface: 'web-chat',
      memoryClass: 'artifact',
    })).toEqual(expect.objectContaining({
      memoryNamespace: SESSION_LOCAL_MEMORY_NAMESPACE,
    }));
  });

  test('routes reusable skills into user-global namespace', () => {
    expect(buildScopedMemoryMetadata({
      ownerId: 'phill',
      memoryScope: 'acme-platform',
      sourceSurface: 'web-chat',
      memoryClass: 'reusable_skill',
    })).toEqual(expect.objectContaining({
      projectKey: 'acme-platform',
      memoryNamespace: USER_GLOBAL_MEMORY_NAMESPACE,
      shareAcrossSurfaces: true,
    }));
  });

  test('keeps legacy parallel web-chat workspace sessions out of workspace one', () => {
    const workspaceTwoSession = {
      id: 'workspace-2-session',
      metadata: {
        clientSurface: 'web-chat',
        memoryScope: 'web-chat-workspace-2',
      },
    };

    expect(sessionMatchesScope(workspaceTwoSession, 'web-chat')).toBe(false);
    expect(sessionMatchesScope(workspaceTwoSession, 'web-chat-workspace-2')).toBe(true);
  });

  test('does not let global sessions masquerade as the web-chat workgroup through clientSurface alone', () => {
    const globalWebChatSession = {
      id: 'global-web-chat-session',
      scopeKey: 'global',
      metadata: {
        clientSurface: 'web-chat',
        memoryScope: 'global',
      },
    };

    expect(sessionMatchesScope(globalWebChatSession, 'web-chat')).toBe(false);
    expect(sessionMatchesScope(globalWebChatSession, 'global')).toBe(true);
  });

  test('maps raw legacy workspace keys to durable web-chat workspace scopes', () => {
    const rawWorkspaceTwoSession = {
      id: 'raw-workspace-2-session',
      metadata: {
        clientSurface: 'web-chat',
        workspaceKey: 'workspace-2',
      },
    };

    expect(sessionMatchesScope(rawWorkspaceTwoSession, 'web-chat')).toBe(false);
    expect(sessionMatchesScope(rawWorkspaceTwoSession, 'web-chat-workspace-2')).toBe(true);
    expect(sessionMatchesScope(rawWorkspaceTwoSession, 'workspace-2')).toBe(true);
  });

  test('canonicalizes raw workspace memory metadata before routing', () => {
    expect(buildScopedMemoryMetadata({
      ownerId: 'phill',
      memoryScope: 'workspace-2',
      sourceSurface: 'web-chat',
      clientSurface: 'web-chat',
      memoryClass: 'conversation',
      sessionIsolation: false,
    })).toEqual(expect.objectContaining({
      memoryScope: 'web-chat-workspace-2',
      projectKey: 'web-chat-workspace-2',
      memoryNamespace: SESSION_LOCAL_MEMORY_NAMESPACE,
      sessionIsolation: true,
    }));
  });

  test('keeps project-scoped sessions visible inside their explicit workspace', () => {
    const projectWorkspaceSession = {
      id: 'project-session',
      metadata: {
        clientSurface: 'web-chat',
        workspaceKey: 'web-chat-workspace-2',
        memoryScope: 'project-alpha',
        projectKey: 'project-alpha',
      },
    };

    expect(sessionMatchesScope(projectWorkspaceSession, 'web-chat')).toBe(false);
    expect(sessionMatchesScope(projectWorkspaceSession, 'web-chat-workspace-2')).toBe(true);
    expect(sessionMatchesScope(projectWorkspaceSession, 'project-alpha')).toBe(true);
  });
});
