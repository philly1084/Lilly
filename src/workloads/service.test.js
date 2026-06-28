'use strict';

jest.mock('../realtime-hub', () => ({
    broadcastToAdmins: jest.fn(),
    broadcastToSession: jest.fn(),
}));

const { AgentWorkloadService } = require('./service');

describe('AgentWorkloadService', () => {
    let store;
    let sessionStore;
    let conversationRunService;
    let service;

    beforeEach(() => {
        store = {
            isAvailable: jest.fn(() => true),
            createWorkload: jest.fn(),
            enqueueRun: jest.fn(),
            addRunEvent: jest.fn(),
            getWorkloadById: jest.fn(),
            getAdminWorkloadById: jest.fn(),
            getWorkloadByCallableSlug: jest.fn(),
            updateWorkload: jest.fn(),
            deleteWorkload: jest.fn(),
            cancelQueuedRunsForWorkload: jest.fn(),
            cancelPendingQueuedRunsForWorkload: jest.fn(),
            completeRun: jest.fn(),
            failRun: jest.fn(),
            listSessionWorkloads: jest.fn(),
            listRunsForWorkload: jest.fn(),
            getRunById: jest.fn(),
        };
        sessionStore = {
            getOwned: jest.fn(async (sessionId, ownerId) => ({ id: sessionId, ownerId, metadata: {} })),
            get: jest.fn(),
            isPersistent: jest.fn(() => true),
        };
        conversationRunService = {
            appendSyntheticMessage: jest.fn(),
            runChatTurn: jest.fn(),
            runStructuredExecution: jest.fn(),
        };

        service = new AgentWorkloadService({
            store,
            sessionStore,
            conversationRunService,
        });
    });

    test('queues the initial scheduled run for once workloads', async () => {
        const workload = {
            id: 'workload-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'One-time summary',
            prompt: 'Summarize the thread.',
            enabled: true,
            trigger: {
                type: 'once',
                runAt: '2026-04-02T09:00:00.000Z',
            },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [],
        };

        store.createWorkload.mockResolvedValue(workload);
        store.enqueueRun.mockResolvedValue({
            id: 'run-1',
            workloadId: workload.id,
            scheduledFor: workload.trigger.runAt,
            reason: 'schedule',
            stageIndex: -1,
        });

        await service.createWorkload({
            sessionId: 'session-1',
            title: 'One-time summary',
            prompt: 'Summarize the thread.',
            trigger: {
                type: 'once',
                runAt: '2026-04-02T09:00:00.000Z',
            },
        }, 'phill');

        expect(store.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({
            workloadId: 'workload-1',
            reason: 'schedule',
            stageIndex: -1,
        }));
        expect(store.addRunEvent).toHaveBeenCalledWith('run-1', 'queued', expect.any(Object));
        expect(conversationRunService.appendSyntheticMessage).toHaveBeenCalledWith(
            'session-1',
            'system',
            expect.stringContaining('queued'),
        );
    });

    test('reports workloads as unavailable when the session store is not Postgres-backed', () => {
        sessionStore.isPersistent.mockReturnValue(false);

        expect(service.isAvailable()).toBe(false);
    });

    test('creates a workload from a plain-language scheduling request', async () => {
        const workload = {
            id: 'workload-plain-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Review Repo Activity And Summarize',
            prompt: 'review repo activity and summarize blockers.',
            enabled: true,
            trigger: {
                type: 'cron',
                expression: '0 9 * * 1-5',
                timezone: 'America/Halifax',
            },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [],
        };

        store.createWorkload.mockResolvedValue(workload);
        store.enqueueRun.mockResolvedValue({
            id: 'run-plain-1',
            workloadId: workload.id,
            scheduledFor: '2026-04-02T12:00:00.000Z',
            reason: 'cron',
            stageIndex: -1,
        });

        const created = await service.createWorkloadFromScenario(
            'session-1',
            'phill',
            'Every weekday at 9 AM review repo activity and summarize blockers.',
            { timezone: 'America/Halifax' },
        );

        expect(store.createWorkload).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            title: 'Review Repo Activity And Summarize',
            prompt: 'review repo activity and summarize blockers.',
            trigger: {
                type: 'cron',
                expression: '0 9 * * 1-5',
                timezone: 'America/Halifax',
            },
        }));
        expect(created.workload).toBe(workload);
        expect(created.scenario.scheduleDetected).toBe(true);
    });

    test('persists the requested model when creating a workload from a scenario', async () => {
        const workload = {
            id: 'workload-plain-model-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Review Repo Activity And Summarize',
            prompt: 'review repo activity and summarize blockers.',
            enabled: true,
            trigger: {
                type: 'cron',
                expression: '0 9 * * 1-5',
                timezone: 'America/Halifax',
            },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [],
            metadata: {
                requestedModel: 'gpt-5.3-instant',
            },
        };

        store.createWorkload.mockResolvedValue(workload);
        store.enqueueRun.mockResolvedValue({
            id: 'run-plain-model-1',
            workloadId: workload.id,
            scheduledFor: '2026-04-02T12:00:00.000Z',
            reason: 'cron',
            stageIndex: -1,
        });

        await service.createWorkloadFromScenario(
            'session-1',
            'phill',
            'Every weekday at 9 AM review repo activity and summarize blockers.',
            {
                timezone: 'America/Halifax',
                model: 'gpt-5.3-instant',
            },
        );

        expect(store.createWorkload).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                requestedModel: 'gpt-5.3-instant',
            }),
        }));
    });

    test('creates a deferred pdf export stage for scheduled document research requests', async () => {
        const workload = {
            id: 'workload-pdf-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Do Some Research On Adhd',
            prompt: 'do some research on ADHD and make a PDF document on it I can review.\n\nImportant: This scheduled run is split into content generation followed by PDF export. In this step, produce only the final document/report content that should go into the PDF. Do not say that you created, will create, or are attaching the PDF. Do not narrate your process, research steps, or tool usage unless that material belongs inside the actual document itself.',
            enabled: true,
            trigger: {
                type: 'once',
                runAt: '2026-04-02T09:05:00.000Z',
            },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [{
                when: 'on_success',
                delayMs: 0,
                prompt: '',
                toolIds: [],
                inputFrom: [],
                outputKey: null,
                outputFormat: 'pdf',
                metadata: {
                    generatedFromDeferredArtifactRequest: true,
                },
            }],
            metadata: {
                requestedOutputFormat: 'pdf',
            },
        };

        store.createWorkload.mockResolvedValue(workload);
        store.enqueueRun.mockResolvedValue({
            id: 'run-pdf-1',
            workloadId: workload.id,
            scheduledFor: workload.trigger.runAt,
            reason: 'schedule',
            stageIndex: -1,
        });

        await service.createWorkloadFromScenario(
            'session-1',
            'phill',
            'In 5 minutes can you do some research on ADHD and make a PDF document on it I can review.',
            { timezone: 'UTC' },
        );

        expect(store.createWorkload).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                requestedOutputFormat: 'pdf',
            }),
            stages: [expect.objectContaining({
                outputFormat: 'pdf',
            })],
        }));
        expect(store.createWorkload.mock.calls[0][0].prompt).toContain('This scheduled run is split into content generation followed by PDF export.');
    });

    test('falls back to the session model when creating a workload without an explicit model', async () => {
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            ownerId: 'phill',
            metadata: {
                model: 'gemini-3.1-pro-preview',
            },
        });
        store.createWorkload.mockResolvedValue({
            id: 'workload-session-model-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Review Repo Activity And Summarize',
            prompt: 'review repo activity and summarize blockers.',
            enabled: true,
            trigger: {
                type: 'cron',
                expression: '0 9 * * 1-5',
                timezone: 'America/Halifax',
            },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [],
            metadata: {
                requestedModel: 'gemini-3.1-pro-preview',
            },
        });
        store.enqueueRun.mockResolvedValue({
            id: 'run-session-model-1',
            workloadId: 'workload-session-model-1',
            scheduledFor: '2026-04-02T12:00:00.000Z',
            reason: 'cron',
            stageIndex: -1,
        });

        await service.createWorkload({
            sessionId: 'session-1',
            title: 'Review Repo Activity And Summarize',
            prompt: 'review repo activity and summarize blockers.',
            trigger: {
                type: 'cron',
                expression: '0 9 * * 1-5',
                timezone: 'America/Halifax',
            },
            metadata: {},
        }, 'phill');

        expect(store.createWorkload).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                requestedModel: 'gemini-3.1-pro-preview',
            }),
        }));
    });

    test('cleans up a newly-created scheduled workload if initial queueing fails', async () => {
        const workload = {
            id: 'workload-cleanup-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Check remote time',
            prompt: 'Run `date` on the server.',
            trigger: {
                type: 'once',
                runAt: '2026-04-02T09:05:00.000Z',
            },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [],
        };

        store.createWorkload.mockResolvedValue(workload);
        store.enqueueRun.mockResolvedValue(null);

        await expect(service.createWorkload({
            sessionId: 'session-1',
            title: 'Check remote time',
            prompt: 'Run `date` on the server.',
            trigger: {
                type: 'once',
                runAt: '2026-04-02T09:05:00.000Z',
            },
        }, 'phill')).rejects.toThrow('Failed to enqueue workload run.');

        expect(store.deleteWorkload).toHaveBeenCalledWith('workload-cleanup-1', 'phill');
    });

    test('pauses an admin workload using the stored owner id', async () => {
        const workload = {
            id: 'workload-admin-1',
            ownerId: 'ops-admin',
            sessionId: 'session-1',
            title: 'Nightly review',
            prompt: 'Review the queue.',
            enabled: true,
            trigger: { type: 'cron', expression: '0 2 * * *', timezone: 'UTC' },
        };

        store.getAdminWorkloadById.mockResolvedValue(workload);
        store.updateWorkload.mockResolvedValue({
            ...workload,
            enabled: false,
        });

        const paused = await service.pauseAdminWorkload('workload-admin-1');

        expect(store.getAdminWorkloadById).toHaveBeenCalledWith('workload-admin-1');
        expect(store.updateWorkload).toHaveBeenCalledWith('workload-admin-1', 'ops-admin', { enabled: false });
        expect(store.cancelQueuedRunsForWorkload).toHaveBeenCalledWith('workload-admin-1');
        expect(paused.enabled).toBe(false);
    });

    test('updates an admin workload using the stored owner id', async () => {
        const current = {
            id: 'workload-admin-edit-1',
            ownerId: 'ops-admin',
            sessionId: 'session-1',
            title: 'Nightly review',
            prompt: 'Review the queue.',
            enabled: true,
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [],
            metadata: {},
        };

        store.getAdminWorkloadById.mockResolvedValue(current);
        store.getWorkloadById.mockResolvedValue(current);
        store.updateWorkload.mockResolvedValue({
            ...current,
            prompt: 'Review the queue and flag failures.',
        });

        const updated = await service.updateAdminWorkload('workload-admin-edit-1', {
            prompt: 'Review the queue and flag failures.',
        });

        expect(store.getAdminWorkloadById).toHaveBeenCalledWith('workload-admin-edit-1');
        expect(store.getWorkloadById).toHaveBeenCalledWith('workload-admin-edit-1', 'ops-admin');
        expect(store.updateWorkload).toHaveBeenCalledWith(
            'workload-admin-edit-1',
            'ops-admin',
            expect.objectContaining({
                prompt: 'Review the queue and flag failures.',
            }),
        );
        expect(store.cancelPendingQueuedRunsForWorkload).toHaveBeenCalledWith('workload-admin-edit-1');
        expect(updated.prompt).toBe('Review the queue and flag failures.');
    });

    test('deletes an admin workload using the stored owner id', async () => {
        const workload = {
            id: 'workload-admin-2',
            ownerId: 'ops-admin',
            sessionId: 'session-1',
            title: 'Nightly review',
            prompt: 'Review the queue.',
            enabled: false,
            trigger: { type: 'cron', expression: '0 2 * * *', timezone: 'UTC' },
        };

        store.getAdminWorkloadById.mockResolvedValue(workload);
        store.getWorkloadById.mockResolvedValue(workload);
        store.deleteWorkload.mockResolvedValue(true);

        const deleted = await service.deleteAdminWorkload('workload-admin-2');

        expect(store.getAdminWorkloadById).toHaveBeenCalledWith('workload-admin-2');
        expect(store.getWorkloadById).toHaveBeenCalledWith('workload-admin-2', 'ops-admin');
        expect(store.deleteWorkload).toHaveBeenCalledWith('workload-admin-2', 'ops-admin');
        expect(deleted).toBe(true);
    });

    test('extracts structured execution when creating a workload from a remote scenario request', async () => {
        sessionStore.getOwned.mockResolvedValue({
            id: 'session-1',
            ownerId: 'phill',
            metadata: {
                lastSshTarget: {
                    host: '10.0.0.5',
                    username: 'ubuntu',
                    port: 22,
                },
            },
        });
        store.createWorkload.mockImplementation(async (payload) => ({
            id: 'workload-remote-created',
            ...payload,
        }));
        store.enqueueRun.mockResolvedValue({
            id: 'run-remote-created',
            workloadId: 'workload-remote-created',
            scheduledFor: '2026-04-02T09:05:00.000Z',
            reason: 'schedule',
            stageIndex: -1,
        });

        const created = await service.createWorkloadFromScenario(
            'session-1',
            'phill',
            'Run `date` on the server in 5 minutes.',
            {
                timezone: 'UTC',
                now: new Date('2026-04-02T09:00:00.000Z'),
            },
        );

        expect(store.createWorkload).toHaveBeenCalledWith(expect.objectContaining({
            execution: {
                tool: 'remote-command',
                params: {
                    host: '10.0.0.5',
                    username: 'ubuntu',
                    port: 22,
                    command: 'date',
                },
            },
            trigger: {
                type: 'once',
                runAt: '2026-04-02T09:05:00.000Z',
            },
        }));
        expect(created.workload.execution).toEqual({
            tool: 'remote-command',
            params: {
                host: '10.0.0.5',
                username: 'ubuntu',
                port: 22,
                command: 'date',
            },
        });
    });

    test('reuses the workload requested model when executing a deferred chat run', async () => {
        const workload = {
            id: 'workload-model-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Cluster breakdown',
            prompt: 'Gather information on the k3s cluster on the server.',
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'remote-build',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: true,
            },
            stages: [],
            metadata: {
                requestedModel: 'gemini-3.1-pro-preview',
            },
        };
        const run = {
            id: 'run-model-1',
            workload,
            stageIndex: -1,
            scheduledFor: '2026-04-01T09:00:00.000Z',
            prompt: workload.prompt,
            metadata: {},
        };

        conversationRunService.runChatTurn.mockResolvedValue({
            outputText: 'Cluster details collected.',
            response: { id: 'resp-model-1' },
            execution: { trace: { steps: 1 } },
            artifacts: [],
        });
        store.completeRun.mockResolvedValue({ id: 'run-model-1', status: 'completed' });
        store.enqueueRun.mockResolvedValue(null);

        await service.executeClaimedRun(run, 'worker-1');

        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            message: 'Gather information on the k3s cluster on the server.',
            model: 'gemini-3.1-pro-preview',
        }));
    });

    test('injects workload creation context into deferred chat runs', async () => {
        const workload = {
            id: 'workload-context-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Follow-up workload',
            prompt: 'Gather information on the k3s cluster on the server.',
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [],
            metadata: {
                creationContext: {
                    originalRequest: 'run it five minutes from now',
                    resolvedRequest: 'gather information on the k3s cluster on the server. run it five minutes from now',
                    recentMessages: [
                        { role: 'user', content: 'gather information on the k3s cluster on the server' },
                        { role: 'assistant', content: 'I can inspect pods, events, and recent logs.' },
                    ],
                    instruction: 'Use this recent chat context to resolve references before executing the workload.',
                },
            },
        };
        const run = {
            id: 'run-context-1',
            workload,
            stageIndex: -1,
            scheduledFor: '2026-04-01T09:00:00.000Z',
            prompt: workload.prompt,
            metadata: {},
        };

        conversationRunService.runChatTurn.mockResolvedValue({
            outputText: 'Cluster details collected.',
            response: { id: 'resp-context-1' },
            execution: { trace: { steps: 1 } },
            artifacts: [],
        });
        store.completeRun.mockResolvedValue({ id: 'run-context-1', status: 'completed' });
        store.enqueueRun.mockResolvedValue(null);

        await service.executeClaimedRun(run, 'worker-1');

        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('[Workload creation context]'),
        }));
        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Original scheduling request: run it five minutes from now'),
        }));
        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('assistant: I can inspect pods, events, and recent logs.'),
        }));
        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Current run objective:\nGather information on the k3s cluster on the server.'),
        }));
    });

    test('uses the workload default output format for the initial brutal builder pass', async () => {
        const workload = {
            id: 'workload-brutal-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Product Spec',
            prompt: 'Write the initial product spec.',
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [{
                when: 'on_success',
                delayMs: 600000,
                prompt: '[Brutal builder pass instructions]\nThis is pass 2 of 4.',
                outputFormat: 'pdf',
                metadata: {},
            }],
            metadata: {
                defaultOutputFormat: 'pdf',
                brutalBuilderEnabled: true,
            },
        };
        const run = {
            id: 'run-brutal-1',
            workload,
            stageIndex: -1,
            scheduledFor: '2026-04-01T09:00:00.000Z',
            prompt: workload.prompt,
            metadata: {},
        };

        conversationRunService.runChatTurn.mockResolvedValue({
            outputText: 'Initial spec created.',
            response: { id: 'resp-brutal-1' },
            execution: { trace: { steps: 1 } },
            artifacts: [{ id: 'artifact-1', filename: 'spec.pdf', mimeType: 'application/pdf' }],
        });
        store.completeRun.mockResolvedValue({ id: 'run-brutal-1', status: 'completed' });
        store.enqueueRun.mockResolvedValue({
            id: 'run-brutal-2',
            workloadId: 'workload-brutal-1',
            stageIndex: 0,
            reason: 'followup',
        });

        await service.executeClaimedRun(run, 'worker-1');

        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                outputFormat: 'pdf',
            }),
        }));
    });

    test('injects project plan context into long-running project runs and records a review snapshot', async () => {
        const workload = {
            id: 'workload-project-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Long project',
            mode: 'project',
            prompt: 'Implement the next approved milestone.',
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [],
            metadata: {
                projectMode: true,
                project: {
                    title: 'Long project',
                    objective: 'Build and deploy the long-running project.',
                    milestones: [{
                        id: 'm1',
                        title: 'Approve the rollout plan',
                        status: 'in_progress',
                        acceptanceCriteria: ['Stakeholder review completed'],
                    }],
                },
            },
        };
        const run = {
            id: 'run-project-1',
            workload,
            stageIndex: -1,
            scheduledFor: '2026-04-01T09:00:00.000Z',
            prompt: workload.prompt,
            metadata: {},
        };

        conversationRunService.runChatTurn.mockResolvedValue({
            outputText: 'Milestone reviewed and implementation work continued.',
            response: { id: 'resp-project-1' },
            execution: { trace: { steps: 1 } },
            artifacts: [],
        });
        store.completeRun.mockResolvedValue({ id: 'run-project-1', status: 'completed' });
        store.enqueueRun.mockResolvedValue(null);
        store.updateWorkload.mockResolvedValue({
            ...workload,
            metadata: {
                ...workload.metadata,
                project: {
                    ...workload.metadata.project,
                    reviewHistory: [{
                        id: 'review-1',
                        runId: 'run-project-1',
                        reviewedAt: '2026-04-01T09:00:00.000Z',
                        milestoneId: 'm1',
                        status: 'completed',
                        summary: 'Milestone reviewed and implementation work continued.',
                        stageIndex: -1,
                        artifactIds: [],
                    }],
                },
            },
        });

        await service.executeClaimedRun(run, 'worker-1');

        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('<project_mode>'),
        }));
        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Approve the rollout plan [in_progress]'),
        }));
        expect(store.updateWorkload).toHaveBeenCalledWith('workload-project-1', 'phill', expect.objectContaining({
            metadata: expect.objectContaining({
                projectMode: true,
                project: expect.objectContaining({
                    reviewHistory: expect.any(Array),
                }),
            }),
        }));
    });

    test('long agent mode records evaluator events and queues the next obvious step', async () => {
        const workload = {
            id: 'workload-long-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Long skill work',
            mode: 'project',
            prompt: 'Improve the agent loop.',
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 6,
                maxToolCalls: 18,
                maxDurationMs: 300000,
                allowSideEffects: false,
            },
            stages: [],
            metadata: {
                longAgent: {
                    enabled: true,
                    goal: 'Improve the agent loop.',
                    scratchFile: '.kimibuilt/long-agent-scratch.md',
                    maxAutoSteps: 3,
                },
            },
        };
        const run = {
            id: 'run-long-1',
            workload,
            stageIndex: -1,
            scheduledFor: '2026-04-01T09:00:00.000Z',
            prompt: workload.prompt,
            metadata: {
                longAgentStep: 1,
            },
        };

        conversationRunService.runChatTurn.mockResolvedValue({
            outputText: [
                'Implemented the first slice.',
                '',
                'Stage scratch summary',
                'Done: mapped the runtime path.',
                'Verification: focused test passed.',
                'Next obvious step: add UI activation.',
            ].join('\n'),
            response: { id: 'resp-long-1' },
            execution: { trace: { steps: 1 } },
            artifacts: [],
        });
        store.completeRun.mockResolvedValue({ id: 'run-long-1', status: 'completed' });
        store.updateWorkload.mockResolvedValue({
            ...workload,
            metadata: {
                ...workload.metadata,
                longAgent: {
                    ...workload.metadata.longAgent,
                    lastScratchSummary: 'Done: mapped the runtime path.',
                },
            },
        });
        store.enqueueRun.mockResolvedValueOnce({
            id: 'run-long-2',
            workloadId: workload.id,
            reason: 'long-agent-next-step',
            stageIndex: -1,
            scheduledFor: '2026-04-01T09:00:01.000Z',
        });

        await service.executeClaimedRun(run, 'worker-1');

        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('<long_agent_mode>'),
        }));
        expect(store.addRunEvent).toHaveBeenCalledWith('run-long-1', 'long-agent-evaluator', expect.objectContaining({
            evaluation: expect.objectContaining({
                decision: 'next_step',
                scratchFile: '.kimibuilt/long-agent-scratch.md',
            }),
        }));
        expect(store.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'long-agent-next-step',
            parentRunId: 'run-long-1',
            metadata: expect.objectContaining({
                longAgentStep: 2,
            }),
            prompt: expect.stringContaining('Next obvious step: add UI activation.'),
        }));
    });

    test('long agent mode queues an automatic review after blocked output', async () => {
        const workload = {
            id: 'workload-long-review',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Long review work',
            mode: 'project',
            prompt: 'Finish the feature.',
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 6,
                maxToolCalls: 18,
                maxDurationMs: 300000,
                allowSideEffects: false,
            },
            stages: [],
            metadata: {
                longAgent: {
                    enabled: true,
                    goal: 'Finish the feature.',
                    scratchFile: 'scratch.md',
                    maxAutoSteps: 3,
                },
            },
        };
        const run = {
            id: 'run-long-review-1',
            workload,
            stageIndex: -1,
            scheduledFor: '2026-04-01T09:00:00.000Z',
            prompt: workload.prompt,
            metadata: {
                longAgentStep: 1,
            },
        };

        conversationRunService.runChatTurn.mockResolvedValue({
            outputText: 'Stage scratch summary\nBlocked: tests failing and needs review.\nNext obvious step: repair the failing assertion.',
            response: { id: 'resp-long-review-1' },
            execution: { trace: { steps: 1 } },
            artifacts: [],
        });
        store.completeRun.mockResolvedValue({ id: 'run-long-review-1', status: 'completed' });
        store.updateWorkload.mockResolvedValue(workload);
        store.enqueueRun.mockResolvedValueOnce({
            id: 'run-long-review-2',
            workloadId: workload.id,
            reason: 'long-agent-review',
            stageIndex: -1,
        });

        await service.executeClaimedRun(run, 'worker-1');

        expect(store.addRunEvent).toHaveBeenCalledWith('run-long-review-1', 'long-agent-evaluator', expect.objectContaining({
            evaluation: expect.objectContaining({
                decision: 'review',
                needsReview: true,
            }),
        }));
        expect(store.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'long-agent-review',
            prompt: expect.stringContaining('previous agent stage stopped with a review-needed signal'),
        }));
    });

    test('enqueues the first follow-up stage after a successful base run', async () => {
        const workload = {
            id: 'workload-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Investigate and retry',
            prompt: 'Inspect the current issue.',
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [
                {
                    when: 'on_success',
                    delayMs: 0,
                    prompt: 'Post a shorter summary.',
                    metadata: {},
                },
            ],
        };
        const run = {
            id: 'run-1',
            workload,
            stageIndex: -1,
            scheduledFor: '2026-04-01T09:00:00.000Z',
            prompt: workload.prompt,
        };

        conversationRunService.runChatTurn.mockResolvedValue({
            outputText: 'Initial investigation completed.',
            response: { id: 'resp-1' },
            execution: { trace: { steps: 1 } },
        });
        store.completeRun.mockResolvedValue({ id: 'run-1', status: 'completed' });
        store.enqueueRun.mockResolvedValue({
            id: 'run-2',
            workloadId: 'workload-1',
            stageIndex: 0,
            reason: 'followup',
        });

        await service.executeClaimedRun(run, 'worker-1');

        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            message: 'Inspect the current issue.',
        }));
        expect(store.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({
            workloadId: 'workload-1',
            reason: 'followup',
            stageIndex: 0,
            parentRunId: 'run-1',
            prompt: 'Post a shorter summary.',
        }));
        expect(store.addRunEvent).toHaveBeenCalledWith('run-1', 'followup-enqueued', expect.objectContaining({
            followupRunId: 'run-2',
            stageIndex: 0,
        }));
    });

    test('schedules follow-up stages from the prior scheduled slot instead of completion time', async () => {
        jest.useFakeTimers();
        try {
            jest.setSystemTime(new Date('2026-04-01T09:25:00.000Z'));

            const workload = {
                id: 'workload-cadence-1',
                ownerId: 'phill',
                sessionId: 'session-1',
                title: 'Brutal builder cadence',
                prompt: 'Create the first pass.',
                trigger: { type: 'manual' },
                policy: {
                    executionProfile: 'default',
                    toolIds: [],
                    maxRounds: 3,
                    maxToolCalls: 10,
                    maxDurationMs: 120000,
                    allowSideEffects: false,
                },
                stages: [
                    {
                        when: 'on_success',
                        delayMs: 10 * 60 * 1000,
                        prompt: 'Revise the prior pass.',
                        metadata: {},
                    },
                ],
            };
            const run = {
                id: 'run-cadence-1',
                workload,
                stageIndex: -1,
                scheduledFor: '2026-04-01T09:00:00.000Z',
                prompt: workload.prompt,
            };

            conversationRunService.runChatTurn.mockResolvedValue({
                outputText: 'First pass done.',
                response: { id: 'resp-cadence-1' },
                execution: { trace: { steps: 1 } },
            });
            store.completeRun.mockResolvedValue({ id: 'run-cadence-1', status: 'completed' });
            store.enqueueRun.mockResolvedValue({
                id: 'run-cadence-2',
                workloadId: 'workload-cadence-1',
                stageIndex: 0,
                reason: 'followup',
            });

            await service.executeClaimedRun(run, 'worker-1');

            expect(store.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({
                reason: 'followup',
                stageIndex: 0,
                scheduledFor: new Date('2026-04-01T09:25:00.000Z'),
            }));
        } finally {
            jest.useRealTimers();
        }
    });

    test('passes prior stage output into the next stage and narrows tool usage', async () => {
        const workload = {
            id: 'workload-2',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Morning cluster routine',
            prompt: 'Gather cluster details from the server.',
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'default',
                toolIds: ['web-search'],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [
                {
                    when: 'on_success',
                    delayMs: 0,
                    prompt: 'Turn the gathered facts into a concise review plan.',
                    inputFrom: ['cluster.facts'],
                    toolIds: ['file-write'],
                    outputKey: 'cluster.plan',
                    metadata: {},
                },
            ],
        };
        const run = {
            id: 'run-2',
            workload,
            stageIndex: 0,
            scheduledFor: '2026-04-01T09:02:00.000Z',
            parentRunId: 'run-1',
            prompt: workload.stages[0].prompt,
            metadata: {
                parentRunId: 'run-1',
            },
        };

        store.getRunById.mockResolvedValue({
            id: 'run-1',
            parentRunId: null,
            metadata: {
                outputKey: 'cluster.facts',
                output: {
                    text: 'Nodes: 3\nPods: 18\nWarnings: 1 CrashLoopBackOff',
                    artifacts: [],
                },
            },
        });
        conversationRunService.runChatTurn.mockResolvedValue({
            outputText: 'Review plan ready.',
            response: { id: 'resp-2' },
            execution: { trace: { steps: 2 } },
            artifacts: [],
        });
        store.completeRun.mockResolvedValue({ id: 'run-2', status: 'completed' });
        store.enqueueRun.mockResolvedValue(null);

        await service.executeClaimedRun(run, 'worker-1');

        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Turn the gathered facts into a concise review plan.'),
            requestedToolIds: ['file-write'],
        }));
        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('[cluster.facts]'),
        }));
        expect(conversationRunService.runChatTurn).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('CrashLoopBackOff'),
        }));
        expect(store.completeRun).toHaveBeenCalledWith('run-2', 'worker-1', expect.objectContaining({
            metadata: expect.objectContaining({
                outputKey: 'cluster.plan',
                output: expect.objectContaining({
                    text: 'Review plan ready.',
                }),
            }),
        }));
    });

    test('creates an artifact-only follow-up stage from prior stage output', async () => {
        const workload = {
            id: 'workload-3',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Morning report',
            prompt: 'Gather facts.',
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [
                {
                    when: 'on_success',
                    delayMs: 0,
                    inputFrom: ['cluster.plan'],
                    outputFormat: 'pdf',
                    metadata: {},
                },
            ],
        };
        const run = {
            id: 'run-3',
            workload,
            stageIndex: 0,
            scheduledFor: '2026-04-01T09:05:00.000Z',
            parentRunId: 'run-2',
            prompt: '',
            metadata: {
                parentRunId: 'run-2',
            },
        };

        store.getRunById.mockResolvedValue({
            id: 'run-2',
            parentRunId: null,
            metadata: {
                outputKey: 'cluster.plan',
                output: {
                    text: 'Cluster review plan\n\n- Check nodes\n- Check pods',
                    artifacts: [],
                },
            },
        });
        conversationRunService.createArtifactFromContent = jest.fn(async () => ({
            outputText: 'Cluster review plan\n\n- Check nodes\n- Check pods',
            artifacts: [{ id: 'artifact-1', filename: 'cluster-report.pdf' }],
            artifactMessage: 'Created the PDF artifact (cluster-report.pdf).',
        }));
        store.completeRun.mockResolvedValue({ id: 'run-3', status: 'completed' });
        store.enqueueRun.mockResolvedValue(null);

        await service.executeClaimedRun(run, 'worker-1');

        expect(conversationRunService.createArtifactFromContent).toHaveBeenCalledWith(expect.objectContaining({
            outputFormat: 'pdf',
            content: expect.stringContaining('Cluster review plan'),
        }));
        expect(store.completeRun).toHaveBeenCalledWith('run-3', 'worker-1', expect.objectContaining({
            metadata: expect.objectContaining({
                output: expect.objectContaining({
                    artifacts: [{ id: 'artifact-1', filename: 'cluster-report.pdf', mimeType: null }],
                }),
            }),
        }));
    });

    test('schedules the next cron slot after a failed run', async () => {
        const workload = {
            id: 'workload-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Daily brief',
            prompt: 'Summarize the latest changes.',
            trigger: {
                type: 'cron',
                expression: '0 9 * * *',
                timezone: 'UTC',
            },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [],
        };
        const run = {
            id: 'run-1',
            workload,
            stageIndex: -1,
            scheduledFor: '2026-04-01T09:00:00.000Z',
            prompt: workload.prompt,
        };

        conversationRunService.runChatTurn.mockRejectedValue(new Error('LLM timeout'));
        store.failRun.mockResolvedValue({ id: 'run-1', status: 'failed' });
        store.enqueueRun.mockResolvedValue({
            id: 'run-2',
            workloadId: 'workload-1',
            reason: 'cron',
            stageIndex: -1,
        });

        await service.executeClaimedRun(run, 'worker-1');

        expect(store.failRun).toHaveBeenCalledWith('run-1', 'worker-1', expect.objectContaining({
            error: { message: 'LLM timeout' },
        }));
        expect(store.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({
            workloadId: 'workload-1',
            reason: 'cron',
            stageIndex: -1,
        }));
    });

    test('does not rebroadcast a once workload as queued when enqueue returns an existing completed run', async () => {
        const workload = {
            id: 'workload-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Check remote time',
            prompt: 'Run `date` on the server.',
            trigger: {
                type: 'once',
                runAt: '2026-04-01T09:05:00.000Z',
            },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [],
        };
        const run = {
            id: 'run-1',
            workload,
            stageIndex: -1,
            scheduledFor: '2026-04-01T09:05:00.000Z',
            prompt: workload.prompt,
        };

        conversationRunService.runChatTurn.mockResolvedValue({
            response: { id: 'resp-1', metadata: {} },
            outputText: 'ok',
            execution: { trace: {} },
        });
        store.completeRun.mockResolvedValue({ id: 'run-1', status: 'completed' });
        store.enqueueRun.mockResolvedValue({
            id: 'run-1',
            workloadId: 'workload-1',
            status: 'completed',
            reason: 'schedule',
            stageIndex: -1,
        });

        await service.executeClaimedRun(run, 'worker-1');

        expect(store.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({
            workloadId: 'workload-1',
            reason: 'schedule',
            stageIndex: -1,
        }));
        expect(store.addRunEvent).not.toHaveBeenCalledWith('run-1', 'queued', expect.anything());
    });

    test('executes a structured remote command directly when present', async () => {
        const workload = {
            id: 'workload-remote-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Check remote time',
            prompt: 'Run `date` on the server.',
            execution: {
                tool: 'remote-command',
                params: {
                    host: '10.0.0.5',
                    username: 'ubuntu',
                    port: 22,
                    command: 'date',
                },
            },
            trigger: {
                type: 'once',
                runAt: '2026-04-01T09:05:00.000Z',
            },
            policy: {
                executionProfile: 'default',
                toolIds: [],
                maxRounds: 3,
                maxToolCalls: 10,
                maxDurationMs: 120000,
                allowSideEffects: false,
            },
            stages: [],
        };
        const run = {
            id: 'run-remote-1',
            workload,
            stageIndex: -1,
            scheduledFor: '2026-04-01T09:05:00.000Z',
            prompt: workload.prompt,
        };

        conversationRunService.runStructuredExecution.mockResolvedValue({
            outputText: 'SSH command completed on 10.0.0.5:22.\n\nSTDOUT:\nWed Apr 1 09:05:00 UTC 2026',
        });
        store.completeRun.mockResolvedValue({ id: 'run-remote-1', status: 'completed' });

        await service.executeClaimedRun(run, 'worker-1');

        expect(conversationRunService.runStructuredExecution).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            execution: workload.execution,
        }));
        expect(conversationRunService.runChatTurn).not.toHaveBeenCalled();
        expect(store.completeRun).toHaveBeenCalledWith('run-remote-1', 'worker-1', expect.objectContaining({
            trace: expect.objectContaining({
                structuredExecution: true,
                toolId: 'remote-command',
            }),
        }));
    });

    test('updates a project plan only when the workload exists', async () => {
        store.getWorkloadById.mockResolvedValue({
            id: 'workload-project-2',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Long project',
            prompt: 'Implement the next approved milestone.',
            mode: 'project',
            metadata: {
                projectMode: true,
                project: {
                    title: 'Long project',
                    objective: 'Build and deploy the long-running project.',
                    milestones: [{
                        id: 'm1',
                        title: 'Approve the rollout plan',
                        status: 'planned',
                    }],
                },
            },
        });
        store.updateWorkload.mockResolvedValue({
            id: 'workload-project-2',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Long project',
            prompt: 'Implement the next approved milestone.',
            mode: 'project',
            metadata: {
                projectMode: true,
                project: {
                    title: 'Long project',
                    objective: 'Build and deploy the long-running project.',
                    milestones: [{
                        id: 'm1',
                        title: 'Approve the rollout plan',
                        status: 'completed',
                    }],
                },
            },
        });

        const updated = await service.updateProjectPlan('workload-project-2', 'phill', {
            milestones: [{
                id: 'm1',
                title: 'Approve the rollout plan',
                status: 'completed',
            }],
        }, {
            changeReason: {
                type: 'status_update',
                summary: 'Marked the first milestone complete.',
            },
        });

        expect(updated).toEqual(expect.objectContaining({
            project: expect.objectContaining({
                milestones: [expect.objectContaining({ status: 'completed' })],
            }),
        }));
    });

    test('spawns sub-agents with inherited caller model and depth guard metadata', async () => {
        const createWorkload = jest.spyOn(service, 'createWorkload')
            .mockImplementation(async (payload, ownerId) => ({
                id: `${payload.title.toLowerCase().replace(/\s+/g, '-')}-workload`,
                ownerId,
                sessionId: payload.sessionId,
                title: payload.title,
                prompt: payload.prompt,
                mode: payload.mode,
                execution: payload.execution || null,
                enabled: true,
                trigger: { type: 'manual' },
                policy: payload.policy,
                stages: [],
                metadata: payload.metadata,
            }));
        const runWorkloadNow = jest.spyOn(service, 'runWorkloadNow')
            .mockImplementation(async (idOrSlug) => ({
                id: `${idOrSlug}-run`,
                workloadId: idOrSlug,
                status: 'queued',
            }));
        jest.spyOn(service, 'listActiveSubAgentTasks').mockResolvedValue([]);

        const result = await service.spawnSubAgents({
            title: 'Parallel batch',
            tasks: [{
                title: 'Research facts',
                prompt: 'Research the latest release notes and save a summary.',
                writeTargets: ['notes/research.md'],
            }, {
                title: 'Compute totals',
                prompt: 'Calculate the totals for the provided figures.',
            }],
        }, 'phill', {
            sessionId: 'session-1',
            model: 'gpt-5.4',
        });

        expect(result.taskCount).toBe(2);
        expect(createWorkload).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Research facts',
            metadata: expect.objectContaining({
                requestedModel: 'gpt-5.4',
                subAgent: expect.objectContaining({
                    orchestrationId: result.orchestrationId,
                    depth: 1,
                    callerModel: 'gpt-5.4',
                    writeTargets: ['notes/research.md'],
                }),
            }),
        }), 'phill');
        expect(runWorkloadNow).toHaveBeenCalledWith(expect.any(String), 'phill', expect.objectContaining({
            reason: 'sub-agent',
            metadata: expect.objectContaining({
                orchestrationId: result.orchestrationId,
                subAgentDepth: 1,
            }),
        }));
    });

    test('rejects nested sub-agent spawning from a child task', async () => {
        await expect(service.spawnSubAgents({
            tasks: [{
                title: 'Nested attempt',
                prompt: 'Do another delegated task.',
            }],
        }, 'phill', {
            sessionId: 'session-1',
            model: 'gpt-5.4',
            subAgentDepth: 1,
        })).rejects.toThrow('Sub-agents cannot spawn more sub-agents.');
    });

    test('rejects overlapping write targets against active sub-agents', async () => {
        jest.spyOn(service, 'listActiveSubAgentTasks').mockResolvedValue([{
            title: 'Active child',
            writeTargets: ['frontend/index.html'],
            lockKey: '',
            active: true,
        }]);

        await expect(service.spawnSubAgents({
            tasks: [{
                title: 'HTML writer',
                prompt: 'Rewrite the current homepage.',
                writeTargets: ['frontend/index.html'],
            }],
        }, 'phill', {
            sessionId: 'session-1',
            model: 'gpt-5.4',
        })).rejects.toThrow('write target conflict');
    });

    test('retries retryable sub-agent failures with a queued follow-up run', async () => {
        const workload = {
            id: 'subagent-workload-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Research pass',
            prompt: 'Research the topic and write the summary.',
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'default',
                toolIds: ['web-search', 'file-write'],
                maxRounds: 4,
                maxToolCalls: 12,
                maxDurationMs: 180000,
                allowSideEffects: true,
            },
            stages: [],
            metadata: {
                requestedModel: 'gpt-5.4',
                subAgent: {
                    enabled: true,
                    orchestrationId: 'subagent-1',
                    depth: 1,
                    maxRetries: 2,
                    writeTargets: ['notes/research.md'],
                },
            },
        };
        const run = {
            id: 'run-subagent-1',
            workload,
            stageIndex: -1,
            attempt: 0,
            scheduledFor: '2026-04-01T09:00:00.000Z',
            prompt: workload.prompt,
            metadata: {
                subAgentDepth: 1,
            },
        };
        const rateLimitError = new Error('Rate limit exceeded.');
        rateLimitError.status = 429;

        conversationRunService.runChatTurn.mockRejectedValue(rateLimitError);
        store.failRun.mockResolvedValue({ id: run.id, status: 'failed' });
        store.enqueueRun.mockResolvedValue({
            id: 'run-subagent-2',
            workloadId: workload.id,
            status: 'queued',
            scheduledFor: '2026-04-01T09:00:15.000Z',
        });

        await service.executeClaimedRun(run, 'worker-1');

        expect(store.failRun).toHaveBeenCalledWith(run.id, 'worker-1', expect.objectContaining({
            error: expect.objectContaining({
                classification: 'rate_limit',
            }),
        }));
        expect(store.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({
            workloadId: workload.id,
            reason: 'retry',
            attempt: 1,
            parentRunId: run.id,
        }));
        expect(store.addRunEvent).toHaveBeenCalledWith(run.id, 'retry-enqueued', expect.objectContaining({
            retryRunId: 'run-subagent-2',
            classification: 'rate_limit',
        }));
    });

    test('retries provider rate limit code failures without an HTTP status', async () => {
        const workload = {
            id: 'subagent-workload-rate-code',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Research pass',
            prompt: 'Research the topic and write the summary.',
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'default',
                toolIds: ['web-search', 'file-write'],
                maxRounds: 4,
                maxToolCalls: 12,
                maxDurationMs: 180000,
                allowSideEffects: true,
            },
            stages: [],
            metadata: {
                requestedModel: 'gpt-5.4',
                subAgent: {
                    enabled: true,
                    orchestrationId: 'subagent-rate-code',
                    depth: 1,
                    maxRetries: 2,
                },
            },
        };
        const run = {
            id: 'run-subagent-rate-code-1',
            workload,
            stageIndex: -1,
            attempt: 0,
            scheduledFor: '2026-04-01T09:00:00.000Z',
            prompt: workload.prompt,
            metadata: {
                subAgentDepth: 1,
            },
        };
        const rateLimitError = new Error('Provider throttled the request.');
        rateLimitError.code = 'rate_limit_exceeded';

        conversationRunService.runChatTurn.mockRejectedValue(rateLimitError);
        store.failRun.mockResolvedValue({ id: run.id, status: 'failed' });
        store.enqueueRun.mockResolvedValue({
            id: 'run-subagent-rate-code-2',
            workloadId: workload.id,
            status: 'queued',
            scheduledFor: '2026-04-01T09:00:15.000Z',
        });

        await service.executeClaimedRun(run, 'worker-1');

        expect(store.failRun).toHaveBeenCalledWith(run.id, 'worker-1', expect.objectContaining({
            error: expect.objectContaining({
                classification: 'rate_limit',
            }),
        }));
        expect(store.enqueueRun).toHaveBeenCalledWith(expect.objectContaining({
            workloadId: workload.id,
            reason: 'retry',
            attempt: 1,
            parentRunId: run.id,
        }));
        expect(store.addRunEvent).toHaveBeenCalledWith(run.id, 'retry-enqueued', expect.objectContaining({
            retryRunId: 'run-subagent-rate-code-2',
            classification: 'rate_limit',
        }));
    });

    test('does not retry terminal sub-agent model or billing failures', async () => {
        const workload = {
            id: 'subagent-workload-terminal',
            ownerId: 'phill',
            sessionId: 'session-1',
            title: 'Website pass',
            prompt: 'Build the HTML page.',
            trigger: { type: 'manual' },
            policy: {
                executionProfile: 'default',
                toolIds: ['file-write'],
                maxRounds: 4,
                maxToolCalls: 12,
                maxDurationMs: 180000,
                allowSideEffects: true,
            },
            stages: [],
            metadata: {
                requestedModel: 'gpt-5.4',
                subAgent: {
                    enabled: true,
                    orchestrationId: 'subagent-2',
                    depth: 1,
                    maxRetries: 2,
                },
            },
        };
        const run = {
            id: 'run-subagent-terminal-1',
            workload,
            stageIndex: -1,
            attempt: 0,
            scheduledFor: '2026-04-01T09:00:00.000Z',
            prompt: workload.prompt,
            metadata: {
                subAgentDepth: 1,
            },
        };
        const billingError = new Error('insufficient_quota for model run');
        billingError.status = 402;

        conversationRunService.runChatTurn.mockRejectedValue(billingError);
        store.failRun.mockResolvedValue({ id: run.id, status: 'failed' });
        store.enqueueRun.mockResolvedValue(null);

        await service.executeClaimedRun(run, 'worker-1');

        expect(store.failRun).toHaveBeenCalledWith(run.id, 'worker-1', expect.objectContaining({
            error: expect.objectContaining({
                classification: 'terminal_model_error',
            }),
        }));
        expect(store.addRunEvent).not.toHaveBeenCalledWith(run.id, 'retry-enqueued', expect.anything());
    });
});
