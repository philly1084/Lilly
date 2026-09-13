'use strict';

const { createHash } = require('node:crypto');
const { TeamService } = require('./service');
const { TestStore } = require('./test-store');
const { TeamReconciler } = require('./reconciler');
const { readBackArtifact } = require('./worker');

const executionOwner = { version: 1, bootId: '01234567-89ab-4cde-8fab-0123456789ab', platform: 'win32',
  pid: 42, startedAt: '2026-09-07T00:00:00.000Z', kernel: null, pod: null };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

describe('Interrupted team recovery without replacement execution', () => {
  let store; let service; let team; let agent; let claim; let artifactService; let controller; let evidence; let clock; let key;
  const owner = 'owner';
  const call = (action, input) => service.ownerCommand(team.id, owner, action, input, `command-${key++}`);
  const saved = async () => (await service.get(team.id, owner)).tasks.find(task => task.id === claim.taskId);
  const begin = (investigatorId = 'investigator') => service.beginReconciliation(team.id, owner, claim, { investigatorId, leaseMs: 1000 });
  const finish = lease => service.finishReconciliation(team.id, owner, claim, lease.id, evidence);
  async function reserve(kind = 'artifact_write') {
    return service.beginOperation(team.id, owner, claim, { callId: `call-${key++}`, kind, fingerprint: 'a'.repeat(64),
      ...(kind === 'lilly_tool' ? { toolId: 'web-search' } : {}) });
  }
  function artifact(operation) {
    const contentBuffer = Buffer.from('Preserved output');
    return { id: operation.id, filename: 'output.txt', contentBuffer, sha256: createHash('sha256').update(contentBuffer).digest('hex'),
      sourceMode: 'agent-teams', direction: 'generated', metadata: { teamId: team.id, ownerId: owner, agentId: agent.id,
        taskId: claim.taskId, operationId: operation.id, operationFingerprint: operation.fingerprint } };
  }
  beforeEach(async () => {
    clock = Date.parse('2026-09-07T01:00:00Z'); key = 0;
    store = new TestStore({ now: () => new Date(clock).toISOString() });
    artifactService = { getArtifact: jest.fn() };
    service = new TeamService({ store, now: () => '2099-01-01T00:00:00Z',
      verifyArtifact: async scope => readBackArtifact(await artifactService.getArtifact(scope.artifactId, { includeContent: true }), scope) });
    team = await service.create(owner, { name: 'Recovery team', objective: 'Preserve real output.', concurrency: 1 });
    agent = await call('create_agent', { name: 'Builder', job: 'Create saved outputs.' });
    await call('configure_execution', { enabled: true });
    await call('assign_task', { agentId: agent.id, title: 'Interrupted', instruction: 'Fixture only.' });
    const [task] = await service.claimEnabled(team.id, owner, 'runner', 1, executionOwner);
    claim = { taskId: task.id, workerId: task.worker.id, claimId: task.worker.claimId };
    evidence = { receiptId: 'observer-receipt', claimId: claim.claimId, ownerBootId: executionOwner.bootId,
      ownerStopped: true, workerStopped: true, browserStopped: true };
    controller = new TeamReconciler({ service, artifactService, observeQuiescence: jest.fn(async () => evidence), leaseMs: 1000 });
  });

  test('healthy work is inspected without fencing or changing its state', async () => {
    controller.observeQuiescence.mockResolvedValue({ ...evidence, ownerStopped: false });
    const before = await saved();
    expect(await controller.tick()).toEqual({ inspected: 1, recovered: 0 });
    expect(await saved()).toEqual(before);
  });

  test('one lease wins competing investigations using storage time, not service time', async () => {
    const leases = await Promise.all(Array.from({ length: 20 }, (_, i) => begin(`investigator-${i}`)));
    const [lease] = leases.filter(Boolean);
    expect(leases.filter(Boolean)).toHaveLength(1);
    expect(lease.startedAt).toBe('2026-09-07T01:00:00.000Z');
    expect(lease.expiresAt).toBe('2026-09-07T01:00:01.000Z');
    await expect(service.heartbeat(team.id, owner, claim)).rejects.toMatchObject({ code: 'team_claim_required' });
    await expect(reserve()).rejects.toMatchObject({ code: 'team_claim_required' });
  });

  test('expired investigator cannot finish or steal the new lease', async () => {
    const old = await begin(); clock += 1000;
    await expect(finish(old)).rejects.toMatchObject({ code: 'team_recovery_stale' });
    const next = await begin('new-investigator');
    expect(next.id).not.toBe(old.id);
    await expect(finish(old)).rejects.toMatchObject({ code: 'team_recovery_stale' });
    expect((await finish(next)).status).toBe('failed');
  });

  test('concurrent identical completion receipts release once and stay replayable', async () => {
    const lease = await begin();
    const results = await Promise.all(Array.from({ length: 20 }, () => finish(lease)));
    expect(results.every(result => result.status === 'failed')).toBe(true);
    expect(new Set(results.map(result => result.result.finishedAt)).size).toBe(1);
    clock += 60000;
    expect(await finish(lease)).toEqual(results[0]);
    expect(await controller.tick()).toEqual({ inspected: 0, recovered: 0 });
    expect((await service.get(team.id, owner)).tasks).toHaveLength(1);
  });

  test('completed receipt remains replayable after PostgreSQL JSONB changes object key order', async () => {
    const lease = await begin(); await finish(lease);
    await store.mutate(team.id, owner, state => {
      const receipt = state.tasks[0].worker.reconciliation.receipt;
      state.tasks[0].worker.reconciliation.receipt = Object.fromEntries(Object.keys(receipt).sort().map(key => [key, receipt[key]]));
    });
    expect((await finish(lease)).status).toBe('failed');
  });

  test.each(['ownerStopped', 'workerStopped', 'browserStopped'])('requires positive %s evidence', async field => {
    const lease = await begin(); evidence[field] = false;
    await expect(finish(lease)).rejects.toMatchObject({ code: 'team_recovery_evidence_required' });
    expect((await saved()).status).toBe('reconciling');
  });

  test.each([{ receiptId: 123 }, { ownerBootId: 'wrong-owner' }, { claimId: 'old-claim' }, { extra: 'untrusted' }])('rejects malformed or mismatched receipt %j', async change => {
    const lease = await begin(); evidence = { ...evidence, ...change };
    await expect(finish(lease)).rejects.toBeDefined();
    expect((await saved()).status).toBe('reconciling');
  });

  test('malformed stored expiry cannot authorize completion', async () => {
    const lease = await begin();
    await store.mutate(team.id, owner, state => { state.tasks[0].worker.reconciliation.expiresAt = 'invalid'; });
    await expect(finish(lease)).rejects.toMatchObject({ code: 'team_recovery_stale' });
  });

  test('recovers the reserved write after lost observation, preserves bytes, and never reports success', async () => {
    const operation = await reserve(); const output = artifact(operation);
    artifactService.getArtifact.mockResolvedValue(output);
    const originalAgent = (await service.get(team.id, owner)).agents[0];
    expect(await controller.tick()).toEqual({ inspected: 1, recovered: 1 });
    const task = await saved();
    expect(task.status).toBe('failed');
    expect(task.result.artifacts).toEqual([{ id: operation.id, sha256: output.sha256 }]);
    expect(task.operations[0].status).toBe('settled');
    expect((await service.get(team.id, owner)).agents[0]).toEqual(originalAgent);
    expect(controller.observeQuiescence).toHaveBeenCalledTimes(2);
    expect(artifactService.getArtifact).toHaveBeenCalledTimes(2);
  });

  test.each(['missing', 'foreign', 'corrupt', 'unavailable'])('retains occupancy for %s artifact evidence', async mode => {
    const operation = await reserve(); const output = artifact(operation);
    if (mode === 'missing') artifactService.getArtifact.mockResolvedValue(null);
    if (mode === 'foreign') artifactService.getArtifact.mockResolvedValue({ ...output, metadata: { ...output.metadata, ownerId: 'other' } });
    if (mode === 'corrupt') artifactService.getArtifact.mockResolvedValue({ ...output, sha256: 'b'.repeat(64) });
    if (mode === 'unavailable') artifactService.getArtifact.mockRejectedValue(new Error('private path'));
    expect(await controller.tick()).toEqual({ inspected: 1, recovered: 0 });
    expect((await saved()).status).toBe('reconciling');
    expect((await saved()).operations[0].status).toBe('started');
  });

  test('dead worker does not settle a still-unknown external tool', async () => {
    await reserve('lilly_tool');
    expect(await controller.tick()).toEqual({ inspected: 1, recovered: 0 });
    expect((await saved()).status).toBe('reconciling');
    expect(artifactService.getArtifact).not.toHaveBeenCalled();
  });

  test('disabled team still recovers cancellation without enabling execution', async () => {
    await call('control_agent', { agentId: agent.id, action: 'stop' });
    await call('configure_execution', { enabled: false });
    expect(await controller.tick()).toEqual({ inspected: 1, recovered: 1 });
    expect((await saved()).status).toBe('cancelled');
    expect((await service.get(team.id, owner)).execution.enabled).toBe(false);
  });

  test('legacy ownership-free work stays quarantined', async () => {
    await store.mutate(team.id, owner, state => { delete state.tasks[0].worker.executionOwner; });
    expect(await controller.tick()).toEqual({ inspected: 0, recovered: 0 });
    expect(controller.observeQuiescence).not.toHaveBeenCalled();
    await expect(begin()).rejects.toMatchObject({ code: 'team_execution_owner_invalid' });
  });

  test('stop during observer await prevents late fencing and overlapping ticks share the same work', async () => {
    const gate = deferred(); controller.observeQuiescence.mockReturnValue(gate.promise);
    const first = controller.tick(); expect(controller.tick()).toBe(first);
    await new Promise(resolve => setImmediate(resolve)); controller.stop(); gate.resolve(evidence);
    expect(await first).toEqual({ inspected: 1, recovered: 0 });
    expect((await saved()).status).toBe('running');
    expect(await controller.tick()).toEqual({ inspected: 0, recovered: 0 });
  });

  test('stop during artifact read prevents late journal mutations', async () => {
    const operation = await reserve(); const gate = deferred();
    artifactService.getArtifact.mockReturnValue(gate.promise);
    const work = controller.tick(); await new Promise(resolve => setImmediate(resolve));
    expect(artifactService.getArtifact).toHaveBeenCalledTimes(1);
    controller.stop(); gate.resolve(artifact(operation)); await work;
    expect((await saved()).operations[0].status).toBe('started');
    expect((await saved()).status).toBe('reconciling');
  });

  test('a second observation must still prove quiescence before release', async () => {
    controller.observeQuiescence.mockResolvedValueOnce(evidence).mockResolvedValueOnce(null);
    expect(await controller.tick()).toEqual({ inspected: 1, recovered: 0 });
    expect((await saved()).status).toBe('reconciling');
  });

  test('artifact reference changes during independent read-back prevent release', async () => {
    const operation = await reserve(); const output = artifact(operation);
    await service.settleOperation(team.id, owner, claim, operation.id, { status: 'settled', artifact: { id: output.id, sha256: output.sha256 } });
    const lease = await begin();
    artifactService.getArtifact.mockImplementation(async () => {
      await store.mutate(team.id, owner, state => { state.tasks[0].operations[0].artifact.sha256 = 'b'.repeat(64); });
      return output;
    });
    await expect(finish(lease)).rejects.toMatchObject({ code: 'team_recovery_stale' });
    expect((await saved()).status).toBe('reconciling');
  });

  test('released capacity admits an explicitly queued follow-up but never replays the old task', async () => {
    const next = await call('assign_task', { agentId: agent.id, title: 'Follow-up', instruction: 'Explicit fixture assignment.' });
    expect(await service.claimEnabled(team.id, owner, 'next', 1, executionOwner)).toEqual([]);
    expect((await controller.tick()).recovered).toBe(1);
    const admitted = await service.claimEnabled(team.id, owner, 'next', 1, executionOwner);
    expect(admitted.map(task => task.id)).toEqual([next.id]);
    expect((await saved()).status).toBe('failed');
  });

  test('inspection rotates past healthy tasks instead of spending every tick on the first budget', async () => {
    const initial = await saved();
    const originals = [];
    await store.mutate(team.id, owner, state => {
      state.tasks = Array.from({ length: 7 }, (_, index) => ({ ...structuredClone(initial), id: `task-${index}` }));
      originals.push(...structuredClone(state.tasks));
    });
    const observed = [];
    controller = new TeamReconciler({ service, artifactService, maxTasks: 2,
      observeQuiescence: async scope => { observed.push(scope.taskId); return null; } });
    for (let tick = 0; tick < 4; tick += 1) expect((await controller.tick()).inspected).toBeLessThanOrEqual(2);
    expect(observed).toEqual(originals.map(task => task.id));
    expect((await service.get(team.id, owner)).tasks).toEqual(originals);
    await controller.tick(); // End-of-inventory resets the bounded scan cursor.
    await controller.tick();
    expect(observed.slice(7)).toEqual(['task-0', 'task-1']);
  });

  test('recurring inventory reaches teams beyond the first page and retries transiently unreadable teams next sweep', async () => {
    const template = await service.get(team.id, owner);
    store.rows.clear();
    for (let i = 0; i < 105; i += 1) {
      const id = `team-${String(i).padStart(3, '0')}`;
      await store.create({ ...structuredClone(template), id });
    }
    const originalGet = service.get.bind(service);
    let unreadable = true;
    jest.spyOn(service, 'get').mockImplementation((id, ownerId) => {
      if (id === 'team-000' && unreadable) throw new Error('Private storage details');
      return originalGet(id, ownerId);
    });
    const observed = [];
    controller = new TeamReconciler({ service, artifactService, maxTasks: 16,
      observeQuiescence: async scope => { observed.push(scope.teamId); return null; } });
    for (let tick = 0; tick < 8; tick += 1) expect((await controller.tick()).inspected).toBeLessThanOrEqual(16);
    expect(new Set(observed).size).toBe(104);
    expect(observed).toContain('team-104');
    expect(observed).not.toContain('team-000');
    unreadable = false;
    for (let tick = 0; tick < 3; tick += 1) await controller.tick();
    expect(observed).toContain('team-000');
    expect(store.rows.size).toBe(105);
    expect([...store.rows.values()].every(row => row.tasks[0].status === 'running')).toBe(true);
  });

  test('scheduled polls share an unresolved investigation and retry a rejected inventory without leaking errors', async () => {
    jest.useFakeTimers();
    const gate = deferred();
    const inventory = jest.spyOn(store, 'listUnsettled').mockRejectedValueOnce(new Error('Private database endpoint'));
    controller.observeQuiescence.mockReturnValue(gate.promise);
    try {
      controller.start(); controller.start();
      await jest.advanceTimersByTimeAsync(3000);
      expect(inventory).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(3000);
      const pending = controller.pending;
      expect(pending).not.toBeNull();
      await jest.advanceTimersByTimeAsync(12000);
      expect(controller.pending).toBe(pending);
      expect(inventory).toHaveBeenCalledTimes(2);
      expect(controller.observeQuiescence).toHaveBeenCalledTimes(1);
      controller.stop(); gate.resolve(null); await pending;
      expect((await saved()).status).toBe('running');
      await jest.advanceTimersByTimeAsync(6000);
      expect(inventory).toHaveBeenCalledTimes(2);
    } finally { controller.stop(); gate.resolve(null); jest.useRealTimers(); }
  });
});
