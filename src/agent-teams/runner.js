'use strict';

const { randomUUID } = require('crypto');
const { createExecutionOwnerResolver, normalizeExecutionOwner } = require('./execution-owner');
const { executionError } = require('./execution-error');

class TeamRunner {
  constructor({ service, execute, pollMs = 3000, maxActive = 8, workerId = `team-worker:${randomUUID()}`,
    resolveExecutionOwner = createExecutionOwnerResolver() }) {
    if (!service || typeof execute !== 'function' || !Number.isSafeInteger(pollMs) || pollMs < 100
      || !Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 64
      || typeof resolveExecutionOwner !== 'function') throw new Error('Invalid team runner configuration.');
    this.service = service;
    this.execute = execute;
    this.pollMs = pollMs;
    this.maxActive = maxActive;
    this.workerId = workerId;
    this.resolveExecutionOwner = resolveExecutionOwner;
    this.ownerPromise = null;
    this.active = new Map();
    this.ticking = false;
    this.timer = null;
    this.stopped = false;
    this.generation = 0;
    this.tickPromise = null;
    this.admissionPending = false;
    this.admissionUncertain = false;
    this.pendingAdmissions = new Set();
    this.unobservedTaskIds = new Set();
    this.draining = 0;
    this.drainBlocked = false;
  }

  prepareOwner() {
    // Keep the same boot identity and observation promise for this runner.
    // A failed acquisition cannot silently switch identity mid-execution.
    if (!this.ownerPromise) this.ownerPromise = Promise.resolve().then(this.resolveExecutionOwner).then(normalizeExecutionOwner).then(owner => {
      if (owner.kernel) Object.freeze(owner.kernel);
      if (owner.pod) Object.freeze(owner.pod);
      if (owner.containerBinding) {
        if (owner.containerBinding.cgroup) Object.freeze(owner.containerBinding.cgroup);
        Object.freeze(owner.containerBinding);
      }
      return Object.freeze(owner);
    });
    return this.ownerPromise;
  }

  start() {
    if (this.draining || this.drainBlocked) throw Object.assign(new Error('Runner drain remains unsettled.'), { code: 'team_runner_draining' });
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    this.generation += 1;
    clearInterval(this.timer);
    this.timer = null;
    for (const entry of this.active.values()) entry.controller.abort();
    // Occupancy is released only when the executor returns or is reconciled.
  }

  // This proves local work has settled, not that external tools/processes have
  // stopped. Unknown outcomes remain visible for the future reconciler. Every
  // concurrent caller gets its own deadline; no caller can resume admissions
  // while another drain is active or after a timed-out/uncertain drain.
  async drain({ timeoutMs = 10000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid runner drain deadline.');
    this.draining += 1;
    this.drainBlocked = true;
    this.stop();
    let timer;
    try {
      const finishing = (async () => {
        if (this.tickPromise) await this.tickPromise.catch(() => {});
        await Promise.allSettled([...this.active.values()].map(entry => entry.done));
      })();
      await Promise.race([finishing, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
      const pendingTaskIds = [...new Set([...this.active.keys(), ...this.pendingAdmissions, ...this.unobservedTaskIds])].sort();
      const settled = !this.ticking && !this.admissionPending && !this.admissionUncertain && pendingTaskIds.length === 0;
      this.drainBlocked = !settled;
      return { settled, pendingTaskIds, admissionPending: this.admissionPending || this.ticking,
        admissionUncertain: this.admissionUncertain, unobservedTaskIds: [...this.unobservedTaskIds].sort() };
    } finally { clearTimeout(timer); this.draining -= 1; }
  }

  tick() {
    if (this.ticking) return this.tickPromise;
    if (this.stopped) return Promise.resolve();
    this.ticking = true;
    this.tickPromise = this.runTick();
    return this.tickPromise;
  }

  async runTick() {
    const generation = this.generation;
    const stopped = () => this.stopped || generation !== this.generation;
    try {
      for (const entry of this.active.values()) {
        try {
          const status = await this.service.heartbeat(entry.teamId, entry.ownerId, entry.claim);
          if (status.cancelled) entry.controller.abort();
        } catch (_) { entry.controller.abort(); }
      }
      if (stopped() || this.active.size >= this.maxActive) return;
      const teams = await this.service.store.listRunnable();
      if (stopped() || !teams.length) return;
      const executionOwner = await this.prepareOwner();
      for (const team of teams) {
        if (stopped() || this.active.size >= this.maxActive) break;
        // Claim limit is team-scoped. maxActive is an extra process capacity
        // guard; pass remaining slots so no unstarted claim consumes capacity.
        let tasks;
        this.admissionPending = true;
        try {
          tasks = await this.service.claimEnabled(team.id, team.ownerId, this.workerId, this.maxActive - this.active.size, executionOwner);
        } catch (error) {
          // A claim transaction may have committed before its response failed.
          // IDs are unknown here; only durable inventory can reconcile them.
          this.admissionUncertain = true;
          throw error;
        } finally { this.admissionPending = false; }
        for (const task of tasks) this.pendingAdmissions.add(task.id);
        for (const task of tasks) {
          if (stopped()) {
            // Admission may have committed during shutdown. No executor was
            // launched, so this specific claim can be terminally cancelled.
            await this.service.recordResult(team.id, team.ownerId,
              { taskId: task.id, workerId: this.workerId, claimId: task.worker.claimId },
              { status: 'cancelled', summary: 'Runner stopped before execution started.', artifactIds: [] });
          } else this.process(team, task);
          this.pendingAdmissions.delete(task.id);
        }
      }
    } finally {
      for (const id of this.pendingAdmissions) this.unobservedTaskIds.add(id);
      this.ticking = false;
      this.tickPromise = null;
    }
  }

  process(team, task) {
    if (this.stopped || this.draining || this.drainBlocked) throw Object.assign(new Error('Runner admissions are stopped.'), { code: 'team_runner_stopped' });
    const controller = new AbortController();
    const claim = { taskId: task.id, workerId: this.workerId, claimId: task.worker.claimId };
    const entry = { teamId: team.id, ownerId: team.ownerId, claim, controller };
    this.active.set(task.id, entry);
    entry.done = (async () => {
      try {
        const result = await this.execute({ teamId: team.id, ownerId: team.ownerId, task, claim, signal: controller.signal,
          onEvent: async (event) => {
            const status = await this.service.heartbeat(team.id, team.ownerId, claim, event);
            if (status.cancelled) controller.abort();
          } });
        await this.service.recordResult(team.id, team.ownerId, claim, result);
      } catch (error) {
        // An exception could occur after an external action. Do not label it
        // cancelled or retry it without a terminal execution observation.
        this.unobservedTaskIds.add(task.id);
        await this.service.unobserved(team.id, team.ownerId, claim, executionError(error)).catch(() => {});
      } finally { this.active.delete(task.id); }
    })();
    return entry.done;
  }
}

module.exports = { TeamRunner };
