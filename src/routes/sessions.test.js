'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../session-store', () => ({
    sessionStore: {
        create: jest.fn(),
        list: jest.fn(),
        getOwned: jest.fn(),
        getActiveOwnedSession: jest.fn(),
        getLatestOwnedSession: jest.fn(),
        isPersistent: jest.fn(),
        setActiveSession: jest.fn(),
        listMessages: jest.fn(),
        update: jest.fn(),
        updateControlState: jest.fn(),
        upsertMessage: jest.fn(),
        delete: jest.fn(),
        get: jest.fn(),
    },
}));

jest.mock('../memory/memory-service', () => ({
    memoryService: {
        forget: jest.fn(),
    },
}));

jest.mock('../artifacts/artifact-service', () => ({
    artifactService: {
        listSessionArtifacts: jest.fn(),
        deleteArtifactsForSession: jest.fn(),
    },
}));

jest.mock('../foreground-request-registry', () => ({
    abortForegroundRequest: jest.fn(),
}));

jest.mock('../foreground-turn-state', () => ({
    cancelForegroundTurn: jest.fn(),
    resolveForegroundTurn: jest.fn(),
}));

const { sessionStore } = require('../session-store');
const { artifactService } = require('../artifacts/artifact-service');
const { memoryService } = require('../memory/memory-service');
const { abortForegroundRequest } = require('../foreground-request-registry');
const { cancelForegroundTurn, resolveForegroundTurn } = require('../foreground-turn-state');
const sessionsRouter = require('./sessions');

describe('/api/sessions route', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sessionStore.isPersistent.mockReturnValue(true);
        abortForegroundRequest.mockReturnValue({
            cancelled: false,
            active: false,
            reason: 'not_found',
        });
        resolveForegroundTurn.mockReturnValue(null);
        cancelForegroundTurn.mockResolvedValue(null);
    });

    test('enriches session list responses with workload summaries', async () => {
        sessionStore.list.mockResolvedValue([
            {
                id: 'session-1',
                metadata: { mode: 'chat' },
                createdAt: '2026-04-01T09:00:00.000Z',
                updatedAt: '2026-04-01T09:05:00.000Z',
            },
        ]);
        sessionStore.getActiveOwnedSession.mockResolvedValue({
            id: 'session-1',
        });

        const app = express();
        app.locals.agentWorkloadService = {
            isAvailable: jest.fn(() => true),
            getSessionSummaries: jest.fn(async () => ({
                'session-1': {
                    queued: 2,
                    running: 1,
                    failed: 0,
                },
            })),
        };
        app.use('/api/sessions', sessionsRouter);

        const response = await request(app).get('/api/sessions');

        expect(response.status).toBe(200);
        expect(response.body.sessions).toEqual([
            expect.objectContaining({
                id: 'session-1',
                workloadSummary: {
                    queued: 2,
                    running: 1,
                    failed: 0,
                },
            }),
        ]);
        expect(response.body.activeSessionId).toBe('session-1');
    });

    test('persists active session selection for the authenticated user', async () => {
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        sessionStore.setActiveSession.mockResolvedValue({
            ownerId: 'phill',
            activeSessionId: 'session-1',
        });
        sessionStore.getActiveOwnedSession.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/sessions', sessionsRouter);

        const response = await request(app)
            .put('/api/sessions/state')
            .send({ activeSessionId: 'session-1' });

        expect(response.status).toBe(200);
        expect(sessionStore.getOwned).toHaveBeenCalledWith('session-1', 'phill');
        expect(sessionStore.setActiveSession).toHaveBeenCalledWith('phill', 'session-1', null);
        expect(sessionStore.getActiveOwnedSession).toHaveBeenCalledWith('phill', null);
        expect(response.body.activeSessionId).toBe('session-1');
    });

    test('filters session state by requested client surface', async () => {
        sessionStore.list.mockResolvedValue([]);
        sessionStore.getActiveOwnedSession.mockResolvedValue(null);

        const app = express();
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/sessions', sessionsRouter);

        const response = await request(app).get('/api/sessions?clientSurface=web-chat&taskType=chat');

        expect(response.status).toBe(200);
        expect(sessionStore.list).toHaveBeenCalledWith({
            ownerId: 'phill',
            scopeKey: 'web-chat',
        });
        expect(sessionStore.getActiveOwnedSession).toHaveBeenCalledWith('phill', 'web-chat');
    });

    test('persists scoped active session state for the authenticated user', async () => {
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill', memoryScope: 'web-chat' },
        });
        sessionStore.setActiveSession.mockResolvedValue({
            ownerId: 'phill',
            activeSessionId: 'session-1',
        });
        sessionStore.getActiveOwnedSession.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill', memoryScope: 'web-chat' },
        });

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/sessions', sessionsRouter);

        const response = await request(app)
            .put('/api/sessions/state')
            .send({ activeSessionId: 'session-1', clientSurface: 'web-chat', taskType: 'chat' });

        expect(response.status).toBe(200);
        expect(sessionStore.setActiveSession).toHaveBeenCalledWith('phill', 'session-1', 'web-chat');
        expect(sessionStore.getActiveOwnedSession).toHaveBeenCalledWith('phill', 'web-chat');
    });

    test('patch persists renamed conversation titles in session metadata', async () => {
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: {
                ownerId: 'phill',
                clientSurface: 'web-chat',
                memoryScope: 'web-chat',
                mode: 'chat',
            },
        });
        sessionStore.update.mockResolvedValue({
            id: 'session-1',
            updatedAt: '2026-04-11T12:00:00.000Z',
            metadata: {
                ownerId: 'phill',
                clientSurface: 'web-chat',
                memoryScope: 'web-chat',
                mode: 'chat',
                title: 'Release Checklist',
            },
        });

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/sessions', sessionsRouter);

        const response = await request(app)
            .patch('/api/sessions/session-1')
            .send({
                metadata: {
                    title: 'Release Checklist',
                },
            });

        expect(response.status).toBe(200);
        expect(sessionStore.getOwned).toHaveBeenCalledWith('session-1', 'phill');
        expect(sessionStore.update).toHaveBeenCalledWith('session-1', {
            metadata: expect.objectContaining({
                ownerId: 'phill',
                clientSurface: 'web-chat',
                title: 'Release Checklist',
            }),
        });
        expect(response.body.metadata.title).toBe('Release Checklist');
    });

    test('merges message-derived document links into the session artifact list', async () => {
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        artifactService.listSessionArtifacts.mockResolvedValue([]);
        sessionStore.listMessages.mockResolvedValue([
            {
                id: 'assistant-1',
                role: 'assistant',
                metadata: {
                    artifacts: [{
                        id: 'doc-77',
                        filename: 'pigeon-love-research.pptx',
                        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                        downloadUrl: '/api/documents/doc-77/download',
                        previewUrl: '/api/artifacts/doc-77/preview',
                        sandboxUrl: '/api/artifacts/doc-77/sandbox',
                        metadata: { format: 'pptx' },
                    }],
                },
            },
        ]);

        const app = express();
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/sessions', sessionsRouter);

        const response = await request(app).get('/api/sessions/session-1/artifacts');

        expect(response.status).toBe(200);
        expect(artifactService.listSessionArtifacts).toHaveBeenCalledWith('session-1');
        expect(sessionStore.listMessages).toHaveBeenCalledWith('session-1', 500, 'phill');
        expect(response.body.artifacts).toEqual([
            expect.objectContaining({
                id: 'doc-77',
                filename: 'pigeon-love-research.pptx',
                format: 'pptx',
                downloadUrl: '/api/documents/doc-77/download',
                previewUrl: '/api/artifacts/doc-77/preview',
                sandboxUrl: '/api/artifacts/doc-77/sandbox',
            }),
        ]);
    });

    test('includes local stored artifacts in file-backed mode', async () => {
        sessionStore.isPersistent.mockReturnValue(false);
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill' },
        });
        artifactService.listSessionArtifacts.mockResolvedValue([{
            id: 'artifact-local-1',
            filename: 'research.html',
            format: 'html',
            mimeType: 'text/html',
            downloadUrl: '/api/artifacts/artifact-local-1/download',
        }]);
        sessionStore.listMessages.mockResolvedValue([
            {
                id: 'assistant-1',
                role: 'assistant',
                metadata: {
                    artifacts: [{
                        id: 'doc-88',
                        filename: 'fallback-only.pdf',
                        mimeType: 'application/pdf',
                        downloadUrl: '/api/documents/doc-88/download',
                        metadata: { format: 'pdf' },
                    }],
                },
            },
        ]);

        const app = express();
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/sessions', sessionsRouter);

        const response = await request(app).get('/api/sessions/session-1/artifacts');

        expect(response.status).toBe(200);
        expect(artifactService.listSessionArtifacts).toHaveBeenCalledWith('session-1');
        expect(response.body.artifacts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'artifact-local-1',
                filename: 'research.html',
                format: 'html',
            }),
            expect.objectContaining({
                id: 'doc-88',
                filename: 'fallback-only.pdf',
                format: 'pdf',
            }),
        ]));
    });

    test('cancels an active foreground request for the owned session', async () => {
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill', clientSurface: 'web-chat' },
        });
        resolveForegroundTurn.mockReturnValue({
            requestId: 'request-1',
            assistantMessageId: 'assistant-1',
            clientSurface: 'web-chat',
            status: 'running',
        });
        abortForegroundRequest.mockReturnValue({
            cancelled: true,
            active: true,
            reason: 'user_cancelled',
            sessionId: 'session-1',
            requestId: 'request-1',
        });

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/sessions', sessionsRouter);

        const response = await request(app)
            .post('/api/sessions/session-1/foreground/cancel')
            .send({ requestId: 'request-1' });

        expect(response.status).toBe(200);
        expect(abortForegroundRequest).toHaveBeenCalledWith({
            sessionId: 'session-1',
            requestId: 'request-1',
            ownerId: 'phill',
            reason: 'user_cancelled',
        });
        expect(cancelForegroundTurn).not.toHaveBeenCalled();
        expect(response.body).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            requestId: 'request-1',
            cancelled: true,
            active: true,
            persisted: false,
            reason: 'user_cancelled',
        }));
    });

    test('persists cancellation when the foreground request is no longer registered', async () => {
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            metadata: { ownerId: 'phill', clientSurface: 'web-chat' },
        });
        const persistedTurn = {
            requestId: 'request-2',
            assistantMessageId: 'assistant-2',
            clientSurface: 'web-chat',
            status: 'running',
        };
        resolveForegroundTurn.mockReturnValue(persistedTurn);
        abortForegroundRequest.mockReturnValue({
            cancelled: false,
            active: false,
            reason: 'not_found',
            sessionId: 'session-1',
            requestId: 'request-2',
        });

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/sessions', sessionsRouter);

        const response = await request(app)
            .post('/api/sessions/session-1/foreground/cancel')
            .send({ requestId: 'request-2' });

        expect(response.status).toBe(200);
        expect(cancelForegroundTurn).toHaveBeenCalledWith(
            sessionStore,
            'session-1',
            persistedTurn,
            expect.objectContaining({
                cancelledBy: 'user',
                reason: 'user_cancelled',
            }),
        );
        expect(response.body).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            requestId: 'request-2',
            cancelled: true,
            active: false,
            persisted: true,
            reason: 'not_found',
        }));
    });

    test('deletes the session even when memory cleanup fails', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            scopeKey: 'web-chat',
            metadata: { ownerId: 'phill', memoryScope: 'web-chat' },
        });
        sessionStore.getActiveOwnedSession.mockResolvedValue({ id: 'session-1' });
        sessionStore.getLatestOwnedSession.mockResolvedValue(null);
        sessionStore.setActiveSession.mockResolvedValue(null);
        sessionStore.delete.mockResolvedValue(true);
        artifactService.deleteArtifactsForSession.mockResolvedValue(undefined);
        memoryService.forget.mockRejectedValue(new Error('vector store down'));

        const app = express();
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/sessions', sessionsRouter);

        try {
            const response = await request(app).delete('/api/sessions/session-1');
            await new Promise((resolve) => setImmediate(resolve));

            expect(response.status).toBe(204);
            expect(sessionStore.delete).toHaveBeenCalledWith('session-1');
            expect(artifactService.deleteArtifactsForSession).toHaveBeenCalledWith('session-1');
            expect(memoryService.forget).toHaveBeenCalledWith('session-1');
            expect(sessionStore.setActiveSession).toHaveBeenCalledWith('phill', null, 'web-chat');
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('deleting a file-backed chat still removes local generated files', async () => {
        sessionStore.isPersistent.mockReturnValue(false);
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-local',
            scopeKey: 'web-chat',
            metadata: { ownerId: 'phill', memoryScope: 'web-chat' },
        });
        sessionStore.getActiveOwnedSession.mockResolvedValue(null);
        sessionStore.delete.mockResolvedValue(true);
        artifactService.deleteArtifactsForSession.mockResolvedValue(undefined);
        memoryService.forget.mockResolvedValue(undefined);

        const app = express();
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/sessions', sessionsRouter);

        const response = await request(app).delete('/api/sessions/session-local');
        await new Promise((resolve) => setImmediate(resolve));

        expect(response.status).toBe(204);
        expect(artifactService.deleteArtifactsForSession).toHaveBeenCalledWith('session-local');
        expect(sessionStore.delete).toHaveBeenCalledWith('session-local');
        expect(memoryService.forget).toHaveBeenCalledWith('session-local');
    });

    test('permanently deletes all sessions in a requested workspace scope', async () => {
        sessionStore.list.mockResolvedValue([
            { id: 'session-1', metadata: { ownerId: 'phill', memoryScope: 'web-chat-workspace-2' } },
            { id: 'session-2', metadata: { ownerId: 'phill', memoryScope: 'web-chat-workspace-2' } },
        ]);
        sessionStore.getActiveOwnedSession.mockResolvedValue({ id: 'session-1' });
        sessionStore.getOwned.mockImplementation(async (id) => ({
            id,
            scopeKey: 'web-chat-workspace-2',
            metadata: { ownerId: 'phill', memoryScope: 'web-chat-workspace-2' },
        }));
        sessionStore.delete.mockResolvedValue(true);
        artifactService.deleteArtifactsForSession.mockResolvedValue(undefined);
        memoryService.forget.mockResolvedValue(undefined);
        sessionStore.setActiveSession.mockResolvedValue(null);

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { username: 'phill' };
            next();
        });
        app.use('/api/sessions', sessionsRouter);

        const response = await request(app)
            .delete('/api/sessions?clientSurface=web-chat&workspaceKey=web-chat-workspace-2')
            .send();

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            deleted: ['session-1', 'session-2'],
            count: 2,
            scopeKey: 'web-chat-workspace-2',
        });
        expect(sessionStore.list).toHaveBeenCalledWith({
            ownerId: 'phill',
            scopeKey: 'web-chat-workspace-2',
        });
        expect(sessionStore.delete).toHaveBeenCalledWith('session-1');
        expect(sessionStore.delete).toHaveBeenCalledWith('session-2');
        expect(memoryService.forget).toHaveBeenCalledWith('session-1');
        expect(memoryService.forget).toHaveBeenCalledWith('session-2');
        expect(sessionStore.setActiveSession).toHaveBeenCalledWith('phill', null, 'web-chat-workspace-2');
    });
});
