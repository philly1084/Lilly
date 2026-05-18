const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createStorage() {
    const values = new Map();
    return {
        getItem: jest.fn((key) => values.get(key) ?? null),
        setItem: jest.fn((key, value) => {
            values.set(key, String(value));
        }),
        removeItem: jest.fn((key) => {
            values.delete(key);
        }),
    };
}

function createCustomEventClass() {
    return class CustomEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            this.detail = options.detail;
        }
    };
}

function createSessionManager(fetchMock) {
    const source = fs.readFileSync(path.join(__dirname, 'session.js'), 'utf8');
    const context = {
        console,
        Date,
        Event,
        EventTarget,
        CustomEvent: createCustomEventClass(),
        URLSearchParams,
        setTimeout,
        clearTimeout,
        fetch: fetchMock,
        localStorage: createStorage(),
        window: {
            location: {
                hostname: 'localhost',
                protocol: 'http:',
                host: 'localhost:3000',
            },
            KimiBuiltGatewaySSE: {
                DEFAULT_CODEX_MODEL_ID: 'auto',
                buildGatewayHeaders: (headers = {}) => headers,
            },
            KimiBuiltWebChatWorkspace: {
                getWorkspaceContext: () => ({
                    key: 'workspace-1',
                    label: 'Workspace 1',
                    scopeKey: 'web-chat',
                    embedded: false,
                }),
                buildWorkspaceScopeMetadata: (metadata = {}) => ({
                    ...metadata,
                    workspaceKey: 'workspace-1',
                    memoryScope: 'web-chat',
                }),
                resolveWorkspaceScopedStorageKey: (storageKey = '') => storageKey,
            },
        },
    };
    context.window.window = context.window;
    context.window.localStorage = context.localStorage;
    context.window.fetch = fetchMock;

    vm.runInNewContext(source, context, { filename: 'session.js' });
    return context.window.sessionManager;
}

function createSessionsResponse(activeSessionId = 'session-a') {
    return {
        ok: true,
        json: async () => ({
            activeSessionId,
            sessions: [
                {
                    id: 'session-a',
                    title: 'Backend active',
                    createdAt: '2026-05-11T10:00:00.000Z',
                    updatedAt: '2026-05-11T10:00:00.000Z',
                    metadata: { mode: 'chat', memoryScope: 'web-chat' },
                    scopeKey: 'web-chat',
                },
                {
                    id: 'session-b',
                    title: 'Clicked chat',
                    createdAt: '2026-05-11T10:01:00.000Z',
                    updatedAt: '2026-05-11T10:01:00.000Z',
                    metadata: { mode: 'chat', memoryScope: 'web-chat' },
                    scopeKey: 'web-chat',
                },
            ],
        }),
    };
}

describe('web-chat session switching refresh guards', () => {
    test('syncs opted-in helper cards for refresh while keeping default helper cards local', () => {
        const manager = createSessionManager(jest.fn());

        expect(manager.shouldSyncMessageToBackend({
            id: 'assistant-1-image-artifacts',
            role: 'assistant',
            type: 'image-selection',
            content: 'Generated image options',
            clientOnly: true,
            excludeFromTranscript: true,
        })).toBe(false);

        expect(manager.shouldSyncMessageToBackend({
            id: 'assistant-1-research-sources',
            role: 'assistant',
            type: 'research-sources',
            content: 'Verified source excerpts',
            clientOnly: true,
            metadata: {
                excludeFromTranscript: true,
                syncExcludedToBackend: true,
            },
        })).toBe(true);
    });

    test('preserves the visible chat during a background sessions refresh', async () => {
        const fetchMock = jest.fn(async (url) => {
            const href = String(url);
            if (href.includes('/preferences/web-chat')) {
                return { ok: true, json: async () => ({ preferences: {} }) };
            }
            if (href.includes('/sessions?')) {
                return createSessionsResponse('session-a');
            }
            return { ok: true, json: async () => ({}) };
        });
        const manager = createSessionManager(fetchMock);

        manager.sessions = [
            { id: 'session-a', mode: 'chat', title: 'Backend active', updatedAt: '2026-05-11T10:00:00.000Z' },
            { id: 'session-b', mode: 'chat', title: 'Clicked chat', updatedAt: '2026-05-11T10:01:00.000Z' },
        ];
        manager.sessionMessages.set('session-a', []);
        manager.sessionMessages.set('session-b', []);
        manager.switchSession('session-b');

        await manager.loadSessions({ preserveCurrentSession: true });

        expect(manager.currentSessionId).toBe('session-b');
    });

    test('still accepts backend active session on ordinary load after the local hold expires', async () => {
        const fetchMock = jest.fn(async (url) => {
            const href = String(url);
            if (href.includes('/preferences/web-chat')) {
                return { ok: true, json: async () => ({ preferences: {} }) };
            }
            if (href.includes('/sessions?')) {
                return createSessionsResponse('session-a');
            }
            return { ok: true, json: async () => ({}) };
        });
        const manager = createSessionManager(fetchMock);

        manager.sessions = [
            { id: 'session-a', mode: 'chat', title: 'Backend active', updatedAt: '2026-05-11T10:00:00.000Z' },
            { id: 'session-b', mode: 'chat', title: 'Clicked chat', updatedAt: '2026-05-11T10:01:00.000Z' },
        ];
        manager.currentSessionId = 'session-b';
        manager.activeSessionSelection = {
            sessionId: 'session-b',
            selectedAt: 0,
            reason: 'expired-test',
        };

        await manager.loadSessions();

        expect(manager.currentSessionId).toBe('session-a');
    });

    test('settles stale persisted foreground placeholders instead of resuming them forever', () => {
        const manager = createSessionManager(jest.fn());
        const oldTimestamp = new Date(Date.now() - (7 * 60 * 60 * 1000)).toISOString();

        const messages = manager.mergeBackendMessages('session-a', [
            {
                id: 'assistant-stale',
                role: 'assistant',
                content: 'Working in background...',
                timestamp: oldTimestamp,
                isStreaming: true,
                metadata: {
                    pendingForeground: true,
                    foregroundRequestId: 'assistant-stale',
                },
            },
        ]);

        expect(messages).toHaveLength(1);
        expect(messages[0].isStreaming).toBe(false);
        expect(messages[0].metadata.pendingForeground).toBe(false);
        expect(messages[0].metadata.foregroundRequestId).toBeUndefined();
        expect(messages[0].metadata.staleForeground).toBe(true);
        expect(messages[0].content).toContain('did not finish cleanly');
    });
});
