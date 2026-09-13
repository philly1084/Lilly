'use strict';

const { TeamService } = require('./service');
const { TestStore } = require('./test-store');

describe('Durable worker operation journal', () => {
  const owner = 'owner';
  const now = '2026-09-06T12:00:00.000Z';
  const reservation = { callId: 'call:1', kind: 'artifact_write', fingerprint: 'a'.repeat(64) };
  const artifact = { id: 'saved-artifact', sha256: 'b'.repeat(64) };
  let store; let service; let team; let claim;
  const begin = (input = reservation, identity = claim) => service.beginOperation(team.id, owner, identity, input);
  const settle = (id, input = { status: 'settled' }, identity = claim) => service.settleOperation(team.id, owner, identity, id, input);
  const task = async () => (await service.get(team.id, owner)).tasks[0];

  beforeEach(async () => {
    store = new TestStore();
    service = new TeamService({ store, now: () => now });
    team = await service.create(owner, { name: 'Journal proof', objective: 'Save inspectable work.' });
    const agent = await service.ownerCommand(team.id, owner, 'create_agent', { name: 'Builder', job: 'Build.' }, 'agent');
    await service.ownerCommand(team.id, owner, 'assign_task', { agentId: agent.id, title: 'Build', instruction: 'Save output.' }, 'task');
    await service.ownerCommand(team.id, owner, 'configure_execution', { enabled: true }, 'enable');
    const [claimed] = await service.claimEnabled(team.id, owner, 'worker');
    claim = { taskId: claimed.id, workerId: 'worker', claimId: claimed.worker.claimId };
  });

  test('reservation persists across service restart with only allowlisted metadata', async () => {
    const op = await begin();
    expect(op).toEqual({ ...reservation, id: expect.any(String), status: 'started', startedAt: now });
    service = new TeamService({ store, now: () => now });
    expect((await task()).operations).toEqual([op]);
    await expect(begin()).rejects.toMatchObject({ code: 'team_operation_replayed', statusCode: 409 });
    await expect(begin({ ...reservation, fingerprint: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'team_idempotency_conflict' });
    await expect(begin({ ...reservation, kind: 'lilly_tool' })).rejects.toMatchObject({ code: 'team_idempotency_conflict' });
    await settle(op.id);
    await expect(begin()).rejects.toMatchObject({ code: 'team_operation_replayed' });
  });

  test('concurrent adapters sharing storage reserve a call only once', async () => {
    const second = new TeamService({ store });
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => (index % 2 ? second : service)
      .beginOperation(team.id, owner, claim, reservation)));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'team_operation_replayed')).toBe(true);
    expect((await task()).operations).toHaveLength(1);
  });

  test('generic tool identity is bounded, durable and part of replay identity', async () => {
    const input = { ...reservation, kind: 'lilly_tool', toolId: 'web-search' };
    expect(await begin(input)).toMatchObject({ toolId: 'web-search' });
    await expect(begin(input)).rejects.toMatchObject({ code: 'team_operation_replayed' });
    await expect(begin({ ...input, toolId: 'web-fetch' })).rejects.toMatchObject({ code: 'team_idempotency_conflict' });
    const { toolId, ...withoutTool } = input;
    await expect(begin(withoutTool)).rejects.toMatchObject({ code: 'team_idempotency_conflict' });
    for (const invalid of [undefined, '', 'bad/name', 'Uppercase', 'a'.repeat(101)]) {
      await expect(begin({ ...input, callId: 'next', toolId: invalid })).rejects.toMatchObject({ code: 'team_invalid' });
    }
    await expect(begin({ ...reservation, callId: 'next', toolId: 'web-search' })).rejects.toMatchObject({ code: 'team_invalid' });
    expect((await task()).operations).toHaveLength(1);
  });

  test('different call IDs cannot race the same pending effect into multiple dispatches', async () => {
    const second = new TeamService({ store });
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => (index % 2 ? second : service)
      .beginOperation(team.id, owner, claim, { ...reservation, callId: `racing-${index}` })));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'team_operations_unsettled')).toBe(true);
    expect((await task()).operations).toHaveLength(1);
  });

  test('distinct started effects retain parallelism; settled effects may intentionally repeat', async () => {
    const op = await begin();
    await begin({ ...reservation, callId: 'different-fingerprint', fingerprint: 'b'.repeat(64) });
    await begin({ ...reservation, callId: 'different-kind', kind: 'computer_open' });
    await begin({ ...reservation, callId: 'tool-search', kind: 'lilly_tool', toolId: 'web-search' });
    await begin({ ...reservation, callId: 'tool-fetch', kind: 'lilly_tool', toolId: 'web-fetch' });
    await expect(begin({ ...reservation, callId: 'same-effect' })).rejects.toMatchObject({ code: 'team_operations_unsettled' });
    await settle(op.id);
    await expect(begin({ ...reservation, callId: 'intentional-repeat' })).resolves.toMatchObject({ status: 'started' });
    expect((await task()).operations).toHaveLength(6);
  });

  test.each(['a', 'b'])('unknown effects block every new call, including fingerprint %s', async (hex) => {
    const op = await begin();
    await settle(op.id, { status: 'unknown' });
    service = new TeamService({ store });
    await expect(begin({ ...reservation, callId: 'new-call', fingerprint: hex.repeat(64) })).rejects.toMatchObject({ code: 'team_operations_unsettled', statusCode: 409 });
    await expect(begin({ ...reservation, callId: 'different-tool', kind: 'lilly_tool', toolId: 'web-search' })).rejects.toMatchObject({ code: 'team_operations_unsettled' });
    // Exact call identity errors take precedence and never authorize dispatch.
    await expect(begin()).rejects.toMatchObject({ code: 'team_operation_replayed' });
    await expect(begin({ ...reservation, fingerprint: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'team_idempotency_conflict' });
    expect((await task()).operations).toHaveLength(1);
  });

  test.each([null, {}, { status: 'completed' }, { status: null }])('invalid journal statuses fail closed: %p', async (invalid) => {
    await store.mutate(team.id, owner, (state) => { state.tasks[0].operations = [invalid]; });
    await expect(begin()).rejects.toMatchObject({ code: 'team_operations_unsettled' });
    await expect(service.recordResult(team.id, owner, claim, { status: 'failed', summary: 'Fixture' })).rejects.toMatchObject({ code: 'team_operations_unsettled' });
    expect((await task()).operations).toEqual([invalid]);
  });

  test.each([undefined, {}, { taskId: 'other' }, { workerId: 'other' }, { claimId: 'other' }])('requires a complete exact claim: %p', async (invalid) => {
    const bad = invalid && { ...claim, ...invalid };
    const op = await begin();
    // Empty objects must not inherit the valid claim through this fixture.
    const identity = invalid && Object.keys(invalid).length ? bad : invalid;
    await expect(service.beginOperation(team.id, owner, identity, reservation)).rejects.toMatchObject({ code: 'team_claim_required' });
    await expect(service.settleOperation(team.id, owner, identity, op.id, { status: 'settled' })).rejects.toMatchObject({ code: 'team_claim_required' });
    expect((await task()).operations[0].status).toBe('started');
  });

  test('owner isolation and missing reservation cannot manufacture settlement', async () => {
    const op = await begin();
    await expect(service.beginOperation(team.id, 'foreign', claim, reservation)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.settleOperation(team.id, 'foreign', claim, op.id, { status: 'settled' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(settle('missing')).rejects.toMatchObject({ code: 'team_operation_not_found' });
  });

  test.each(['cancelled', 'disabled-team', 'disabled-agent', 'reconciling'])('new dispatch is denied after %s but late settlement remains fenced and accepted', async (mode) => {
    const op = await begin();
    await settle(op.id, { status: 'unknown' });
    await store.mutate(team.id, owner, (state) => {
      if (mode === 'cancelled') state.tasks[0].cancelRequestedAt = now;
      if (mode === 'disabled-team') state.execution.enabled = false;
      if (mode === 'disabled-agent') state.agents[0].enabled = false;
    });
    if (mode === 'reconciling') await service.unobserved(team.id, owner, claim);
    await expect(begin({ ...reservation, callId: 'new' })).rejects.toMatchObject({ code: 'team_claim_required' });
    await expect(settle(op.id, { status: 'settled' }, { ...claim, claimId: 'old' })).rejects.toMatchObject({ code: 'team_claim_required' });
    expect(await settle(op.id, { status: 'settled', artifact })).toMatchObject({ status: 'settled', unknownAt: now, settledAt: now, artifact });
    expect((await task()).status).toBe(mode === 'reconciling' ? 'reconciling' : 'running');
  });

  test('exact settlement is idempotent; contradictions and downgrade are rejected', async () => {
    const op = await begin();
    const unknown = await settle(op.id, { status: 'unknown', artifact });
    expect(await settle(op.id, { status: 'unknown', artifact })).toEqual(unknown);
    await expect(settle(op.id, { status: 'unknown' })).rejects.toMatchObject({ code: 'team_operation_conflict' });
    await expect(settle(op.id, { status: 'settled', artifact: { ...artifact, sha256: 'c'.repeat(64) } })).rejects.toMatchObject({ code: 'team_operation_conflict' });
    const settled = await settle(op.id, { status: 'settled', artifact });
    expect(await settle(op.id, { status: 'settled', artifact })).toEqual(settled);
    await expect(settle(op.id, { status: 'unknown', artifact })).rejects.toMatchObject({ code: 'team_operation_conflict' });
    await expect(settle(op.id)).rejects.toMatchObject({ code: 'team_operation_conflict' });
  });

  test('racing contradictory settlements retain the first observed evidence', async () => {
    const op = await begin();
    const results = await Promise.allSettled([
      settle(op.id, { status: 'settled', artifact }),
      settle(op.id, { status: 'settled', artifact: { ...artifact, id: 'different' } }),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].reason.code).toBe('team_operation_conflict');
    expect((await task()).operations[0].artifact).toEqual(artifact);
  });

  test.each([
    null, { callId: '' }, { callId: 'x'.repeat(161) }, { callId: 'unsafe/name' },
    { kind: 'model_result' }, { fingerprint: 'A'.repeat(64) }, { fingerprint: 'short' },
    { arguments: 'secret-value' }, { result: 'secret-value' }, { token: 'secret-value' },
  ])('invalid or nonallowlisted reservation cannot persist: %p', async (input) => {
    await expect(begin(input === null ? null : { ...reservation, ...input })).rejects.toMatchObject({ code: 'team_invalid' });
    expect((await task()).operations).toBeUndefined();
  });

  test.each([
    { status: 'complete' }, { status: 'settled', result: 'secret-value' },
    { status: 'settled', artifact: null }, { status: 'settled', artifact: { id: '', sha256: 'b'.repeat(64) } },
    { status: 'settled', artifact: { id: 'x'.repeat(161), sha256: 'b'.repeat(64) } },
    { status: 'settled', artifact: { id: 'bad\nname', sha256: 'b'.repeat(64) } },
    { status: 'settled', artifact: { id: 'safe', sha256: 'bad' } },
    { status: 'settled', artifact: { id: 'safe', sha256: 'b'.repeat(64), content: 'secret-value' } },
  ])('invalid settlement does not write raw evidence: %p', async (input) => {
    const op = await begin();
    await expect(settle(op.id, input)).rejects.toMatchObject({ code: 'team_invalid' });
    expect((await task()).operations).toEqual([op]);
    expect(JSON.stringify(await service.get(team.id, owner))).not.toContain('secret-value');
  });

  test('bounded journal retains all reservations instead of evicting replay protection', async () => {
    for (let i = 0; i < 100; i++) await begin({ ...reservation, callId: `call-${i}`, fingerprint: i.toString(16).padStart(64, '0') });
    await expect(begin({ ...reservation, callId: 'call-100' })).rejects.toMatchObject({ code: 'team_operation_limit' });
    await expect(begin({ ...reservation, callId: 'call-0', fingerprint: '0'.repeat(64) })).rejects.toMatchObject({ code: 'team_operation_replayed' });
    expect((await task()).operations).toHaveLength(100);
  });

  test.each(['succeeded', 'failed', 'cancelled'])('started and unknown effects prevent %s result before artifact read-back', async (status) => {
    const op = await begin();
    service.verifyArtifact = jest.fn(async () => artifact);
    const result = { status, summary: 'Observed', artifactIds: [artifact.id] };
    await expect(service.recordResult(team.id, owner, claim, result)).rejects.toMatchObject({ code: 'team_operations_unsettled' });
    await settle(op.id, { status: 'unknown' });
    await expect(service.recordResult(team.id, owner, claim, result)).rejects.toMatchObject({ code: 'team_operations_unsettled' });
    expect(service.verifyArtifact).not.toHaveBeenCalled();
    expect((await task()).status).toBe('running');
    expect(await service.claimEnabled(team.id, owner, 'second-worker')).toEqual([]);
    await settle(op.id);
    expect((await service.recordResult(team.id, owner, claim, result)).status).toBe(status === 'succeeded' ? 'needs_review' : status);
    await expect(settle(op.id)).rejects.toMatchObject({ code: 'team_claim_required' });
  });

  test('result final lock rejects an operation reserved during asynchronous verification', async () => {
    let release; let entered;
    const waiting = new Promise((resolve) => { entered = resolve; });
    service.verifyArtifact = jest.fn(() => { entered(); return new Promise((resolve) => { release = resolve; }); });
    const result = service.recordResult(team.id, owner, claim, { status: 'succeeded', summary: 'Saved', artifactIds: [artifact.id] });
    await waiting;
    await begin();
    release(artifact);
    await expect(result).rejects.toMatchObject({ code: 'team_operations_unsettled' });
    expect(await task()).toMatchObject({ status: 'running', operations: [{ status: 'started' }] });
    expect((await task()).result).toBeNull();
  });

  test('journal cannot be asserted through owner or worker public commands', async () => {
    for (const action of ['beginOperation', 'settleOperation', 'begin_operation', 'settle_operation']) {
      await expect(service.ownerCommand(team.id, owner, action, reservation, `owner-${action}`)).rejects.toThrow();
      await expect(service.workerCommand(team.id, owner, claim, action, reservation, `worker-${action}`)).rejects.toThrow();
    }
    expect((await task()).operations).toBeUndefined();
  });
});
