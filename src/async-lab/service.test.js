'use strict';

const { AsyncLabService } = require('./service');
const { AsyncLabStore } = require('./store');
const { ValkeyLiveBus } = require('./valkey-live-bus');

function createService(overrides = {}) {
    const store = overrides.store || new AsyncLabStore({ persistToPostgres: false });
    const bus = overrides.bus || new ValkeyLiveBus({});
    const instanceId = overrides.instanceId || 'test-async-lab';
    const toolManager = overrides.toolManager || null;
    const toolExecutionContext = overrides.toolExecutionContext || {};
    delete overrides.store;
    delete overrides.bus;
    delete overrides.instanceId;
    delete overrides.toolManager;
    delete overrides.toolExecutionContext;

    return new AsyncLabService({
        config: {
            enabled: true,
            mode: 'lab',
            namespace: 'kimibuilt-async-lab',
            surface: 'async-lab',
            workerEnabled: false,
            simulationDelayMs: 0,
            lockRetryMs: 5,
            maxLockWaitMs: 40,
            leaseTtlMs: 1000,
            allowLiveRemote: false,
            persistToPostgres: false,
            ...overrides,
        },
        store,
        bus,
        instanceId,
        toolManager,
        toolExecutionContext,
    });
}

describe('AsyncLabService', () => {
    test('rejects run creation when disabled', async () => {
        const service = createService({ enabled: false });

        await expect(service.createRun({ task: 'nope' }, 'tester')).rejects.toMatchObject({
            statusCode: 404,
        });
    });

    test('applies admin control without enabling live remote unless env permits it', async () => {
        const service = createService({
            enabled: false,
            adminToggleAllowed: true,
            allowLiveRemote: false,
        });

        const enabled = await service.applyControlConfig({
            enabled: true,
            allowLiveRemote: true,
            workerEnabled: false,
        });

        expect(enabled).toEqual(expect.objectContaining({
            active: true,
            enabled: true,
        }));
        expect(service.getStatus()).toEqual(expect.objectContaining({
            enabled: true,
            adminToggleAllowed: true,
            allowLiveRemote: false,
            workerRunning: false,
        }));

        const disabled = await service.applyControlConfig({ enabled: false });
        expect(disabled).toEqual(expect.objectContaining({
            active: false,
            enabled: false,
            reason: 'disabled',
        }));
        expect(service.isEnabled()).toBe(false);
    });

    test('creates lab-tagged runs and keeps remote adapters dry-run by default', async () => {
        const service = createService();
        const created = await service.createRun({
            task: 'ship a remote change',
            adapter: 'remote-cli-agent',
            targetKey: 'host/prod',
            liveRemote: true,
        }, 'tester');

        expect(created.run.runtimeSurface).toBe('async-lab');
        expect(created.run.status).toBe('queued');
        expect(created.run.liveRemoteRequested).toBe(true);
        expect(created.run.liveRemoteAllowed).toBe(false);
        expect(created.run.metadata.dryRun).toBe(true);

        await service.drainQueue();
        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);

        expect(run.status).toBe('completed');
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
            'queued',
            'started',
            'safety',
            'tool_message',
            'checkpoint',
            'completed',
        ]));
        expect(events.find((event) => event.type === 'safety').payload.dryRun).toBe(true);
    });

    test('executes approved live remote adapters through the attached tool manager', async () => {
        const executeTool = jest.fn(async () => ({
            success: true,
            data: {
                message: 'remote command observed',
                stdout: 'ok',
            },
            duration: 25,
            toolId: 'remote-command',
            verification: {
                status: 'observed',
                evidence: 'fake tool result',
            },
        }));
        const managedAppService = { id: 'managed-app-service' };
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
            toolExecutionContext: {
                managedAppService,
            },
        });
        const created = await service.createRun({
            task: 'hostname',
            adapter: 'remote-command',
            targetKey: 'primary/main-server',
            liveRemote: true,
            metadata: {
                toolParams: {
                    command: 'hostname',
                    targetId: 'primary',
                },
            },
        }, 'tester');

        await service.drainQueue();

        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);
        expect(run.status).toBe('completed');
        expect(run.metadata.toolResult).toEqual(expect.objectContaining({
            adapter: 'remote-command',
            success: true,
            durationMs: 25,
        }));
        expect(executeTool).toHaveBeenCalledWith(
            'remote-command',
            expect.objectContaining({
                command: 'hostname',
                targetId: 'primary',
            }),
            expect.objectContaining({
                route: '/api/async-lab',
                transport: 'async-runtime',
                executionProfile: 'async-runtime',
                ownerId: 'tester',
                managedAppService,
            }),
        );
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
            'tool_started',
            'tool_completed',
            'completed',
        ]));
        expect(events.find((event) => event.type === 'completed').payload.toolExecuted).toBe(true);
    });

    test('records a skipped live adapter when no tool manager is attached', async () => {
        const service = createService({ allowLiveRemote: true });
        const created = await service.createRun({
            task: 'hostname',
            adapter: 'remote-command',
            targetKey: 'primary/main-server',
            liveRemote: true,
        }, 'tester');

        await service.drainQueue();

        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);
        expect(run.status).toBe('completed');
        expect(run.metadata.toolResult).toBeUndefined();
        expect(events.map((event) => event.type)).toContain('tool_skipped');
        expect(events.find((event) => event.type === 'completed').payload.toolExecuted).toBe(false);
    });

    test('executes document workflow runs without live remote permission', async () => {
        const executeTool = jest.fn(async () => ({
            success: true,
            toolId: 'document-workflow',
            duration: 31,
            data: {
                message: 'document generated',
            },
        }));
        const service = createService({
            toolManager: { executeTool },
            toolExecutionContext: {
                documentService: { id: 'document-service' },
            },
        });
        const created = await service.createRun({
            task: 'Create a deployment report.',
            adapter: 'document-workflow',
            targetKey: 'artifact/session-1/html',
            metadata: {
                outputFormat: 'html',
                toolParams: {
                    action: 'generate',
                    prompt: 'Create a deployment report.',
                    format: 'html',
                    buildMode: 'sandbox',
                },
            },
        }, 'tester');

        await service.drainQueue();

        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);
        expect(run.status).toBe('completed');
        expect(run.metadata.toolResult).toEqual(expect.objectContaining({
            adapter: 'document-workflow',
            success: true,
            durationMs: 31,
        }));
        expect(executeTool).toHaveBeenCalledWith(
            'document-workflow',
            expect.objectContaining({
                action: 'generate',
                prompt: 'Create a deployment report.',
                format: 'html',
            }),
            expect.objectContaining({
                route: '/api/async-lab',
                transport: 'async-runtime',
                documentService: expect.objectContaining({ id: 'document-service' }),
            }),
        );
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
            'tool_started',
            'tool_completed',
            'completed',
        ]));
    });

    test('marks live adapter runs failed when tool execution returns an error', async () => {
        const executeTool = jest.fn(async () => ({
            success: false,
            error: 'remote failed',
            duration: 12,
            toolId: 'remote-command',
        }));
        const service = createService({
            allowLiveRemote: true,
            toolManager: { executeTool },
        });
        const created = await service.createRun({
            task: 'exit 1',
            adapter: 'remote-command',
            targetKey: 'primary/main-server',
            liveRemote: true,
        }, 'tester');

        await service.drainQueue();

        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);
        expect(run.status).toBe('failed');
        expect(run.metadata.failure).toBe('remote failed');
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
            'tool_started',
            'tool_failed',
            'failed',
        ]));
    });

    test('returns the existing run for duplicate idempotency keys', async () => {
        const service = createService();
        const first = await service.createRun({
            task: 'repeatable command',
            adapter: 'dry-run',
            idempotencyKey: 'same-command',
        }, 'tester');
        const second = await service.createRun({
            task: 'repeatable command',
            adapter: 'dry-run',
            idempotencyKey: 'same-command',
        }, 'tester');

        expect(second.duplicate).toBe(true);
        expect(second.run.id).toBe(first.run.id);
    });

    test('queues managed-app follow-up work from successful build webhooks', async () => {
        const service = createService({ allowLiveRemote: true });

        const result = await service.handleBuildWebhook({
            project: { path_with_namespace: 'agent-apps/demo-site' },
            object_attributes: {
                id: 42,
                status: 'success',
                sha: 'abc123',
            },
            imageTag: 'sha-abc123',
        }, {
            ownerId: 'tester',
            followUp: 'managed-app-verify',
            externalRunId: 'pipeline-42',
        });

        expect(result.run.adapter).toBe('build-webhook-copy');
        expect(result.followUp.run).toEqual(expect.objectContaining({
            adapter: 'managed-app',
            targetKey: 'managed-app:demo-site',
            liveRemoteRequested: true,
            liveRemoteAllowed: true,
        }));
        expect(result.followUp.run.metadata.toolParams).toEqual(expect.objectContaining({
            action: 'verify',
            appRef: 'demo-site',
            imageTag: 'sha-abc123',
            runId: 'pipeline-42',
        }));
    });

    test('replays events after a cursor', async () => {
        const service = createService();
        const created = await service.createRun({
            task: 'cursor replay',
            adapter: 'dry-run',
        }, 'tester');
        await service.drainQueue();

        const allEvents = await service.listEvents(created.run.id, 0);
        const afterQueued = await service.listEvents(created.run.id, allEvents[0].cursor);

        expect(allEvents.length).toBeGreaterThan(3);
        expect(afterQueued[0].cursor).toBeGreaterThan(allEvents[0].cursor);
        expect(afterQueued.some((event) => event.type === 'queued')).toBe(false);
    });

    test('cancels queued runs without executing them', async () => {
        const service = createService();
        const created = await service.createRun({
            task: 'cancel me',
            adapter: 'dry-run',
        }, 'tester');

        const cancelled = await service.cancelRun(created.run.id, 'tester');
        await service.drainQueue();
        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);

        expect(cancelled.changed).toBe(true);
        expect(run.status).toBe('cancelled');
        expect(events.map((event) => event.type)).toContain('cancelled');
        expect(events.map((event) => event.type)).not.toContain('started');
    });

    test('fails instead of stomping a locked target', async () => {
        const service = createService();
        const created = await service.createRun({
            task: 'needs target lock',
            adapter: 'managed-app',
            targetKey: 'app/demo',
        }, 'tester');

        await service.bus.acquireLock('target:app/demo', 'other-worker', 1000);
        await service.drainQueue();
        await service.bus.releaseLock('target:app/demo', 'other-worker');

        const run = await service.getRun(created.run.id, 'tester');
        const events = await service.listEvents(run.id, 0);

        expect(run.status).toBe('failed');
        expect(events.map((event) => event.type)).toContain('lock_wait');
        expect(events.map((event) => event.type)).toContain('failed');
    });

    test('recovers a stale running lease without replaying completed steps', async () => {
        const store = new AsyncLabStore({ persistToPostgres: false });
        const bus = new ValkeyLiveBus({});
        const firstWorker = createService({ store, bus, instanceId: 'worker-one' });
        const secondWorker = createService({ store, bus, instanceId: 'worker-two' });
        const created = await firstWorker.createRun({
            task: 'recover stale run',
            adapter: 'dry-run',
            targetKey: 'lab/recover',
        }, 'tester');

        await store.claimRun(created.run.id, 'dead-worker', 1000);
        await store.updateRun(created.run.id, {
            status: 'running',
            claimOwner: 'dead-worker',
            claimExpiresAt: new Date(Date.now() - 1000).toISOString(),
            attempt: 1,
            metadata: {
                completedStepKeys: ['normalize'],
            },
        });
        await store.appendEvent(created.run.id, {
            type: 'progress',
            source: 'dead-worker',
            status: 'running',
            payload: {
                message: 'Command normalized into a replayable message envelope.',
            },
        });

        await secondWorker.processRun(created.run.id);
        const run = await secondWorker.getRun(created.run.id, 'tester');
        const events = await secondWorker.listEvents(run.id, 0);

        expect(run.status).toBe('completed');
        expect(run.metadata.recoveredBy).toBe('worker-two');
        expect(events.map((event) => event.type)).toContain('lease_recovered');
        expect(events.filter((event) => event.type === 'progress')).toHaveLength(1);
        expect(run.metadata.completedStepKeys).toEqual(expect.arrayContaining([
            'normalize',
            'tool-message',
            'checkpoint',
        ]));
    });

    test('drainQueue scans expired running leases when Valkey has no queued item', async () => {
        const store = new AsyncLabStore({ persistToPostgres: false });
        const bus = new ValkeyLiveBus({});
        const worker = createService({ store, bus, instanceId: 'recovery-worker' });
        await store.createRun({
            id: 'stale-running-run',
            runtimeSurface: 'async-lab',
            mode: 'lab',
            adapter: 'dry-run',
            status: 'running',
            targetKey: 'lab/stale-running',
            task: 'recover from expired lease without queue entry',
            claimOwner: 'dead-worker',
            claimExpiresAt: new Date(Date.now() - 1000).toISOString(),
            attempt: 1,
            metadata: {},
        });

        const processed = await worker.drainQueue();
        const run = await worker.getRun('stale-running-run', '');
        const events = await worker.listEvents(run.id, 0);

        expect(processed).toBeGreaterThan(0);
        expect(run.status).toBe('completed');
        expect(run.metadata.recoveredBy).toBe('recovery-worker');
        expect(events.map((event) => event.type)).toContain('lease_recovered');
    });
});
