const { SessionStore } = require('./session-store');
const { postgres } = require('./postgres');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

describe('SessionStore recent message continuity', () => {
    test('does not inject a default business agent into new sessions', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        const session = await store.create({ mode: 'chat' });

        expect(session.metadata.agent).toBeUndefined();
    });

    test('defaults newly created sessions to durable memory routing', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        const session = await store.create({ mode: 'chat' });

        expect(session.metadata.sessionIsolation).toBe(false);
    });

    test('appends and trims recent session messages', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        const session = await store.create({ mode: 'chat' });

        await store.appendMessages(session.id, [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'second' },
        ]);

        const updated = await store.get(session.id);
        await expect(store.getRecentMessages(updated)).resolves.toEqual([
            expect.objectContaining({ role: 'user', content: 'first' }),
            expect.objectContaining({ role: 'assistant', content: 'second' }),
        ]);
    });

    test('strips null bytes from recent messages before persistence', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        const session = await store.create({ mode: 'chat' });

        await store.appendMessages(session.id, [
            { role: 'assistant', content: 'Hello\u0000 world' },
        ]);

        const updated = await store.get(session.id);
        await expect(store.getRecentMessages(updated)).resolves.toEqual([
            expect.objectContaining({ role: 'assistant', content: 'Hello world' }),
        ]);
    });

    test('getOrCreateOwned persists owner metadata for new sessions', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;

        const session = await store.getOrCreateOwned('session-owned', { mode: 'chat' }, 'phill');

        expect(session.id).toBe('session-owned');
        expect(session.metadata.ownerId).toBe('phill');
        expect(session.metadata.ownerType).toBe('user');
    });

    test('getOwned claims an unowned legacy session for the requesting owner', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        await store.create({ mode: 'chat' }, 'legacy-session');

        const session = await store.getOwned('legacy-session', 'phill');

        expect(session.metadata.ownerId).toBe('phill');
        expect((await store.get('legacy-session')).metadata.ownerId).toBe('phill');
    });

    test('getOrCreateOwned does not overwrite an existing session owned by another user', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        await store.create({ mode: 'chat', ownerId: 'other-user' }, 'shared-session');

        const session = await store.getOrCreateOwned('shared-session', { mode: 'chat' }, 'phill');

        expect(session).toBeNull();
        await expect(store.get('shared-session')).resolves.toEqual(expect.objectContaining({
            id: 'shared-session',
            metadata: expect.objectContaining({
                ownerId: 'other-user',
            }),
        }));
    });

    test('list filters sessions by owner while preserving visible legacy sessions', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;

        await store.create({ mode: 'chat', ownerId: 'phill' }, 'owned-a');
        await store.create({ mode: 'chat', ownerId: 'other-user' }, 'owned-b');
        await store.create({ mode: 'chat' }, 'legacy');

        const sessions = await store.list({ ownerId: 'phill' });
        const ids = sessions.map((session) => session.id);

        expect(ids).toEqual(expect.arrayContaining(['owned-a', 'legacy']));
        expect(ids).not.toContain('owned-b');
    });

    test('tracks active owned sessions independently per scope', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;

        await store.create({ mode: 'chat', clientSurface: 'web-chat', ownerId: 'phill' }, 'web-chat-session');
        await store.create({ mode: 'notes', clientSurface: 'notes', ownerId: 'phill' }, 'notes-session');

        await store.setActiveSession('phill', 'web-chat-session', 'web-chat');
        await store.setActiveSession('phill', 'notes-session', 'notes');

        await expect(store.getActiveOwnedSession('phill', 'web-chat')).resolves.toEqual(expect.objectContaining({
            id: 'web-chat-session',
        }));
        await expect(store.getActiveOwnedSession('phill', 'notes')).resolves.toEqual(expect.objectContaining({
            id: 'notes-session',
        }));
        await expect(store.getUserSessionState('phill')).resolves.toEqual(expect.objectContaining({
            scopedActiveSessionIds: expect.objectContaining({
                'web-chat': 'web-chat-session',
                notes: 'notes-session',
            }),
        }));
    });

    test('patchUserPreferences stores a namespaced web-chat preference map', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;

        await store.patchUserPreferences('phill', 'webChat', {
            kimibuilt_default_model: 'gpt-5.4-mini',
            kimibuilt_theme_preset: 'obsidian',
        });

        await expect(store.getUserSessionState('phill')).resolves.toEqual(expect.objectContaining({
            preferences: expect.objectContaining({
                webChat: {
                    kimibuilt_default_model: 'gpt-5.4-mini',
                    kimibuilt_theme_preset: 'obsidian',
                },
            }),
        }));
        await expect(store.getUserPreferences('phill', 'webChat')).resolves.toEqual({
            kimibuilt_default_model: 'gpt-5.4-mini',
            kimibuilt_theme_preset: 'obsidian',
        });
    });

    test('patchUserPreferences removes keys when the patch value is null', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;

        await store.patchUserPreferences('phill', 'webChat', {
            kimibuilt_default_model: 'gpt-5.4-mini',
            kimibuilt_reasoning_effort: 'high',
        });
        await store.patchUserPreferences('phill', 'webChat', {
            kimibuilt_reasoning_effort: null,
        });

        await expect(store.getUserPreferences('phill', 'webChat')).resolves.toEqual({
            kimibuilt_default_model: 'gpt-5.4-mini',
        });
    });

    test('resolveOwnedSession does not reuse an active session from another scope', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;

        await store.create({ mode: 'notes', clientSurface: 'notes', ownerId: 'phill' }, 'notes-session');
        await store.setActiveSession('phill', 'notes-session', 'notes');

        const resolved = await store.resolveOwnedSession(null, {
            mode: 'chat',
            clientSurface: 'web-chat',
        }, 'phill');

        expect(resolved.id).not.toBe('notes-session');
        expect(resolved.metadata.memoryScope).toBe('web-chat');
    });

    test('resolveOwnedSession ignores a stale web-chat session id from another workspace', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;

        await store.create({
            mode: 'chat',
            clientSurface: 'web-chat',
            workspaceKey: 'workspace-1',
            ownerId: 'phill',
        }, 'workspace-1-session');

        const resolved = await store.resolveOwnedSession('workspace-1-session', {
            mode: 'chat',
            taskType: 'chat',
            clientSurface: 'web-chat',
            workspaceKey: 'workspace-2',
            memoryScope: 'workspace-2',
        }, 'phill');

        expect(resolved.id).not.toBe('workspace-1-session');
        expect(resolved.scopeKey).toBe('web-chat-workspace-2');
        expect(resolved.metadata.memoryScope).toBe('web-chat-workspace-2');
    });

    test('setActiveSession refuses to pin another workspace as active', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;

        await store.create({
            mode: 'chat',
            clientSurface: 'web-chat',
            workspaceKey: 'workspace-1',
            ownerId: 'phill',
        }, 'workspace-1-session');

        await expect(store.setActiveSession(
            'phill',
            'workspace-1-session',
            'web-chat-workspace-2',
        )).resolves.toBeNull();
        await expect(store.getActiveOwnedSession('phill', 'web-chat-workspace-2')).resolves.toBeNull();
    });

    test('list filters sessions by scope key', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;

        await store.create({ mode: 'chat', clientSurface: 'web-chat', ownerId: 'phill' }, 'web-chat-session');
        await store.create({ mode: 'chat', clientSurface: 'cli', ownerId: 'phill' }, 'cli-session');

        const sessions = await store.list({
            ownerId: 'phill',
            scopeKey: 'web-chat',
        });

        expect(sessions.map((session) => session.id)).toEqual(['web-chat-session']);
    });

    test('list pushes owner and scope filters into Postgres', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = true;
        const querySpy = jest.spyOn(postgres, 'query').mockResolvedValue({
            rows: [
                {
                    id: 'web-chat-session',
                    previous_response_id: null,
                    created_at: new Date('2026-05-10T10:00:00.000Z'),
                    updated_at: new Date('2026-05-10T10:01:00.000Z'),
                    message_count: 0,
                    metadata: { ownerId: 'phill', clientSurface: 'web-chat' },
                    scope_key: 'web-chat',
                    control_state: {},
                },
            ],
        });

        try {
            const sessions = await store.list({
                ownerId: 'phill',
                scopeKey: 'web-chat',
            });

            expect(sessions.map((session) => session.id)).toEqual(['web-chat-session']);
            expect(querySpy).toHaveBeenCalledWith(
                expect.stringContaining('sessions.scope_key = $2'),
                ['phill', 'web-chat'],
            );
        } finally {
            querySpy.mockRestore();
        }
    });

    test('list keeps web-chat sessions visible when metadata scope expands beyond the surface', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;

        await store.create({ mode: 'chat', clientSurface: 'web-chat', ownerId: 'phill' }, 'web-chat-session');
        await store.update('web-chat-session', {
            metadata: {
                memoryScope: 'project-alpha',
                projectKey: 'project-alpha',
            },
        });

        const sessions = await store.list({
            ownerId: 'phill',
            scopeKey: 'web-chat',
        });

        expect(sessions.map((session) => session.id)).toEqual(['web-chat-session']);
    });

    test('list keeps parallel web-chat workspaces in their own scopes', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;

        await store.create({
            mode: 'chat',
            clientSurface: 'web-chat',
            workspaceKey: 'web-chat',
            ownerId: 'phill',
        }, 'workspace-1-session');
        await store.create({
            mode: 'chat',
            clientSurface: 'web-chat',
            workspaceKey: 'web-chat-workspace-2',
            ownerId: 'phill',
        }, 'workspace-2-session');

        await expect(store.list({
            ownerId: 'phill',
            scopeKey: 'web-chat',
        })).resolves.toEqual([
            expect.objectContaining({ id: 'workspace-1-session' }),
        ]);
        await expect(store.list({
            ownerId: 'phill',
            scopeKey: 'web-chat-workspace-2',
        })).resolves.toEqual([
            expect.objectContaining({ id: 'workspace-2-session' }),
        ]);
    });

    test('list still allows project scope lookup inside a web-chat workspace', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;

        await store.create({
            mode: 'chat',
            clientSurface: 'web-chat',
            workspaceKey: 'web-chat-workspace-2',
            projectKey: 'project-alpha',
            memoryScope: 'project-alpha',
            ownerId: 'phill',
        }, 'workspace-project-session');

        await expect(store.list({
            ownerId: 'phill',
            scopeKey: 'project-alpha',
        })).resolves.toEqual([
            expect.objectContaining({ id: 'workspace-project-session' }),
        ]);
    });

    test('listMessages returns the full persisted transcript, not just the recent continuity window', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        const session = await store.create({ mode: 'chat' });

        const transcript = Array.from({ length: 30 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `message-${index + 1}`,
            timestamp: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString(),
        }));

        await store.appendMessages(session.id, transcript);

        const listed = await store.listMessages(session.id, 100);
        const recent = await store.getRecentMessages(session.id);

        expect(listed).toHaveLength(30);
        expect(listed[0]).toEqual(expect.objectContaining({ content: 'message-1' }));
        expect(listed[29]).toEqual(expect.objectContaining({ content: 'message-30' }));
        expect(recent).toHaveLength(8);
        expect(recent[0]).toEqual(expect.objectContaining({ content: 'message-23' }));
    });

    test('getRecentMessages skips transcript content already covered by session compaction', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        const session = await store.create({ mode: 'chat' });

        const transcript = Array.from({ length: 10 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `message-${index + 1}`,
            timestamp: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString(),
        }));

        await store.appendMessages(session.id, transcript);
        await store.update(session.id, {
            metadata: {
                sessionCompaction: {
                    compactedMessageCount: 6,
                    summary: 'Compacted through 6 transcript messages in this session.',
                },
            },
        });

        const recent = await store.getRecentMessages(session.id, 10);
        expect(recent.map((entry) => entry.content)).toEqual([
            'message-7',
            'message-8',
            'message-9',
            'message-10',
        ]);
    });

    test('maybeCompactSession stores a summary and rewrites recent continuity at completion points', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        const session = await store.create({ mode: 'chat' });

        const transcript = Array.from({ length: 12 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `message-${index + 1} about the deployment workflow`,
            timestamp: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString(),
        }));

        await store.appendMessages(session.id, transcript);
        const updated = await store.maybeCompactSession(session.id, {
            workflow: {
                status: 'completed',
                lane: 'deploy',
                stage: 'verified',
            },
            projectMemory: {
                tasks: [{
                    summary: 'Waiting on DNS propagation for the ingress hostname.',
                    status: 'partial',
                }],
            },
        });

        expect(updated.metadata.sessionCompaction).toEqual(expect.objectContaining({
            compactedMessageCount: 4,
            trigger: 'workflow-completed',
        }));
        expect(updated.metadata.sessionCompaction.summary).toContain('Waiting on DNS propagation');
        expect(updated.metadata.recentMessages.map((entry) => entry.content)).toEqual([
            'message-5 about the deployment workflow',
            'message-6 about the deployment workflow',
            'message-7 about the deployment workflow',
            'message-8 about the deployment workflow',
            'message-9 about the deployment workflow',
            'message-10 about the deployment workflow',
            'message-11 about the deployment workflow',
            'message-12 about the deployment workflow',
        ]);
    });

    test('maybeCompactSession compacts oversized transcripts while retaining eight recent messages', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        const session = await store.create({ mode: 'chat' });
        const largeSegment = 'Detailed project context '.repeat(420);
        const transcript = Array.from({ length: 10 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `message-${index + 1} ${largeSegment}`,
            timestamp: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString(),
        }));

        await store.appendMessages(session.id, transcript);
        const updated = await store.maybeCompactSession(session.id);

        expect(updated.metadata.sessionCompaction).toEqual(expect.objectContaining({
            compactedMessageCount: 2,
            trigger: 'transcript-growth',
        }));
        expect(updated.metadata.recentMessages).toHaveLength(8);
        expect(updated.metadata.recentMessages[0]).toEqual(expect.objectContaining({
            content: expect.stringContaining('message-3'),
        }));
    });

    test('preserves long html content in transcript persistence and recent agent continuity', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        const session = await store.create({ mode: 'chat' });
        const html = `<html><body>${'A'.repeat(6000)}</body></html>`;

        await store.appendMessages(session.id, [
            { role: 'assistant', content: html },
        ]);

        const listed = await store.listMessages(session.id, 10);
        const recent = await store.getRecentMessages(session.id, 10);

        expect(listed[0].content).toBe(html);
        expect(recent[0].content).toBe(html);
        expect(recent[0].content).not.toContain('[truncated');
    });

    test('persists fallback sessions and messages to disk across store instances', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-session-store-'));
        const storagePath = path.join(tempDir, 'sessions.json');

        try {
            const store = new SessionStore();
            store.initialized = true;
            store.usePostgres = false;
            store.fallbackStoragePath = storagePath;
            store.fallbackLoaded = true;

            const session = await store.create({ mode: 'chat' }, 'persisted-session');
            await store.appendMessages(session.id, [
                { role: 'user', content: 'Build me a page' },
                { role: 'assistant', content: '<!DOCTYPE html><html><body>Saved</body></html>' },
            ]);
            await store.recordResponse(session.id, 'resp_123');

            const reloaded = new SessionStore();
            reloaded.fallbackStoragePath = storagePath;
            await reloaded.initialize();

            const loadedSession = await reloaded.get('persisted-session');
            const loadedMessages = await reloaded.listMessages('persisted-session', 10);

            expect(loadedSession).toEqual(expect.objectContaining({
                id: 'persisted-session',
                previousResponseId: 'resp_123',
            }));
            expect(loadedMessages).toHaveLength(2);
            expect(loadedMessages[1]).toEqual(expect.objectContaining({
                content: '<!DOCTYPE html><html><body>Saved</body></html>',
            }));
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('recordResponse persists prompt-state metadata alongside the previous response id', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        const session = await store.create({ mode: 'chat' }, 'prompt-state-session');

        await store.recordResponse(session.id, 'resp_prompt_123', {
            promptState: {
                instructionsFingerprint: 'fingerprint-123',
            },
        });

        const updated = await store.get(session.id);
        expect(updated).toEqual(expect.objectContaining({
            previousResponseId: 'resp_prompt_123',
            metadata: expect.objectContaining({
                promptState: {
                    instructionsFingerprint: 'fingerprint-123',
                },
            }),
        }));
    });

    test('keeps ui-only rich messages in session history while excluding them from recent transcript continuity', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        const session = await store.create({ mode: 'chat' }, 'rich-message-session');

        await store.appendMessages(session.id, [
            { role: 'user', content: 'Build me a report' },
            { role: 'assistant', content: 'Created the report.' },
            {
                id: 'artifact-card-1',
                role: 'assistant',
                type: 'artifact-gallery',
                content: 'Created report.pdf. Use Download below.',
                artifacts: [{ id: 'artifact-1', filename: 'report.pdf', format: 'pdf' }],
                excludeFromTranscript: true,
            },
        ]);

        const listed = await store.listMessages(session.id, 10);
        const recent = await store.getRecentMessages(session.id, 10);

        expect(listed).toHaveLength(3);
        expect(listed[2]).toEqual(expect.objectContaining({
            id: 'artifact-card-1',
            type: 'artifact-gallery',
            artifacts: [{ id: 'artifact-1', filename: 'report.pdf', format: 'pdf' }],
            excludeFromTranscript: true,
        }));
        expect(recent).toEqual([
            expect.objectContaining({ role: 'user', content: 'Build me a report' }),
            expect.objectContaining({ role: 'assistant', content: 'Created the report.' }),
        ]);
    });

    test('persists fallback active session state across store instances', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-session-state-'));
        const storagePath = path.join(tempDir, 'sessions.json');

        try {
            const store = new SessionStore();
            store.initialized = true;
            store.usePostgres = false;
            store.fallbackStoragePath = storagePath;
            store.fallbackLoaded = true;

            await store.create({ mode: 'chat', ownerId: 'phill' }, 'session-a');
            await store.create({ mode: 'chat', ownerId: 'phill' }, 'session-b');
            await store.setActiveSession('phill', 'session-b');

            const reloaded = new SessionStore();
            reloaded.fallbackStoragePath = storagePath;
            await reloaded.initialize();

            await expect(reloaded.getUserSessionState('phill')).resolves.toEqual(expect.objectContaining({
                ownerId: 'phill',
                activeSessionId: 'session-b',
            }));
            await expect(reloaded.resolveOwnedSession(null, { mode: 'chat' }, 'phill')).resolves.toEqual(expect.objectContaining({
                id: 'session-b',
            }));
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('persists fallback user preferences across store instances', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-user-preferences-'));
        const storagePath = path.join(tempDir, 'sessions.json');

        try {
            const store = new SessionStore();
            store.initialized = true;
            store.usePostgres = false;
            store.fallbackStoragePath = storagePath;
            store.fallbackLoaded = true;

            await store.patchUserPreferences('phill', 'webChat', {
                kimibuilt_default_model: 'gpt-5.4',
                kimibuilt_theme_preset: 'paper',
            });

            const reloaded = new SessionStore();
            reloaded.fallbackStoragePath = storagePath;
            await reloaded.initialize();

            await expect(reloaded.getUserPreferences('phill', 'webChat')).resolves.toEqual({
                kimibuilt_default_model: 'gpt-5.4',
                kimibuilt_theme_preset: 'paper',
            });
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('serializes concurrent fallback writes without losing the sessions file', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-session-race-'));
        const storagePath = path.join(tempDir, 'sessions.json');

        try {
            const store = new SessionStore();
            store.initialized = true;
            store.usePostgres = false;
            store.fallbackStoragePath = storagePath;
            store.fallbackLoaded = true;

            await store.create({ mode: 'chat', ownerId: 'phill' }, 'session-a');
            await store.create({ mode: 'chat', ownerId: 'phill' }, 'session-b');

            await Promise.all([
                store.setActiveSession('phill', 'session-a'),
                store.setActiveSession('phill', 'session-b'),
                store.appendMessages('session-a', [
                    { role: 'user', content: 'hello' },
                ]),
                store.updateControlState('session-a', {
                    lastToolIntent: 'remote-command',
                }),
            ]);

            const persisted = JSON.parse(await fs.readFile(storagePath, 'utf8'));
            expect(Array.isArray(persisted.sessions)).toBe(true);
            expect(persisted.sessions.map((session) => session.id)).toEqual(expect.arrayContaining([
                'session-a',
                'session-b',
            ]));
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('stores runtime control state separately while mirroring legacy metadata fields', async () => {
        const store = new SessionStore();
        store.initialized = true;
        store.usePostgres = false;
        const session = await store.create({ mode: 'chat' }, 'runtime-control');

        await store.updateControlState(session.id, {
            lastToolIntent: 'remote-command',
            lastSshTarget: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            },
            remoteWorkingState: {
                lastCommand: 'uptime',
                lastCommandSucceeded: true,
            },
            workflow: {
                type: 'remote-health-report',
                status: 'completed',
            },
            projectPlan: {
                kind: 'foreground-project-plan',
                status: 'active',
                title: 'Polish the app',
                objective: 'Polish the app',
                milestones: [{
                    id: 'm1',
                    title: 'Inspect the current state',
                    status: 'in_progress',
                }],
            },
            autonomyApproved: true,
        });

        const updated = await store.get(session.id);

        expect(updated.controlState).toEqual(expect.objectContaining({
            lastToolIntent: 'remote-command',
            lastSshTarget: expect.objectContaining({
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
            }),
            remoteWorkingState: expect.objectContaining({
                lastCommand: 'uptime',
                lastCommandSucceeded: true,
            }),
            workflow: expect.objectContaining({
                type: 'remote-health-report',
                status: 'completed',
            }),
            projectPlan: expect.objectContaining({
                kind: 'foreground-project-plan',
                status: 'active',
            }),
            autonomyApproved: true,
        }));
        expect(updated.metadata).toEqual(expect.objectContaining({
            lastToolIntent: 'remote-command',
            lastSshTarget: expect.objectContaining({
                host: '10.0.0.5',
            }),
            remoteWorkingState: expect.objectContaining({
                lastCommand: 'uptime',
            }),
                controlState: expect.objectContaining({
                    workflow: expect.objectContaining({
                        type: 'remote-health-report',
                    }),
                    projectPlan: expect.objectContaining({
                        kind: 'foreground-project-plan',
                    }),
                }),
            }));
    });
});
