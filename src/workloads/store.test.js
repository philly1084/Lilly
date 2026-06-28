'use strict';

jest.mock('../postgres', () => ({
    postgres: {
        enabled: true,
        query: jest.fn(),
        getPool: jest.fn(),
    },
}));

const { postgres } = require('../postgres');
const { WorkloadStore } = require('./store');

describe('WorkloadStore', () => {
    let store;

    beforeEach(() => {
        store = new WorkloadStore();
        postgres.enabled = true;
        postgres.query.mockReset();
    });

    test('returns the existing run when enqueue hits an idempotency conflict', async () => {
        postgres.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({
                rows: [{
                    id: 'run-existing-1',
                    workload_id: 'workload-1',
                    owner_id: 'phill',
                    session_id: 'session-1',
                    status: 'queued',
                    reason: 'schedule',
                    scheduled_for: '2026-04-03T12:05:00.000Z',
                    started_at: null,
                    finished_at: null,
                    claim_owner: null,
                    claim_expires_at: null,
                    parent_run_id: null,
                    stage_index: -1,
                    attempt: 0,
                    response_id: null,
                    prompt: 'Run `date` on the server.',
                    trace: {},
                    error: {},
                    metadata: {},
                    created_at: '2026-04-03T12:00:00.000Z',
                    updated_at: '2026-04-03T12:00:00.000Z',
                }],
            });

        const run = await store.enqueueRun({
            workloadId: 'workload-1',
            ownerId: 'phill',
            sessionId: 'session-1',
            reason: 'schedule',
            scheduledFor: '2026-04-03T12:05:00.000Z',
            stageIndex: -1,
            idempotencyKey: 'workload-1:schedule:2026-04-03T12:05:00.000Z:stage--1',
            prompt: 'Run `date` on the server.',
        });

        expect(run).toEqual(expect.objectContaining({
            id: 'run-existing-1',
            workloadId: 'workload-1',
            status: 'queued',
        }));
        expect(postgres.query).toHaveBeenCalledTimes(2);
        expect(postgres.query.mock.calls[0][0]).toContain('ON CONFLICT DO NOTHING');
        expect(postgres.query.mock.calls[0][0]).not.toContain('ON CONFLICT (idempotency_key)');
        expect(postgres.query.mock.calls[1][0]).toContain('WHERE idempotency_key = $1');
    });

    test('completeRun clears error with an empty json object instead of null', async () => {
        postgres.query.mockResolvedValueOnce({
            rows: [{
                id: 'run-1',
                workload_id: 'workload-1',
                owner_id: 'phill',
                session_id: 'session-1',
                status: 'completed',
                reason: 'schedule',
                scheduled_for: '2026-04-03T04:19:09.419Z',
                started_at: '2026-04-03T04:19:10.000Z',
                finished_at: '2026-04-03T04:19:11.000Z',
                claim_owner: 'worker-1',
                claim_expires_at: null,
                parent_run_id: null,
                stage_index: -1,
                attempt: 0,
                response_id: 'resp-1',
                prompt: 'Run `date` on the server.',
                trace: { structuredExecution: true },
                error: {},
                metadata: {},
                created_at: '2026-04-03T04:19:09.419Z',
                updated_at: '2026-04-03T04:19:11.000Z',
            }],
        });

        const run = await store.completeRun('run-1', 'worker-1', {
            responseId: 'resp-1',
            trace: { structuredExecution: true },
        });

        expect(run).toEqual(expect.objectContaining({
            id: 'run-1',
            status: 'completed',
            error: {},
        }));
        expect(postgres.query).toHaveBeenCalledTimes(1);
        expect(postgres.query.mock.calls[0][0]).toContain("error = '{}'::jsonb");
        expect(postgres.query.mock.calls[0][0]).not.toContain('error = NULL');
    });

    test('skips run events when no run id is available', async () => {
        const recorded = await store.addRunEvent(null, 'queued', { source: 'scheduled' });

        expect(recorded).toBe(false);
        expect(postgres.query).not.toHaveBeenCalled();
    });

    test('only records run events for existing run rows', async () => {
        postgres.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

        const recorded = await store.addRunEvent('missing-run', 'completed', { responseId: 'resp-1' });

        expect(recorded).toBe(false);
        expect(postgres.query).toHaveBeenCalledTimes(1);
        expect(postgres.query.mock.calls[0][0]).toContain('WHERE EXISTS');
        expect(postgres.query.mock.calls[0][0]).toContain('FROM agent_runs');
    });
});
