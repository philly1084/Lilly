'use strict';

const express = require('express');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const request = require('supertest');

jest.mock('./dashboard.controller', () => jest.fn().mockImplementation(function DashboardController(orchestrator) {
    this.orchestrator = orchestrator;
    this.getStats = jest.fn((_req, res) => res.json({ success: true, data: { source: 'stats' } }));
    this.getHealth = jest.fn((_req, res) => res.json({ success: true, data: { status: 'healthy' } }));
    this.getRecentActivity = jest.fn((_req, res) => res.json({ success: true, data: [] }));
    this.executeTask = jest.fn();
    this.cancelTask = jest.fn();
    this.getActiveSessions = jest.fn();
    this.getSessionDetails = jest.fn();
    this.clearSession = jest.fn();
}));

jest.mock('../../admin/runtime-monitor', () => ({
    setDashboardController: jest.fn(),
}));

const DashboardController = require('./dashboard.controller');
const { setDashboardController } = require('../../admin/runtime-monitor');
const settingsController = require('./settings.controller');
const { artifactService } = require('../../artifacts/artifact-service');
const { artifactStore } = require('../../artifacts/artifact-store');
const { sessionStore } = require('../../session-store');
const { memoryService } = require('../../memory/memory-service');
const adminRouter = require('./index');

describe('/api/admin workload routes', () => {
    function buildApp(service, opencodeService = null) {
        const app = express();
        app.use(express.json());
        app.locals.agentWorkloadService = service;
        app.locals.opencodeService = opencodeService;
        app.use('/api/admin', adminRouter);
        app.use((err, _req, res, _next) => {
            res.status(err.statusCode || 500).json({
                success: false,
                error: err.message,
            });
        });
        return app;
    }

    test('pauses a workload from the admin dashboard', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
            pauseAdminWorkload: jest.fn(async () => ({
                id: 'workload-1',
                enabled: false,
            })),
        };
        const app = buildApp(service);

        const response = await request(app).post('/api/admin/workloads/workload-1/pause').send({});

        expect(response.status).toBe(200);
        expect(service.pauseAdminWorkload).toHaveBeenCalledWith('workload-1');
        expect(response.body.success).toBe(true);
        expect(response.body.data.enabled).toBe(false);
    });

    test('updates a workload from the admin dashboard', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
            updateAdminWorkload: jest.fn(async () => ({
                id: 'workload-1',
                title: 'Nightly review',
                prompt: 'Review the queue and flag failures.',
            })),
        };
        const app = buildApp(service);

        const response = await request(app)
            .patch('/api/admin/workloads/workload-1')
            .send({
                prompt: 'Review the queue and flag failures.',
            });

        expect(response.status).toBe(200);
        expect(service.updateAdminWorkload).toHaveBeenCalledWith('workload-1', {
            prompt: 'Review the queue and flag failures.',
        });
        expect(response.body.success).toBe(true);
        expect(response.body.data.prompt).toBe('Review the queue and flag failures.');
    });

    test('resumes a workload from the admin dashboard', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
            resumeAdminWorkload: jest.fn(async () => ({
                id: 'workload-1',
                enabled: true,
            })),
        };
        const app = buildApp(service);

        const response = await request(app).post('/api/admin/workloads/workload-1/resume').send({});

        expect(response.status).toBe(200);
        expect(service.resumeAdminWorkload).toHaveBeenCalledWith('workload-1');
        expect(response.body.data.enabled).toBe(true);
    });

    test('deletes a workload from the admin dashboard', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
            deleteAdminWorkload: jest.fn(async () => true),
        };
        const app = buildApp(service);

        const response = await request(app).delete('/api/admin/workloads/workload-1');

        expect(response.status).toBe(200);
        expect(service.deleteAdminWorkload).toHaveBeenCalledWith('workload-1');
        expect(response.body.success).toBe(true);
    });

    test('creates a fallback dashboard controller when startup did not initialize one', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
        };
        const app = buildApp(service);
        app.locals.conversationOrchestrator = { id: 'orchestrator-1' };

        const statsResponse = await request(app).get('/api/admin/stats');
        const activityResponse = await request(app).get('/api/admin/activity');
        const healthResponse = await request(app).get('/api/admin/health');

        expect(statsResponse.status).toBe(200);
        expect(activityResponse.status).toBe(200);
        expect(healthResponse.status).toBe(200);
        expect(DashboardController).toHaveBeenCalledTimes(1);
        expect(DashboardController).toHaveBeenCalledWith(app.locals.conversationOrchestrator);
        expect(setDashboardController).toHaveBeenCalledTimes(1);
        expect(app.locals.dashboardController).toBeTruthy();
    });

    test('uploads a podcast intro audio asset from the admin dashboard', async () => {
        const previousStateDir = process.env.KIMIBUILT_STATE_DIR;
        const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-admin-audio-'));
        process.env.KIMIBUILT_STATE_DIR = stateDir;
        settingsController.settings = settingsController.getDefaultSettings();
        const app = buildApp({ isAvailable: jest.fn(() => true) });

        try {
            const response = await request(app)
                .post('/api/admin/podcast-audio/intro')
                .attach('file', Buffer.from('audio-bytes'), 'intro.wav');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data.storageDirectory).toBe(path.join(stateDir, 'podcast-audio'));
            expect(response.body.data.tracks.intro).toEqual(expect.objectContaining({
                configured: true,
                exists: true,
                originalFilename: 'intro.wav',
            }));
            expect(settingsController.settings.audioProcessing.podcastIntroPath).toContain('intro-');
        } finally {
            if (previousStateDir === undefined) {
                delete process.env.KIMIBUILT_STATE_DIR;
            } else {
                process.env.KIMIBUILT_STATE_DIR = previousStateDir;
            }
            await fs.rm(stateDir, { recursive: true, force: true });
        }
    });

    test('lists generated storage from the admin dashboard', async () => {
        const previousDataDir = process.env.KIMIBUILT_DATA_DIR;
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-admin-storage-'));
        process.env.KIMIBUILT_DATA_DIR = dataDir;
        const audioDir = path.join(dataDir, 'generated-audio');
        const audioPath = path.join(audioDir, 'audio-local-test.wav');
        const metadataPath = path.join(audioDir, 'audio-local-test.json');
        const app = buildApp({ isAvailable: jest.fn(() => true) });

        try {
            await fs.mkdir(audioDir, { recursive: true });
            await fs.writeFile(audioPath, Buffer.from('audio-bytes'));
            await fs.writeFile(metadataPath, JSON.stringify({
                id: 'audio-local-test',
                filename: 'sample.wav',
                audioPath,
                sizeBytes: 11,
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-01T00:00:00.000Z',
                metadata: { storage: 'local-fallback' },
            }));

            const response = await request(app).get('/api/admin/storage');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data.dataDirectory).toBe(dataDir);
            const audioCategory = response.body.data.categories.find((item) => item.category === 'generatedAudio');
            expect(audioCategory.count).toBe(1);
            expect(audioCategory.records[0]).toEqual(expect.objectContaining({
                id: 'audio-local-test',
                filename: 'sample.wav',
                fileCount: 2,
            }));
        } finally {
            if (previousDataDir === undefined) {
                delete process.env.KIMIBUILT_DATA_DIR;
            } else {
                process.env.KIMIBUILT_DATA_DIR = previousDataDir;
            }
            await fs.rm(dataDir, { recursive: true, force: true });
        }
    });

    test('lists stored document artifacts from the admin dashboard', async () => {
        const isEnabledSpy = jest.spyOn(artifactService, 'isEnabled').mockReturnValue(true);
        const listSpy = jest.spyOn(artifactStore, 'listAllWithSessions').mockResolvedValue([
            {
                id: 'artifact-db-report',
                sessionId: 'session-1',
                ownerId: 'owner-1',
                filename: 'report.pdf',
                extension: 'pdf',
                mimeType: 'application/pdf',
                sizeBytes: 2048,
                sourceMode: 'document',
                metadata: { generatedBy: 'document-generator' },
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
            },
            {
                id: 'artifact-db-image',
                sessionId: 'session-1',
                ownerId: 'owner-1',
                filename: 'image.png',
                extension: 'png',
                mimeType: 'image/png',
                sizeBytes: 1024,
                sourceMode: 'image',
                metadata: {},
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
            },
        ]);
        const app = buildApp({ isAvailable: jest.fn(() => true) });

        try {
            const response = await request(app).get('/api/admin/storage');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            const storedCategory = response.body.data.categories.find((item) => item.category === 'storedArtifacts');
            expect(storedCategory).toEqual(expect.objectContaining({
                count: 1,
                label: 'Stored documents',
            }));
            expect(storedCategory.records[0]).toEqual(expect.objectContaining({
                id: 'artifact-db-report',
                filename: 'report.pdf',
                storage: 'postgres',
                downloadUrl: '/api/artifacts/artifact-db-report/download',
                fileCount: 1,
            }));
        } finally {
            listSpy.mockRestore();
            isEnabledSpy.mockRestore();
        }
    });

    test('lists old chat sessions from the admin dashboard', async () => {
        const listSpy = jest.spyOn(sessionStore, 'list').mockResolvedValue([
            {
                id: 'chat-session-1',
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
                messageCount: 4,
                scopeKey: 'web-chat',
                metadata: {
                    ownerId: 'owner-1',
                    recentMessages: [
                        { role: 'user', content: 'Build a dashboard for the shop' },
                    ],
                },
            },
        ]);
        const persistentSpy = jest.spyOn(sessionStore, 'isPersistent').mockReturnValue(true);
        const app = buildApp({ isAvailable: jest.fn(() => true) });

        try {
            const response = await request(app).get('/api/admin/storage');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            const chatCategory = response.body.data.categories.find((item) => item.category === 'chatSessions');
            expect(chatCategory).toEqual(expect.objectContaining({
                count: 1,
                label: 'Old chats',
            }));
            expect(chatCategory.records[0]).toEqual(expect.objectContaining({
                id: 'chat-session-1',
                filename: 'Build a dashboard for the shop',
                sessionId: 'chat-session-1',
                ownerId: 'owner-1',
                scopeKey: 'web-chat',
                messageCount: 4,
                storage: 'postgres',
            }));
        } finally {
            persistentSpy.mockRestore();
            listSpy.mockRestore();
        }
    });

    test('deletes one generated storage record from the admin dashboard', async () => {
        const previousDataDir = process.env.KIMIBUILT_DATA_DIR;
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-admin-storage-delete-'));
        process.env.KIMIBUILT_DATA_DIR = dataDir;
        const artifactDir = path.join(dataDir, 'generated-artifacts');
        const contentPath = path.join(artifactDir, 'artifact-local-test.html');
        const metadataPath = path.join(artifactDir, 'artifact-local-test.json');
        const app = buildApp({ isAvailable: jest.fn(() => true) });

        try {
            await fs.mkdir(artifactDir, { recursive: true });
            await fs.writeFile(contentPath, Buffer.from('<h1>Report</h1>'));
            await fs.writeFile(metadataPath, JSON.stringify({
                id: 'artifact-local-test',
                filename: 'report.html',
                contentPath,
                sizeBytes: 15,
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-01T00:00:00.000Z',
            }));

            const response = await request(app).delete('/api/admin/storage/generatedArtifacts/artifact-local-test');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data.deleted).toBe(1);
            await expect(fs.stat(contentPath)).rejects.toThrow();
            await expect(fs.stat(metadataPath)).rejects.toThrow();
        } finally {
            if (previousDataDir === undefined) {
                delete process.env.KIMIBUILT_DATA_DIR;
            } else {
                process.env.KIMIBUILT_DATA_DIR = previousDataDir;
            }
            await fs.rm(dataDir, { recursive: true, force: true });
        }
    });

    test('deletes one stored document artifact through the admin dashboard', async () => {
        const isEnabledSpy = jest.spyOn(artifactService, 'isEnabled').mockReturnValue(true);
        const listSpy = jest.spyOn(artifactStore, 'listAllWithSessions').mockResolvedValue([
            {
                id: 'artifact-db-delete',
                sessionId: 'session-1',
                ownerId: 'owner-1',
                filename: 'report.html',
                extension: 'html',
                mimeType: 'text/html',
                sizeBytes: 4096,
                sourceMode: 'document',
                metadata: { generatedBy: 'document-generator' },
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
            },
        ]);
        const deleteSpy = jest.spyOn(artifactService, 'deleteArtifact').mockResolvedValue(true);
        const app = buildApp({ isAvailable: jest.fn(() => true) });

        try {
            const response = await request(app).delete('/api/admin/storage/storedArtifacts/artifact-db-delete');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data.deleted).toBe(1);
            expect(deleteSpy).toHaveBeenCalledWith('artifact-db-delete');
        } finally {
            deleteSpy.mockRestore();
            listSpy.mockRestore();
            isEnabledSpy.mockRestore();
        }
    });

    test('permanently deletes an old chat session through the admin dashboard', async () => {
        const listSpy = jest.spyOn(sessionStore, 'list').mockResolvedValue([
            {
                id: 'chat-session-delete',
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
                messageCount: 2,
                scopeKey: 'web-chat',
                metadata: {
                    ownerId: 'owner-1',
                    recentMessages: [
                        { role: 'user', content: 'Old chat to remove' },
                    ],
                },
            },
        ]);
        const persistentSpy = jest.spyOn(sessionStore, 'isPersistent').mockReturnValue(true);
        const deleteSpy = jest.spyOn(sessionStore, 'delete').mockResolvedValue(true);
        const deleteArtifactsSpy = jest.spyOn(artifactService, 'deleteArtifactsForSession').mockResolvedValue(undefined);
        const forgetSpy = jest.spyOn(memoryService, 'forget').mockResolvedValue(undefined);
        const app = buildApp({ isAvailable: jest.fn(() => true) });

        try {
            const response = await request(app).delete('/api/admin/storage/chatSessions/chat-session-delete');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data.deleted).toBe(1);
            expect(deleteArtifactsSpy).toHaveBeenCalledWith('chat-session-delete');
            expect(deleteSpy).toHaveBeenCalledWith('chat-session-delete');
            expect(forgetSpy).toHaveBeenCalledWith('chat-session-delete');
        } finally {
            forgetSpy.mockRestore();
            deleteArtifactsSpy.mockRestore();
            deleteSpy.mockRestore();
            persistentSpy.mockRestore();
            listSpy.mockRestore();
        }
    });

    test('permanently deletes file-backed chat artifacts through the admin dashboard', async () => {
        const listSpy = jest.spyOn(sessionStore, 'list').mockResolvedValue([
            {
                id: 'chat-session-file-backed',
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
                messageCount: 2,
                scopeKey: 'web-chat',
                metadata: {
                    ownerId: 'owner-1',
                    recentMessages: [
                        { role: 'user', content: 'File backed chat to remove' },
                    ],
                },
            },
        ]);
        const persistentSpy = jest.spyOn(sessionStore, 'isPersistent').mockReturnValue(false);
        const deleteSpy = jest.spyOn(sessionStore, 'delete').mockResolvedValue(true);
        const deleteArtifactsSpy = jest.spyOn(artifactService, 'deleteArtifactsForSession').mockResolvedValue(undefined);
        const forgetSpy = jest.spyOn(memoryService, 'forget').mockResolvedValue(undefined);
        const app = buildApp({ isAvailable: jest.fn(() => true) });

        try {
            const response = await request(app).delete('/api/admin/storage/chatSessions/chat-session-file-backed');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data.deleted).toBe(1);
            expect(deleteArtifactsSpy).toHaveBeenCalledWith('chat-session-file-backed');
            expect(deleteSpy).toHaveBeenCalledWith('chat-session-file-backed');
            expect(forgetSpy).toHaveBeenCalledWith('chat-session-file-backed');
        } finally {
            forgetSpy.mockRestore();
            deleteArtifactsSpy.mockRestore();
            deleteSpy.mockRestore();
            persistentSpy.mockRestore();
            listSpy.mockRestore();
        }
    });

    test('clear-all storage cleanup deletes current chats too', async () => {
        const previousDataDir = process.env.KIMIBUILT_DATA_DIR;
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-admin-storage-clear-all-'));
        process.env.KIMIBUILT_DATA_DIR = dataDir;
        const listSpy = jest.spyOn(sessionStore, 'list').mockResolvedValue([
            {
                id: 'chat-session-current',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                messageCount: 1,
                scopeKey: 'web-chat',
                metadata: {
                    ownerId: 'owner-1',
                    recentMessages: [
                        { role: 'user', content: 'Brand new chat' },
                    ],
                },
            },
        ]);
        const persistentSpy = jest.spyOn(sessionStore, 'isPersistent').mockReturnValue(false);
        const deleteSpy = jest.spyOn(sessionStore, 'delete').mockResolvedValue(true);
        const deleteArtifactsSpy = jest.spyOn(artifactService, 'deleteArtifactsForSession').mockResolvedValue(undefined);
        const forgetSpy = jest.spyOn(memoryService, 'forget').mockResolvedValue(undefined);
        const isEnabledSpy = jest.spyOn(artifactService, 'isEnabled').mockReturnValue(false);
        const app = buildApp({ isAvailable: jest.fn(() => true) });

        try {
            const response = await request(app)
                .post('/api/admin/storage/cleanup')
                .send({ clearAll: true, dryRun: false });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data.clearAll).toBe(true);
            expect(response.body.data.deletedCount).toBe(1);
            expect(response.body.data.records[0]).toEqual(expect.objectContaining({
                id: 'chat-session-current',
                category: 'chatSessions',
            }));
            expect(deleteArtifactsSpy).toHaveBeenCalledWith('chat-session-current');
            expect(deleteSpy).toHaveBeenCalledWith('chat-session-current');
            expect(forgetSpy).toHaveBeenCalledWith('chat-session-current');
        } finally {
            isEnabledSpy.mockRestore();
            forgetSpy.mockRestore();
            deleteArtifactsSpy.mockRestore();
            deleteSpy.mockRestore();
            persistentSpy.mockRestore();
            listSpy.mockRestore();
            if (previousDataDir === undefined) {
                delete process.env.KIMIBUILT_DATA_DIR;
            } else {
                process.env.KIMIBUILT_DATA_DIR = previousDataDir;
            }
            await fs.rm(dataDir, { recursive: true, force: true });
        }
    });

    test('bulk deletes selected old chats and stored document artifacts from the admin dashboard', async () => {
        const listSessionsSpy = jest.spyOn(sessionStore, 'list').mockResolvedValue([
            {
                id: 'chat-session-bulk',
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
                messageCount: 3,
                scopeKey: 'web-chat',
                metadata: {
                    ownerId: 'owner-1',
                    recentMessages: [
                        { role: 'user', content: 'Bulk old chat' },
                    ],
                },
            },
        ]);
        const persistentSpy = jest.spyOn(sessionStore, 'isPersistent').mockReturnValue(true);
        const deleteSessionSpy = jest.spyOn(sessionStore, 'delete').mockResolvedValue(true);
        const deleteArtifactsForSessionSpy = jest.spyOn(artifactService, 'deleteArtifactsForSession').mockResolvedValue(undefined);
        const forgetSpy = jest.spyOn(memoryService, 'forget').mockResolvedValue(undefined);
        const isEnabledSpy = jest.spyOn(artifactService, 'isEnabled').mockReturnValue(true);
        const listArtifactsSpy = jest.spyOn(artifactStore, 'listAllWithSessions').mockResolvedValue([
            {
                id: 'artifact-db-bulk',
                sessionId: 'session-1',
                ownerId: 'owner-1',
                filename: 'bulk-report.pdf',
                extension: 'pdf',
                mimeType: 'application/pdf',
                sizeBytes: 2048,
                sourceMode: 'document',
                metadata: { generatedBy: 'document-generator' },
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
            },
        ]);
        const deleteArtifactSpy = jest.spyOn(artifactService, 'deleteArtifact').mockResolvedValue(true);
        const app = buildApp({ isAvailable: jest.fn(() => true) });

        try {
            const response = await request(app)
                .post('/api/admin/storage/bulk-delete')
                .send({
                    items: [
                        { category: 'chatSessions', id: 'chat-session-bulk' },
                        { category: 'storedArtifacts', id: 'artifact-db-bulk' },
                    ],
                });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.data.deletedCount).toBe(2);
            expect(response.body.data.failedCount).toBe(0);
            expect(response.body.data.deletedBytes).toBeGreaterThanOrEqual(2048);
            expect(deleteArtifactsForSessionSpy).toHaveBeenCalledWith('chat-session-bulk');
            expect(deleteSessionSpy).toHaveBeenCalledWith('chat-session-bulk');
            expect(forgetSpy).toHaveBeenCalledWith('chat-session-bulk');
            expect(deleteArtifactSpy).toHaveBeenCalledWith('artifact-db-bulk');
        } finally {
            deleteArtifactSpy.mockRestore();
            listArtifactsSpy.mockRestore();
            isEnabledSpy.mockRestore();
            forgetSpy.mockRestore();
            deleteArtifactsForSessionSpy.mockRestore();
            deleteSessionSpy.mockRestore();
            persistentSpy.mockRestore();
            listSessionsSpy.mockRestore();
        }
    });
});
