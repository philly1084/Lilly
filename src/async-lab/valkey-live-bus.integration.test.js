'use strict';

const { ValkeyLiveBus, sleep } = require('./valkey-live-bus');

const valkeyUrl = process.env.ASYNC_VALKEY_TEST_URL || '';
const describeIfValkey = valkeyUrl ? describe : describe.skip;

describeIfValkey('ValkeyLiveBus integration', () => {
    const keyPrefix = `kimibuilt:test:${Date.now()}`;
    let busA;
    let busB;

    beforeEach(async () => {
        busA = new ValkeyLiveBus({
            url: valkeyUrl,
            keyPrefix,
            eventTtlSeconds: 60,
            idempotencyTtlSeconds: 60,
            leaseTtlMs: 1000,
        });
        busB = new ValkeyLiveBus({
            url: valkeyUrl,
            keyPrefix,
            eventTtlSeconds: 60,
            idempotencyTtlSeconds: 60,
            leaseTtlMs: 1000,
        });
        expect(await busA.connect()).toBe(true);
        expect(await busB.connect()).toBe(true);
    });

    afterEach(async () => {
        await busA?.close();
        await busB?.close();
    });

    test('fans out events, replays streams, queues runs, claims idempotency, and enforces locks', async () => {
        const liveEvents = [];
        const unsubscribe = busB.subscribe('run-1', (event) => {
            liveEvents.push(event);
        });

        await busA.appendEvent('run-1', {
            eventId: 'event-1',
            runId: 'run-1',
            cursor: 1,
            type: 'queued',
            status: 'queued',
            payload: { message: 'hello valkey' },
        });
        await sleep(100);
        unsubscribe();

        const replayed = await busB.listEvents('run-1', 0);
        expect(replayed.map((event) => event.eventId)).toContain('event-1');
        expect(liveEvents.map((event) => event.eventId)).toContain('event-1');

        await busA.enqueueRun('run-1');
        expect(await busB.dequeueRun()).toBe('run-1');

        expect(await busA.claimIdempotency('same-command', 'run-1')).toEqual({
            claimed: true,
            runId: 'run-1',
        });
        expect(await busB.claimIdempotency('same-command', 'run-2')).toEqual({
            claimed: false,
            runId: 'run-1',
        });

        expect(await busA.acquireLock('target:demo', 'worker-a', 1000)).toBe(true);
        expect(await busB.acquireLock('target:demo', 'worker-b', 1000)).toBe(false);
        expect(await busB.releaseLock('target:demo', 'worker-b')).toBe(false);
        expect(await busA.releaseLock('target:demo', 'worker-a')).toBe(true);
        expect(await busB.acquireLock('target:demo', 'worker-b', 1000)).toBe(true);
    });
});
