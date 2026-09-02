'use strict';

class AgentWorkloadRunner {
    constructor({
        workloadService,
        pollMs = 5000,
        batchSize = 4,
        leaseMs = 2 * 60 * 1000,
    }) {
        this.workloadService = workloadService;
        this.pollMs = pollMs;
        this.batchSize = batchSize;
        this.leaseMs = leaseMs;
        this.workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        this.timer = null;
        this.isTicking = false;
        this.activeRuns = new Set();
    }

    start() {
        if (!this.workloadService?.isAvailable()) {
            return false;
        }
        if (this.timer) {
            return true;
        }

        this.timer = setInterval(() => {
            this.tick().catch((error) => {
                console.error('[WorkloadRunner] Tick failed:', error.message);
            });
        }, this.pollMs);
        this.timer.unref?.();

        this.tick().catch((error) => {
            console.error('[WorkloadRunner] Initial tick failed:', error.message);
        });
        return true;
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async tick() {
        if (this.isTicking) {
            return;
        }

        this.isTicking = true;
        try {
            const availableSlots = Math.max(0, this.batchSize - this.activeRuns.size);
            if (availableSlots === 0) {
                return;
            }
            const claimedRuns = await this.workloadService.claimDueRuns({
                workerId: this.workerId,
                limit: availableSlots,
                leaseMs: this.leaseMs,
            });

            for (const run of claimedRuns) {
                this.processRun(run).catch((error) => {
                    console.error(`[WorkloadRunner] Run ${run?.id || 'unknown'} processing failed:`, error.message);
                });
            }
        } finally {
            this.isTicking = false;
        }
    }

    async processRun(run) {
        if (!run?.id || this.activeRuns.has(run.id)) {
            return;
        }

        this.activeRuns.add(run.id);
        const heartbeat = setInterval(() => {
            this.workloadService.extendRunLease(run.id, this.workerId, this.leaseMs).catch((error) => {
                console.error(`[WorkloadRunner] Failed to extend lease for run ${run.id}:`, error.message);
            });
        }, Math.max(10000, Math.floor(this.leaseMs / 3)));
        heartbeat.unref?.();

        try {
            await this.workloadService.executeClaimedRun(run, this.workerId);
        } catch (error) {
            console.error(`[WorkloadRunner] Run ${run.id} failed:`, error.message);
        } finally {
            clearInterval(heartbeat);
            this.activeRuns.delete(run.id);
        }
    }
}

module.exports = {
    AgentWorkloadRunner,
};
