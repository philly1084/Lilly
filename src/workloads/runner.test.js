'use strict';

const { AgentWorkloadRunner } = require('./runner');

describe('AgentWorkloadRunner', () => {
    test('continues claiming due work while a long-running job is active', async () => {
        let finishFirstRun;
        const firstRunCompletion = new Promise((resolve) => {
            finishFirstRun = resolve;
        });
        const workloadService = {
            claimDueRuns: jest.fn()
                .mockResolvedValueOnce([{ id: 'run-1' }])
                .mockResolvedValueOnce([{ id: 'run-2' }]),
            executeClaimedRun: jest.fn((run) => (
                run.id === 'run-1' ? firstRunCompletion : Promise.resolve()
            )),
            extendRunLease: jest.fn().mockResolvedValue(true),
        };
        const runner = new AgentWorkloadRunner({
            workloadService,
            batchSize: 4,
        });

        await runner.tick();
        expect(runner.activeRuns.has('run-1')).toBe(true);

        await runner.tick();
        expect(workloadService.claimDueRuns).toHaveBeenNthCalledWith(2, expect.objectContaining({
            limit: 3,
        }));
        expect(workloadService.executeClaimedRun).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'run-2' }),
            runner.workerId,
        );

        finishFirstRun();
        await firstRunCompletion;
        await new Promise((resolve) => setImmediate(resolve));
        expect(runner.activeRuns.size).toBe(0);
    });

    test('does not claim above the configured concurrency limit', async () => {
        const workloadService = {
            claimDueRuns: jest.fn(),
            executeClaimedRun: jest.fn(),
            extendRunLease: jest.fn(),
        };
        const runner = new AgentWorkloadRunner({
            workloadService,
            batchSize: 2,
        });
        runner.activeRuns.add('run-1');
        runner.activeRuns.add('run-2');

        await runner.tick();

        expect(workloadService.claimDueRuns).not.toHaveBeenCalled();
    });
});
