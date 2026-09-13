'use strict';

const { randomUUID } = require('node:crypto');
const { readReservedArtifact } = require('./worker');

// No default observer and no inferred timeout-based takeover. The deployment
// adapter must prove owner, worker descendants and private browser quiescence.
// This controller performs no worker launch, shell command or browser action.
class TeamReconciler {
  constructor({ service, artifactService, observeQuiescence, investigatorId = `recovery:${randomUUID()}`,
    maxTasks = 16, leaseMs = 30000, pollMs = 3000 } = {}) {
    if (!service || !artifactService || typeof observeQuiescence !== 'function'
      || !Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 100
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60000
      || !Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 60000) throw new Error('Invalid recovery controller configuration.');
    Object.assign(this, { service, artifactService, observeQuiescence, investigatorId, maxTasks, leaseMs, pollMs });
    this.pending = null; this.stopped = false; this.timer = null;
    this.inventory = []; this.afterTeamId = null; this.afterTaskId = null;
  }

  start() {
    if (this.stopped) throw Object.assign(new Error('Stopped recovery controller cannot restart.'), { code: 'team_recovery_stopped' });
    if (this.timer) return;
    // The same pending tick is retained across polls, including a hung external
    // observation. A timeout never authorizes a competing investigation.
    this.timer = setInterval(() => this.tick().catch(() => {}), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    // Do not discard pending. Runtime shutdown must observe this exact promise,
    // even if a database mutation or observer outlives its shutdown deadline.
  }

  tick() {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve({ inspected: 0, recovered: 0 });
    this.pending = this.run().finally(() => { this.pending = null; });
    return this.pending;
  }

  async observe(scope) {
    const evidence = await this.observeQuiescence(scope);
    return evidence?.claimId === scope.claim.claimId && evidence?.ownerBootId === scope.executionOwner.bootId
      && evidence.ownerStopped === true && evidence.workerStopped === true && evidence.browserStopped === true ? evidence : null;
  }

  async run() {
    let inspected = 0; let recovered = 0;
    if (!this.inventory.length) {
      this.inventory = await this.service.store.listUnsettled({ afterId: this.afterTeamId });
      this.afterTeamId = this.inventory.at(-1)?.id || null;
    }
    // Retain only one identity-only page. Resume within the current team after
    // the per-tick budget, then traverse the next page. Re-reading mutable state
    // prevents a cached inventory from becoming execution/recovery authority.
    while (this.inventory.length && !this.stopped) {
      if (inspected >= this.maxTasks) break;
      const entry = this.inventory[0];
      let team;
      try { team = await this.service.get(entry.id, entry.ownerId); }
      catch { this.inventory.shift(); this.afterTaskId = null; continue; }
      const tasks = team.tasks.filter(task => this.afterTaskId === null || task.id > this.afterTaskId)
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      for (const task of tasks) {
        if (this.stopped || inspected >= this.maxTasks) return { inspected, recovered };
        this.afterTaskId = task.id;
        if (!['running', 'reconciling'].includes(task.status) || !task.worker?.executionOwner) continue;
        inspected += 1;
        const scope = { teamId: team.id, ownerId: team.ownerId, agentId: task.agentId, taskId: task.id,
          executionOwner: task.worker.executionOwner,
          claim: { taskId: task.id, workerId: task.worker.id, claimId: task.worker.claimId } };
        try {
          // Do not fence healthy work merely to see whether it is healthy.
          if (!await this.observe(scope) || this.stopped) continue;
          const lease = await this.service.beginReconciliation(team.id, team.ownerId, scope.claim,
            { investigatorId: this.investigatorId, leaseMs: this.leaseMs });
          if (!lease || this.stopped) continue;
          const fenced = await this.service.get(team.id, team.ownerId);
          const current = fenced.tasks.find(item => item.id === task.id);
          for (const operation of current.operations || []) {
            if (this.stopped) break;
            if (operation.kind !== 'artifact_write' || operation.status === 'settled') continue;
            // Positive read only. Missing/legacy/foreign artifacts stay unknown.
            const artifact = await this.artifactService.getArtifact(operation.id, { includeContent: true });
            if (this.stopped) break;
            const verified = readReservedArtifact(artifact, scope, operation);
            await this.service.settleOperation(team.id, team.ownerId, scope.claim, operation.id,
              { status: 'settled', artifact: { id: verified.id, sha256: verified.sha256 } });
          }
          if (this.stopped) continue;
          const evidence = await this.observe(scope);
          if (!evidence || this.stopped) continue;
          await this.service.finishReconciliation(team.id, team.ownerId, scope.claim, lease.id, evidence);
          recovered += 1;
        } catch {
          // An expired lease or inconclusive evidence retains durable capacity.
          // No raw observer errors/paths/private state are emitted to operators.
        }
      }
      this.inventory.shift(); this.afterTaskId = null;
    }
    return { inspected, recovered };
  }
}

module.exports = { TeamReconciler };
