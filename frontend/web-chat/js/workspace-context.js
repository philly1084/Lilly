(function initWorkspaceContext(root, factory) {
    const exported = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = exported;
    }
    if (root && typeof root === 'object') {
        root.KimiBuiltWebChatWorkspace = exported;
    }
})(typeof window !== 'undefined' ? window : globalThis, () => {
    const DEFAULT_WORKSPACE_KEY = 'workspace-1';
    const WORKSPACE_QUERY_KEYS = ['workspace', 'workspaceKey', 'workspace_key'];
    const LABEL_QUERY_KEYS = ['workspaceLabel', 'workspace_label'];
    const EMBED_QUERY_KEYS = ['embedded', 'embed'];
    const WORKSPACE_COUNT = 4;
    const WORKSPACE_LOCAL_STORAGE_KEYS = new Set([
        'kimibuilt_web_chat_sessions_v4',
        'kimibuilt_web_chat_current_session',
        'kimibuilt_web_chat_deleted_sessions_v1',
        'kimibuilt_message_draft',
        'kimibuilt_message_draft_time',
    ]);

    function parseWorkspaceKey(value = '') {
        const normalized = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        const workspaceMatch = normalized.match(/^workspace-(\d+)$/);
        if (!workspaceMatch) {
            return null;
        }

        const workspaceNumber = Number(workspaceMatch[1]);
        if (!Number.isInteger(workspaceNumber) || workspaceNumber < 1 || workspaceNumber > WORKSPACE_COUNT) {
            return null;
        }

        return `workspace-${workspaceNumber}`;
    }

    function normalizeWorkspaceKey(value = '') {
        return parseWorkspaceKey(value) || DEFAULT_WORKSPACE_KEY;
    }

    function resolveWorkspaceLabel(workspaceKey = DEFAULT_WORKSPACE_KEY, explicitLabel = '') {
        const normalizedLabel = String(explicitLabel || '').trim();
        if (normalizedLabel) {
            return normalizedLabel;
        }

        const match = String(workspaceKey || '').match(/(\d+)$/);
        const workspaceNumber = match ? Number(match[1]) : 1;
        if (!Number.isFinite(workspaceNumber) || workspaceNumber < 1) {
            return 'Workspace 1';
        }

        return `Workspace ${workspaceNumber}`;
    }

    function resolveWorkspaceScopeKey(workspaceKey = DEFAULT_WORKSPACE_KEY) {
        const normalizedKey = normalizeWorkspaceKey(workspaceKey);
        const match = normalizedKey.match(/^workspace-(\d+)$/);
        if (!match) {
            return normalizedKey;
        }

        return match[1] === '1'
            ? 'web-chat'
            : `web-chat-workspace-${match[1]}`;
    }

    function isWorkspaceLocalStorageKey(storageKey = '') {
        return WORKSPACE_LOCAL_STORAGE_KEYS.has(String(storageKey || '').trim());
    }

    function resolveWorkspaceScopedStorageKey(storageKey = '', workspaceKey = DEFAULT_WORKSPACE_KEY) {
        const normalizedStorageKey = String(storageKey || '').trim();
        if (!normalizedStorageKey || !isWorkspaceLocalStorageKey(normalizedStorageKey)) {
            return normalizedStorageKey;
        }

        const normalizedWorkspaceKey = normalizeWorkspaceKey(workspaceKey);
        if (normalizedWorkspaceKey === DEFAULT_WORKSPACE_KEY) {
            return normalizedStorageKey;
        }

        return `${normalizedStorageKey}:${normalizedWorkspaceKey}`;
    }

    function parseBooleanFlag(value = '') {
        const normalized = String(value || '').trim().toLowerCase();
        return ['1', 'true', 'yes', 'on'].includes(normalized);
    }

    function createWorkspaceContext(input = {}) {
        const rawWorkspaceKey = input.key || input.workspaceKey || DEFAULT_WORKSPACE_KEY;
        const parsedWorkspaceKey = parseWorkspaceKey(rawWorkspaceKey);
        const workspaceKey = parsedWorkspaceKey || DEFAULT_WORKSPACE_KEY;
        const explicitLabel = parsedWorkspaceKey ? (input.label || input.workspaceLabel || '') : '';
        return {
            key: workspaceKey,
            label: resolveWorkspaceLabel(workspaceKey, explicitLabel),
            scopeKey: resolveWorkspaceScopeKey(workspaceKey),
            longTermMemoryEnabled: true,
            persistentMemoryEnabled: true,
            embedded: input.embedded === true,
        };
    }

    function getWorkspaceContext(search = null) {
        const hasExplicitSearch = typeof search === 'string';
        if (!hasExplicitSearch && typeof window !== 'undefined' && window.__kimibuiltWebChatWorkspaceContext) {
            return window.__kimibuiltWebChatWorkspaceContext;
        }

        const params = new URLSearchParams(
            typeof search === 'string'
                ? search.replace(/^\?/, '')
                : (typeof window !== 'undefined' ? window.location.search.replace(/^\?/, '') : ''),
        );
        const workspaceKey = WORKSPACE_QUERY_KEYS
            .map((key) => params.get(key))
            .find((value) => typeof value === 'string' && value.trim());
        const workspaceLabel = LABEL_QUERY_KEYS
            .map((key) => params.get(key))
            .find((value) => typeof value === 'string' && value.trim());
        const embedded = EMBED_QUERY_KEYS.some((key) => parseBooleanFlag(params.get(key)));
        const context = createWorkspaceContext({
            key: workspaceKey,
            label: workspaceLabel,
            embedded,
        });

        if (!hasExplicitSearch && typeof window !== 'undefined') {
            window.__kimibuiltWebChatWorkspaceContext = context;
        }

        return context;
    }

    function buildWorkspaceScopeMetadata(metadata = {}, workspaceContext = getWorkspaceContext()) {
        const context = workspaceContext && typeof workspaceContext === 'object'
            ? workspaceContext
            : createWorkspaceContext();

        return {
            ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
            workspaceKey: context.scopeKey,
            workspaceId: context.scopeKey,
            projectScope: context.scopeKey,
            memoryScope: context.scopeKey,
            sessionIsolation: true,
        };
    }

    function listWorkspaceContexts() {
        return Array.from({ length: WORKSPACE_COUNT }, (_value, index) => {
            const workspaceKey = `workspace-${index + 1}`;
            return createWorkspaceContext({ key: workspaceKey });
        });
    }

    return {
        DEFAULT_WORKSPACE_KEY,
        WORKSPACE_COUNT,
        buildWorkspaceScopeMetadata,
        createWorkspaceContext,
        getWorkspaceContext,
        isWorkspaceLocalStorageKey,
        listWorkspaceContexts,
        normalizeWorkspaceKey,
        resolveWorkspaceLabel,
        resolveWorkspaceScopeKey,
        resolveWorkspaceScopedStorageKey,
    };
});
