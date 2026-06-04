'use strict';

const { AsyncLabService } = require('./service');
const { AsyncLabStore } = require('./store');
const { ValkeyLiveBus } = require('./valkey-live-bus');

function createService(overrides = {}) {
    const store = overrides.store || new AsyncLabStore({ persistToPostgres: false });
    const bus = overrides.bus || new ValkeyLiveBus({});
    const instanceId = overrides.instanceId || 'test-async-lab';
    delete overrides.store;
    delete overrides.bus;
    delete overrides.instanceId;

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
    });
}

describe('AsyncLabService', () => {
    test('rejects run creation when disabled', async () => {
        const service = createService({ enabled: false });

        await expect(service.createRun({ task: 'nope' }, 'tester')).rejects.toMatchObject({
            statusCode: 404,
        });
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
