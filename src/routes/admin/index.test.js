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
const { assetManager } = require('../../asset-manager');
const { sessionStore } = require('../../session-store');
const { memoryService } = require('../../memory/memory-service');
const adminRouter = require('./index');

describe('/api/admin workload routes', () => {
    function buildApp(service, opencodeService = null, options = {}) {
        const app = express();
        app.use(express.json());
        app.locals.agentWorkloadService = service;
        app.locals.opencodeService = opencodeService;
        if (options.user) {
            app.use((req, _res, next) => {
                req.user = options.user;
                next();
            });
        }
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

    test('exposes agent company status and manual heartbeat', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
        };
        const app = buildApp(service);
        app.locals.agentCompanyService = {
            getStatus: jest.fn(async () => ({
                available: true,
                state: {
                    heartbeat: { status: 'steady' },
                },
            })),
            tick: jest.fn(async () => ({
                available: true,
                createdWorkloads: [{ id: 'workload-1' }],
            })),
        };

        const statusResponse = await request(app).get('/api/admin/agent-company');
        const heartbeatResponse = await request(app)
            .post('/api/admin/agent-company/heartbeat')
            .send({ reason: 'test' });

        expect(statusResponse.status).toBe(200);
        expect(statusResponse.body.data.state.heartbeat.status).toBe('steady');
        expect(heartbeatResponse.status).toBe(200);
        expect(app.locals.agentCompanyService.tick).toHaveBeenCalledWith({
            force: true,
            reason: 'test',
        });
        expect(heartbeatResponse.body.data.createdWorkloads).toHaveLength(1);
    });

    test('exposes an agent company workspace with CEO actions and deliverables', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
            listAdminWorkloads: jest.fn(async () => [
                {
                    id: 'company-workload',
                    sessionId: 'agent-company',
                    title: 'Strategy Lead: Weekly plan',
                    metadata: {
                        agentCompany: {
                            enabled: true,
                            roleName: 'Strategy Lead',
                            companyGoalHash: 'goal-hash',
                            weekKey: '2026-06-22',
                            sharedWhiteboard: {
                                path: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                                purpose: 'agent-to-agent weekly coordination',
                                sections: [
                                    'Claims checked',
                                    'Decisions made',
                                    'Files/artifacts changed',
                                ],
                            },
                        },
                    },
                },
                {
                    id: 'other-workload',
                    sessionId: 'general',
                    title: 'Other work',
                    metadata: {},
                },
            ]),
            listAdminRuns: jest.fn(async () => [
                {
                    id: 'company-run',
                    workloadId: 'company-workload',
                    sessionId: 'agent-company',
                    status: 'completed',
                    finishedAt: '2026-06-26T12:00:00.000Z',
                    metadata: {
                        output: {
                            text: 'Created the weekly plan.',
                            artifacts: [{
                                id: 'artifact-run-plan',
                                filename: 'weekly-plan.pdf',
                                mimeType: 'application/pdf',
                            }],
                        },
                    },
                },
                {
                    id: 'other-run',
                    workloadId: 'other-workload',
                    sessionId: 'general',
                    status: 'completed',
                    metadata: {
                        output: {
                            artifacts: [{ id: 'artifact-other', filename: 'ignore.pdf' }],
                        },
                    },
                },
            ]),
        };
        const isEnabledSpy = jest.spyOn(artifactService, 'isEnabled').mockReturnValue(true);
        const listBySessionSpy = jest.spyOn(artifactStore, 'listBySession').mockResolvedValue([
            {
                id: 'artifact-session-brief',
                sessionId: 'agent-company',
                filename: 'ceo-brief.html',
                extension: 'html',
                mimeType: 'text/html',
                sizeBytes: 1024,
                sourceMode: 'document',
                previewHtml: '<h1>CEO Brief</h1>',
                metadata: { title: 'CEO Brief' },
                createdAt: '2026-06-26T13:00:00.000Z',
                updatedAt: '2026-06-26T13:00:00.000Z',
            },
        ]);
        const searchSpy = jest.spyOn(assetManager, 'searchAssets').mockResolvedValue({
            query: '2026-06-22-whiteboard.md',
            kind: 'document',
            sourceType: 'workspace',
            sessionId: 'agent-company',
            count: 1,
            refreshed: { workspace: false, artifacts: false },
            results: [
                {
                    id: 'workspace:whiteboard',
                    sourceType: 'workspace',
                    kind: 'document',
                    title: '2026-06-22 whiteboard',
                    filename: '2026-06-22-whiteboard.md',
                    relativePath: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                    sizeBytes: 512,
                    updatedAt: '2026-06-26T14:00:00.000Z',
                    contentPreview: 'Claims checked: public route works. Decisions made: keep DNS stable. Next agent task: verify deploy proof.',
                },
            ],
        });
        const app = buildApp(service);
        app.locals.agentCompanyService = {
            getStatus: jest.fn(async () => ({
                available: true,
                config: {
                    enabled: true,
                    sessionId: 'agent-company',
                    companyGoal: 'Run a useful research studio.',
                },
                state: {
                    companyGoalHash: 'goal-hash',
                    heartbeat: { status: 'steady' },
                    dailyAlignment: { status: 'steady' },
                    shortTermSchedule: [{ id: 'plan-1', title: 'Company weekly plan' }],
                },
            })),
        };

        try {
            const response = await request(app).get('/api/admin/agent-company/workspace');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(service.listAdminWorkloads).toHaveBeenCalledWith(200);
            expect(service.listAdminRuns).toHaveBeenCalledWith(200);
            expect(listBySessionSpy).toHaveBeenCalledWith('agent-company');
            expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({
                query: '2026-06-22-whiteboard.md',
                kind: 'document',
                sourceType: 'workspace',
                includeContent: true,
                refresh: false,
            }), expect.objectContaining({
                sessionId: 'agent-company',
                sessionIsolation: false,
            }));
            expect(response.body.data.workspace).toEqual(expect.objectContaining({
                sessionId: 'agent-company',
                workloadAvailable: true,
                workloadCount: 1,
                runCount: 1,
                deliverableCount: 2,
            }));
            expect(response.body.data.workloads.map((workload) => workload.id)).toEqual(['company-workload']);
            expect(response.body.data.runs.map((run) => run.id)).toEqual(['company-run']);
            expect(response.body.data.deliverables).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    id: 'artifact-run-plan',
                    filename: 'weekly-plan.pdf',
                    roleName: 'Strategy Lead',
                    runId: 'company-run',
                    downloadUrl: '/api/artifacts/artifact-run-plan/download',
                }),
                expect.objectContaining({
                    id: 'artifact-session-brief',
                    filename: 'ceo-brief.html',
                    previewUrl: '/api/artifacts/artifact-session-brief/preview',
                }),
            ]));
            expect(response.body.data.actionQueue).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    id: 'review-deliverables',
                    target: 'deliverables',
                }),
            ]));
            expect(response.body.data.improvementLoop).toEqual(expect.objectContaining({
                health: 'looping',
                metrics: expect.objectContaining({
                    workloads: 1,
                    runs: 1,
                    deliverables: 2,
                }),
                phases: expect.arrayContaining([
                    expect.objectContaining({
                        id: 'sense',
                        status: 'ready',
                    }),
                    expect.objectContaining({
                        id: 'verify',
                        status: 'ready',
                    }),
                    expect.objectContaining({
                        id: 'learn',
                        status: 'ready',
                    }),
                ]),
            }));
            expect(response.body.data.sharedWhiteboard).toEqual(expect.objectContaining({
                status: 'ready',
                detail: '1 workload carrying the shared whiteboard contract.',
                current: expect.objectContaining({
                    path: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                    weekKey: '2026-06-22',
                    workloadCount: 1,
                    roleNames: ['Strategy Lead'],
                    sections: expect.arrayContaining(['Claims checked', 'Decisions made']),
                    filePreview: expect.objectContaining({
                        status: 'ready',
                        relativePath: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                        preview: 'Claims checked: public route works. Decisions made: keep DNS stable. Next agent task: verify deploy proof.',
                        sizeBytes: 512,
                    }),
                }),
            }));
        } finally {
            searchSpy.mockRestore();
            listBySessionSpy.mockRestore();
            isEnabledSpy.mockRestore();
        }
    });

    test('surfaces a CEO action when the shared whiteboard file is missing from the file room', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
            listAdminWorkloads: jest.fn(async () => [
                {
                    id: 'company-workload',
                    sessionId: 'agent-company',
                    title: 'Strategy Lead: Weekly plan',
                    metadata: {
                        agentCompany: {
                            enabled: true,
                            roleName: 'Strategy Lead',
                            companyGoalHash: 'goal-hash',
                            weekKey: '2026-06-22',
                            sharedWhiteboard: {
                                path: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                                purpose: 'agent-to-agent weekly coordination',
                                sections: ['Claims checked', 'Next agent task'],
                            },
                        },
                    },
                },
                {
                    id: 'whiteboard-refresh-workload',
                    sessionId: 'agent-company',
                    title: 'Operations Lead: Refresh shared whiteboard',
                    status: 'queued',
                    updatedAt: '2026-06-26T15:00:00.000Z',
                    metadata: {
                        agentCompany: {
                            enabled: true,
                            roleName: 'Operations Lead',
                            companyGoalHash: 'goal-hash',
                            weekKey: '2026-06-22',
                            workloadReason: 'shared-whiteboard-refresh',
                            workloadFocus: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                            sharedWhiteboard: {
                                path: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                                purpose: 'agent-to-agent weekly coordination',
                                sections: ['Claims checked', 'Next agent task'],
                            },
                        },
                    },
                },
            ]),
            listAdminRuns: jest.fn(async () => [
                {
                    id: 'whiteboard-refresh-run',
                    workloadId: 'whiteboard-refresh-workload',
                    sessionId: 'agent-company',
                    status: 'running',
                    updatedAt: '2026-06-26T15:05:00.000Z',
                    metadata: {
                        agentCompany: {
                            enabled: true,
                            workloadReason: 'shared-whiteboard-refresh',
                            workloadFocus: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                        },
                    },
                },
            ]),
        };
        const isEnabledSpy = jest.spyOn(artifactService, 'isEnabled').mockReturnValue(false);
        const searchSpy = jest.spyOn(assetManager, 'searchAssets').mockResolvedValue({
            query: '2026-06-22-whiteboard.md',
            kind: 'document',
            sourceType: 'workspace',
            sessionId: 'agent-company',
            count: 0,
            refreshed: { workspace: false, artifacts: false },
            results: [],
        });
        const app = buildApp(service);
        app.locals.agentCompanyService = {
            getStatus: jest.fn(async () => ({
                available: true,
                config: {
                    enabled: true,
                    sessionId: 'agent-company',
                    companyGoal: 'Run a useful research studio.',
                },
                state: {
                    companyGoalHash: 'goal-hash',
                    heartbeat: { status: 'steady' },
                    dailyAlignment: { status: 'steady' },
                    shortTermSchedule: [{ id: 'plan-1', title: 'Company weekly plan' }],
                },
            })),
        };

        try {
            const response = await request(app).get('/api/admin/agent-company/workspace');

            expect(response.status).toBe(200);
            expect(response.body.data.sharedWhiteboard.current.filePreview).toEqual(expect.objectContaining({
                status: 'missing',
                detail: 'Whiteboard file is not in the indexed company file room yet.',
            }));
            expect(response.body.data.actionQueue).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    id: 'refresh-shared-whiteboard',
                    actionKey: 'refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                    label: 'Refresh shared whiteboard',
                    detail: '.kimibuilt/agent-company/2026-06-22-whiteboard.md needs current coordination notes before scheduling more company work.',
                    target: 'whiteboard-refresh',
                    workloadReason: 'shared-whiteboard-refresh',
                    workloadFocus: '.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                    refreshStatus: expect.objectContaining({
                        workloadId: 'whiteboard-refresh-workload',
                        title: 'Operations Lead: Refresh shared whiteboard',
                        status: 'queued',
                        runId: 'whiteboard-refresh-run',
                        runStatus: 'running',
                        updatedAt: '2026-06-26T15:05:00.000Z',
                    }),
                    priority: 'medium',
                }),
            ]));

            const actionResponse = await request(app)
                .get('/api/admin/agent-company/action')
                .query({ actionKey: 'refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard.md' });

            expect(actionResponse.status).toBe(200);
            expect(actionResponse.body.data.historical).toBe(false);
            expect(actionResponse.body.data.action).toEqual(expect.objectContaining({
                id: 'refresh-shared-whiteboard',
                actionKey: 'refresh-shared-whiteboard:.kimibuilt/agent-company/2026-06-22-whiteboard.md',
                target: 'whiteboard-refresh',
                refreshStatus: expect.objectContaining({
                    runId: 'whiteboard-refresh-run',
                    runStatus: 'running',
                }),
            }));
        } finally {
            searchSpy.mockRestore();
            isEnabledSpy.mockRestore();
        }
    });

    test('exposes a shared agent company file manager backed by asset search', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
        };
        const searchSpy = jest.spyOn(assetManager, 'searchAssets').mockResolvedValue({
            query: 'plan',
            kind: 'document',
            sourceType: 'any',
            sessionId: 'agent-company',
            count: 2,
            refreshed: { workspace: false, artifacts: true },
            results: [
                {
                    id: 'artifact:weekly-plan',
                    sourceType: 'artifact',
                    kind: 'document',
                    title: 'Weekly Plan',
                    filename: 'weekly-plan.pdf',
                    artifactId: 'weekly-plan',
                    sessionId: 'agent-company',
                    downloadUrl: '/api/artifacts/weekly-plan/download',
                    contentPreview: 'Operating plan text',
                },
                {
                    id: 'workspace:docs/plan.md',
                    sourceType: 'workspace',
                    kind: 'document',
                    title: 'Plan Notes',
                    filename: 'plan.md',
                    relativePath: 'docs/plan.md',
                    contentPreview: 'Workspace notes text',
                },
            ],
        });
        const app = buildApp(service);
        app.locals.agentCompanyService = {
            getStatus: jest.fn(async () => ({
                config: { sessionId: 'agent-company' },
                state: {},
            })),
        };

        try {
            const response = await request(app)
                .get('/api/admin/agent-company/files?query=plan&sourceType=any&refresh=true');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({
                query: 'plan',
                kind: 'document',
                sourceType: 'any',
                sessionId: 'agent-company',
                includeContent: true,
                refresh: true,
            }), expect.objectContaining({
                sessionId: 'agent-company',
                sessionIsolation: false,
            }));
            expect(response.body.data.sourceCounts).toEqual({
                artifact: 1,
                workspace: 1,
            });
            expect(response.body.data.fileManager.grepExamples.join(' ')).toContain('asset-search');
            expect(response.body.data.results[0]).toEqual(expect.objectContaining({
                filename: 'weekly-plan.pdf',
                contentPreview: 'Operating plan text',
            }));
        } finally {
            searchSpy.mockRestore();
        }
    });

    test('does not owner-filter company artifacts for open-mode admin file search', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
        };
        const searchSpy = jest.spyOn(assetManager, 'searchAssets').mockResolvedValue({
            query: '',
            kind: 'document',
            sourceType: 'artifact',
            sessionId: 'agent-company',
            count: 1,
            refreshed: { workspace: false, artifacts: true },
            results: [
                {
                    id: 'artifact:company-plan',
                    sourceType: 'artifact',
                    kind: 'document',
                    title: 'Company Plan',
                    filename: 'company-plan.md',
                    artifactId: 'company-plan',
                    sessionId: 'agent-company',
                    downloadUrl: '/api/artifacts/company-plan/download',
                },
            ],
        });
        const app = buildApp(service, null, {
            user: { username: 'anonymous', role: 'open' },
        });
        app.locals.agentCompanyService = {
            getStatus: jest.fn(async () => ({
                config: { sessionId: 'agent-company' },
                state: {},
            })),
        };

        try {
            const response = await request(app)
                .get('/api/admin/agent-company/files?sourceType=artifact&refresh=true');

            expect(response.status).toBe(200);
            expect(response.body.data.sourceCounts).toEqual({ artifact: 1 });
            expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({
                sourceType: 'artifact',
                sessionId: 'agent-company',
                refresh: true,
            }), expect.objectContaining({
                sessionId: 'agent-company',
                ownerId: null,
                sessionIsolation: false,
            }));
        } finally {
            searchSpy.mockRestore();
        }
    });

    test('queues CEO review action for completed company output without packaged deliverables', async () => {
        const service = {
            isAvailable: jest.fn(() => true),
            listAdminWorkloads: jest.fn(async () => [
                {
                    id: 'company-workload',
                    sessionId: 'agent-company',
                    title: 'Operations Lead: Recursive improvement review',
                    metadata: {
                        agentCompany: {
                            enabled: true,
                            roleName: 'Operations Lead',
                            companyGoalHash: 'goal-hash',
                        },
                    },
                },
            ]),
            listAdminRuns: jest.fn(async () => [
                {
                    id: 'company-run',
                    workloadId: 'company-workload',
                    sessionId: 'agent-company',
                    status: 'completed',
                    metadata: {
                        output: {
                            text: 'Verified the latest work cycle.\n\nRecommended packaging <script>alert("x")</script> the research brief.',
                        },
                    },
                },
            ]),
        };
        const isEnabledSpy = jest.spyOn(artifactService, 'isEnabled').mockReturnValue(false);
        const app = buildApp(service);
        app.locals.agentCompanyService = {
            getStatus: jest.fn(async () => ({
                available: true,
                config: {
                    enabled: true,
                    sessionId: 'agent-company',
                    companyGoal: 'Run a useful research studio.',
                },
                state: {
                    companyGoalHash: 'goal-hash',
                    heartbeat: { status: 'steady' },
                    dailyAlignment: { status: 'steady' },
                    shortTermSchedule: [{ id: 'plan-1', title: 'Recursive improvement review' }],
                },
            })),
        };

        try {
            const response = await request(app).get('/api/admin/agent-company/workspace');

            expect(response.status).toBe(200);
            expect(response.body.data.deliverables).toEqual([]);
            expect(response.body.data.actionQueue).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    id: 'review-completed-output',
                    actionKey: 'review-completed-output:company-run',
                    target: 'runs',
                    priority: 'medium',
                    runId: 'company-run',
                    outputPreview: 'Verified the latest work cycle. Recommended packaging <script>alert("x")</script> the research brief.',
                }),
            ]));
            expect(response.body.data.improvementLoop).toEqual(expect.objectContaining({
                health: 'looping',
                phases: expect.arrayContaining([
                    expect.objectContaining({
                        id: 'sense',
                        status: 'ready',
                        detail: '1 completed text output available for CEO review before packaging.',
                    }),
                ]),
            }));
        } finally {
            isEnabledSpy.mockRestore();
        }
    });

    test('resolves aged-out CEO action context from saved action history', async () => {
        const previousStateDir = process.env.KIMIBUILT_STATE_DIR;
        const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-action-history-'));
        process.env.KIMIBUILT_STATE_DIR = stateDir;
        const service = {
            isAvailable: jest.fn(() => true),
            listAdminWorkloads: jest.fn(async () => [
                {
                    id: 'company-workload',
                    sessionId: 'agent-company',
                    title: 'Operations Lead: Recursive improvement review',
                    metadata: {
                        agentCompany: {
                            enabled: true,
                            roleName: 'Operations Lead',
                            companyGoalHash: 'goal-hash',
                        },
                    },
                },
            ]),
            listAdminRuns: jest.fn(async () => [
                {
                    id: 'historical-run',
                    workloadId: 'company-workload',
                    sessionId: 'agent-company',
                    status: 'completed',
                    metadata: {
                        output: {
                            text: 'Captured the CEO review brief before packaging.',
                        },
                    },
                },
            ]),
        };
        const isEnabledSpy = jest.spyOn(artifactService, 'isEnabled').mockReturnValue(false);
        const app = buildApp(service);
        app.locals.agentCompanyService = {
            getStatus: jest.fn(async () => ({
                available: true,
                config: {
                    enabled: true,
                    sessionId: 'agent-company',
                    companyGoal: 'Run a useful research studio.',
                },
                state: {
                    companyGoalHash: 'goal-hash',
                    heartbeat: { status: 'steady' },
                    dailyAlignment: { status: 'steady' },
                },
            })),
        };

        try {
            const workspaceResponse = await request(app).get('/api/admin/agent-company/workspace');
            expect(workspaceResponse.status).toBe(200);
            expect(workspaceResponse.body.data.actionQueue).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    actionKey: 'review-completed-output:historical-run',
                    outputPreview: 'Captured the CEO review brief before packaging.',
                }),
            ]));
            expect(workspaceResponse.body.data.actionHistory).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    actionKey: 'review-completed-output:historical-run',
                    runId: 'historical-run',
                    snapshotAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
                }),
            ]));

            service.listAdminRuns.mockResolvedValue([]);
            const actionResponse = await request(app)
                .get('/api/admin/agent-company/action?actionKey=review-completed-output%3Ahistorical-run');

            expect(actionResponse.status).toBe(200);
            expect(actionResponse.body.data.historical).toBe(true);
            expect(actionResponse.body.data.action).toEqual(expect.objectContaining({
                id: 'review-completed-output',
                actionKey: 'review-completed-output:historical-run',
                target: 'runs',
                runId: 'historical-run',
                outputPreview: 'Captured the CEO review brief before packaging.',
                snapshotAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            }));
        } finally {
            isEnabledSpy.mockRestore();
            if (previousStateDir === undefined) {
                delete process.env.KIMIBUILT_STATE_DIR;
            } else {
                process.env.KIMIBUILT_STATE_DIR = previousStateDir;
            }
            await fs.rm(stateDir, { recursive: true, force: true });
        }
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
