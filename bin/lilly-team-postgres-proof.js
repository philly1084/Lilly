#!/usr/bin/env node
'use strict';

// Opt-in REAL PostgreSQL proof. Never accepts a DB URL, host, port or credential.
// Creates only its own network-none, tmpfs Postgres16 container and Unix socket.
// Run from a copied source tree: node bin/lilly-team-postgres-proof.js --run-isolated
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');

function command(args, timeout = 30000) {
  const result = spawnSync('podman', args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, shell: false });
  if (result.error || result.status !== 0) throw Object.assign(new Error(`podman ${args[0]} failed`), { code: 'proof_container_operation_failed' });
  return result.stdout.trim();
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function prove(pool, otherPool) {
  const { TeamStore } = require('../src/agent-teams/store');
  const { TeamService } = require('../src/agent-teams/service');
  const database = value => ({ query: (...args) => value.query(...args), getPool: () => value });
  const store = new TeamStore({ database: database(pool) });
  const secondStore = new TeamStore({ database: database(otherPool) });
  await store.initialize(); await secondStore.initialize();
  const services = [new TeamService({ store }), new TeamService({ store: secondStore })];
  const owner = 'isolated-proof-owner';
  const checks = [];
  const check = async (name, run) => { await run(); checks.push(name); process.stdout.write(`PASS ${name}\n`); };
  const input = { name: 'Postgres proof', objective: 'Test transactions only; no model or agent execution.', maxAgents: 8, concurrency: 3 };
  let team;
  await check('keyed_concurrent_creation_and_owner_namespace', async () => {
    const created = await Promise.all(Array.from({ length: 20 }, (_, i) => services[i % 2].create(owner, input, 'proof-create')));
    assert.equal(new Set(created.map(value => value.id)).size, 1); team = created[0];
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM lilly_agent_teams')).rows[0].count, 1);
    const other = await services[1].create('other-owner', input, 'proof-create');
    assert.notEqual(other.id, team.id);
    await assert.rejects(services[1].get(team.id, 'other-owner'), { code: 'team_not_found' });
    await assert.rejects(services[1].ownerCommand(team.id, 'other-owner', 'configure_execution', { enabled: true }, 'unauthorized'), { code: 'team_not_found' });
    assert.deepEqual((await services[1].list('other-owner')).map(value => value.id), [other.id]);
  });
  const ownerCommand = (action, body, key = randomUUID()) => services[0].ownerCommand(team.id, owner, action, body, key);
  const agents = [];
  for (let i = 0; i < 6; i += 1) agents.push(await ownerCommand('create_agent', { name: `Agent ${i}`, job: 'Fixture state only.' }));
  await check('keyed_retry_preserves_work_and_rejects_changed_input', async () => {
    const retried = await services[1].create(owner, input, 'proof-create');
    assert.equal(retried.agents.length, 6);
    await assert.rejects(services[1].create(owner, { ...input, name: 'Changed' }, 'proof-create'), { code: 'team_idempotency_conflict' });
    assert.equal((await services[0].get(team.id, owner)).agents.length, 6);
  });
  await check('profile_edits_are_idempotent_and_preserve_identity_permissions', async () => {
    const original = agents[0];
    const edit = { agentId: original.id, name: 'Edited profile', persona: 'Careful fixture reviewer.', job: 'Verify persisted state.' };
    const edited = await Promise.all(Array.from({ length: 20 }, (_, i) => services[i % 2].ownerCommand(team.id, owner, 'update_agent', edit, 'profile-edit')));
    assert.ok(edited.every(value => value.name === edit.name && value.id === original.id));
    let state = await services[1].get(team.id, owner);
    assert.equal(state.events.filter(value => value.type === 'agent.updated' && value.agentId === original.id).length, 1);
    const profile = state.agents.find(value => value.id === original.id);
    for (const key of ['id', 'sessionId', 'computerId', 'role', 'enabled']) assert.deepEqual(profile[key], original[key]);
    assert.equal(state.execution.enabled, false);
    await assert.rejects(ownerCommand('update_agent', { ...edit, role: 'coordinator' }, 'invalid-profile-permission'), { code: 'team_invalid' });
    await assert.rejects(ownerCommand('update_agent', { ...edit, name: 'Conflicting replay' }, 'profile-edit'), { code: 'team_idempotency_conflict' });
    await ownerCommand('update_agent', { agentId: original.id, name: 'Later legitimate edit' }, 'profile-later');
    assert.equal((await services[1].ownerCommand(team.id, owner, 'update_agent', edit, 'profile-edit')).name, edit.name);
    state = await services[0].get(team.id, owner);
    assert.equal(state.agents.find(value => value.id === original.id).name, 'Later legitimate edit');
    assert.equal(state.events.filter(value => value.type === 'agent.updated' && value.agentId === original.id).length, 2);
  });
  let skillTeamId;
  await check('approved_skill_acceptance_is_pinned_across_new_revisions', async () => {
    const skillTeam = await services[0].create(owner, { ...input, name: 'Pinned skill proof' }); skillTeamId = skillTeam.id;
    const cmd = (action, body) => services[0].ownerCommand(skillTeam.id, owner, action, body, randomUUID());
    const agent = await cmd('create_agent', { name: 'Skill fixture', job: 'Never execute this fixture.' });
    const first = await cmd('save_skill', { name: 'Read-back skill', instructions: 'Save exact bytes and read them back.', acceptance: 'Exact SHA256 must match saved bytes.' });
    const assignment = { agentId: agent.id, title: 'Pinned revision', instruction: 'Persistence fixture only.', skillId: first.id };
    await assert.rejects(cmd('assign_task', assignment), { code: 'team_invalid' });
    assert.equal((await services[1].get(skillTeam.id, owner)).tasks.length, 0);
    await cmd('approve_skill', { skillId: first.id });
    const task = await cmd('assign_task', assignment);
    const second = await cmd('save_skill', { replaces: first.id, name: first.name, instructions: 'Different revision instructions.', acceptance: 'Different future acceptance criterion.' });
    await cmd('approve_skill', { skillId: second.id });
    const future = await cmd('assign_task', { ...assignment, title: 'New revision', skillId: second.id });
    const state = await services[1].get(skillTeam.id, owner);
    assert.deepEqual(state.tasks.find(value => value.id === task.id).skill,
      { id: first.id, revision: 1, instructions: first.instructions, acceptance: first.acceptance });
    assert.deepEqual(state.tasks.find(value => value.id === future.id).skill,
      { id: second.id, revision: 2, instructions: second.instructions, acceptance: second.acceptance });
    assert.equal(state.tasks.every(value => value.status === 'queued'), true);
    assert.equal(state.execution.enabled, false);
  });
  await check('transaction_rollback_on_invalid_command_and_partial_mutation', async () => {
    const before = await services[0].get(team.id, owner);
    await assert.rejects(ownerCommand('configure_execution', { origins: ['not a URL'] }, 'invalid-command'), { code: 'team_invalid' });
    await assert.rejects(secondStore.mutate(team.id, owner, state => { state.name = 'MUST ROLLBACK'; throw new Error('intentional rollback'); }), /intentional rollback/);
    assert.deepEqual(await services[1].get(team.id, owner), before);
  });
  await check('actual_row_lock_blocks_another_pool_until_commit', async () => {
    const held = await pool.connect(); let settled = false; let pending;
    try {
      await held.query('BEGIN');
      await held.query('SELECT state FROM lilly_agent_teams WHERE id=$1 FOR UPDATE', [team.id]);
      pending = services[1].ownerCommand(team.id, owner, 'configure_execution', { enabled: true }, 'blocked-command').finally(() => { settled = true; });
      await delay(75); assert.equal(settled, false);
      await held.query('COMMIT'); await pending;
    } finally { await held.query('ROLLBACK').catch(() => {}); held.release(); }
  });
  await check('concurrent_mutations_do_not_lose_updates', async () => {
    await Promise.all(Array.from({ length: 32 }, (_, i) => [store, secondStore][i % 2].mutate(team.id, owner, state => {
      state.proofCounter = (state.proofCounter || 0) + 1;
    })));
    assert.equal((await services[0].get(team.id, owner)).proofCounter, 32);
  });
  for (const agent of agents) await ownerCommand('assign_task', { agentId: agent.id, title: 'Claim fixture', instruction: 'Never executed.', writeTargets: [`artifact/${agent.id}`] });
  await check('concurrent_admission_across_pools_respects_team_capacity', async () => {
    const batches = await Promise.all(Array.from({ length: 20 }, (_, i) => services[i % 2].claimEnabled(team.id, owner, `claimant-${i}`)));
    const claimed = batches.flat(); assert.equal(claimed.length, 3);
    assert.equal(new Set(claimed.map(task => task.id)).size, 3);
    assert.equal((await services[1].get(team.id, owner)).tasks.filter(task => task.status === 'running').length, 3);
  });
  let lockTeamId;
  await check('same_agent_and_overlapping_write_targets_remain_locked', async () => {
    const lockTeam = await services[0].create(owner, { ...input, name: 'Lock proof', concurrency: 4 }); lockTeamId = lockTeam.id;
    const cmd = (action, body) => services[0].ownerCommand(lockTeam.id, owner, action, body, randomUUID());
    const members = [];
    for (let i = 0; i < 3; i += 1) members.push(await cmd('create_agent', { name: `Lock ${i}`, job: 'Fixture only.' }));
    await cmd('configure_execution', { enabled: true });
    for (const [index, target] of [[0, 'project'], [0, 'elsewhere'], [1, 'project/file'], [2, 'project-other']]) {
      await cmd('assign_task', { agentId: members[index].id, title: target, instruction: 'Never executed.', writeTargets: [target] });
    }
    const claimed = (await Promise.all(Array.from({ length: 16 }, (_, i) => services[i % 2].claimEnabled(lockTeam.id, owner, `locker-${i}`)))).flat();
    assert.equal(claimed.length, 2);
    assert.deepEqual(claimed.map(task => task.writeTargets[0]).sort(), ['project', 'project-other']);
    assert.equal(new Set(claimed.map(task => task.agentId)).size, 2);
    assert.equal((await services[1].get(lockTeam.id, owner)).tasks.filter(task => task.status === 'queued').length, 2);
  });
  await check('unsettled_inventory_includes_disabled_teams_without_exposing_state', async () => {
    const before = await services[0].get(team.id, owner);
    const task = before.tasks.find(value => value.status === 'running');
    await services[0].unobserved(team.id, owner, { taskId: task.id, workerId: task.worker.id, claimId: task.worker.claimId });
    await ownerCommand('configure_execution', { enabled: false }, 'disable-for-inventory');
    const frozen = await services[0].get(team.id, owner);
    assert.equal(frozen.tasks.filter(value => ['running', 'reconciling'].includes(value.status)).length, 3);
    assert.equal(frozen.tasks.filter(value => value.status === 'reconciling').length, 1);
    const first = await store.listUnsettled(); const second = await secondStore.listUnsettled();
    assert.deepEqual(first, second);
    assert.deepEqual(first.map(value => value.id).sort(), [team.id, lockTeamId].sort());
    assert.equal(first.some(value => value.id === skillTeamId), false);
    assert.ok(first.length <= 100);
    for (const row of first) assert.deepEqual(Object.keys(row).sort(), ['id', 'ownerId']);
    assert.equal((await store.listRunnable()).some(value => value.id === team.id), false);
    assert.deepEqual(await services[1].get(team.id, owner), frozen);
  });
  let journalTeam; let journalClaim; let operation;
  const operationInput = { callId: 'proof:tool:1', kind: 'lilly_tool', toolId: 'web-search', fingerprint: 'a'.repeat(64) };
  await check('journal_concurrent_reservation_across_two_pools_has_one_winner', async () => {
    journalTeam = await services[0].create(owner, { ...input, name: 'Journal SQL proof' });
    const cmd = (action, body) => services[0].ownerCommand(journalTeam.id, owner, action, body, randomUUID());
    const member = await cmd('create_agent', { name: 'Journal fixture', job: 'No actual tool or model dispatch.' });
    await cmd('assign_task', { agentId: member.id, title: 'Journal state only', instruction: 'Persistence proof only.' });
    await cmd('configure_execution', { enabled: true });
    const [task] = await services[0].claimEnabled(journalTeam.id, owner, 'journal-proof-worker');
    journalClaim = { taskId: task.id, workerId: task.worker.id, claimId: task.worker.claimId };
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
      services[i % 2].beginOperation(journalTeam.id, owner, journalClaim, operationInput)));
    const winners = attempts.filter(value => value.status === 'fulfilled');
    assert.equal(winners.length, 1); operation = winners[0].value;
    assert.ok(attempts.filter(value => value.status === 'rejected').every(value => value.reason.code === 'team_operation_replayed'));
    const state = await services[1].get(journalTeam.id, owner);
    assert.deepEqual(state.tasks[0].operations, [operation]);
    assert.equal(operation.toolId, 'web-search');
    await assert.rejects(services[1].beginOperation(journalTeam.id, owner, journalClaim,
      { ...operationInput, toolId: 'web-fetch' }), { code: 'team_idempotency_conflict' });
    const changedCallIds = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
      services[i % 2].beginOperation(journalTeam.id, owner, journalClaim, { ...operationInput, callId: `same-effect-${i}` })));
    assert.ok(changedCallIds.every(value => value.status === 'rejected' && value.reason.code === 'team_operations_unsettled'));
    assert.equal((await services[1].get(journalTeam.id, owner)).tasks[0].operations.length, 1);
  });
  await check('journal_unknown_survives_restart_and_fences_result_until_trusted_settlement', async () => {
    const result = { status: 'failed', summary: 'Fixture outcome; no tool was dispatched.' };
    await assert.rejects(services[0].recordResult(journalTeam.id, owner, journalClaim, result), { code: 'team_operations_unsettled' });
    await services[0].settleOperation(journalTeam.id, owner, journalClaim, operation.id, { status: 'unknown' });
    const restarted = new TeamService({ store: secondStore });
    assert.equal((await restarted.get(journalTeam.id, owner)).tasks[0].operations[0].status, 'unknown');
    await assert.rejects(restarted.recordResult(journalTeam.id, owner, journalClaim, result), { code: 'team_operations_unsettled' });
    await assert.rejects(restarted.beginOperation(journalTeam.id, owner, journalClaim, operationInput), { code: 'team_operation_replayed' });
    for (const fingerprint of [operationInput.fingerprint, 'b'.repeat(64)]) {
      await assert.rejects(restarted.beginOperation(journalTeam.id, owner, journalClaim,
        { ...operationInput, callId: 'new-call-after-unknown', fingerprint }), { code: 'team_operations_unsettled' });
    }
    await services[0].ownerCommand(journalTeam.id, owner, 'configure_execution', { enabled: false }, 'journal-disable');
    const settled = await restarted.settleOperation(journalTeam.id, owner, journalClaim, operation.id, { status: 'settled' });
    assert.equal(settled.status, 'settled'); assert.ok(settled.unknownAt); assert.ok(settled.settledAt);
    assert.deepEqual(await services[0].settleOperation(journalTeam.id, owner, journalClaim, operation.id, { status: 'settled' }), settled);
    assert.equal((await restarted.recordResult(journalTeam.id, owner, journalClaim, result)).status, 'failed');
    assert.equal((await store.listUnsettled()).some(value => value.id === journalTeam.id), false);
  });

  const { ArtifactStore } = require('../src/artifacts/artifact-store');
  const { readBackArtifact, readReservedArtifact } = require('../src/agent-teams/worker');
  const artifactStores = [pool, otherPool].map(value => new ArtifactStore({ database: database(value) }));
  assert.equal(require.cache[require.resolve('../src/postgres')], undefined, 'Injected stores must not initialize production DB configuration.');
  // Use the checked-in production artifact table DDL, including its PK and FKs,
  // against this disposable DB only. Sessions are a minimal parent-row fixture.
  const schemaSource = fs.readFileSync(path.resolve(__dirname, '../src/postgres.js'), 'utf8');
  const artifactDdl = schemaSource.match(/CREATE TABLE IF NOT EXISTS artifacts \([\s\S]*?\n\s*\)/)?.[0];
  assert.ok(artifactDdl, 'Production artifact table DDL must be found.');
  await pool.query('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
  await pool.query(artifactDdl);
  let savedOperation; let artifactScope; let artifactClaim; let artifactInput;
  await check('reserved_artifact_lost_response_recovers_exact_bytes_across_pools', async () => {
    const artifactTeam = await services[0].create(owner, { ...input, name: 'Reserved artifact proof' });
    const cmd = (action, body) => services[0].ownerCommand(artifactTeam.id, owner, action, body, randomUUID());
    const agent = await cmd('create_agent', { name: 'Artifact fixture', job: 'Database proof, no model.' });
    await cmd('configure_execution', { enabled: true });
    await cmd('assign_task', { agentId: agent.id, title: 'Save once', instruction: 'Database fixture only.' });
    const [task] = await services[0].claimEnabled(artifactTeam.id, owner, 'artifact-fixture-worker');
    artifactClaim = { taskId: task.id, workerId: task.worker.id, claimId: task.worker.claimId };
    artifactScope = { teamId: artifactTeam.id, ownerId: owner, agentId: agent.id, taskId: task.id };
    savedOperation = await services[0].beginOperation(artifactTeam.id, owner, artifactClaim,
      { callId: 'reserved-artifact', kind: 'artifact_write', fingerprint: 'd'.repeat(64) });
    const bytes = Buffer.from('One durable artifact, verified after its write response was lost.');
    await pool.query('INSERT INTO sessions (id) VALUES ($1)', [agent.sessionId]);
    artifactInput = { id: savedOperation.id, sessionId: agent.sessionId, direction: 'generated', sourceMode: 'agent-teams',
      filename: 'reserved.md', extension: 'md', mimeType: 'text/plain', sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), contentBuffer: bytes,
      metadata: { ...artifactScope, operationId: savedOperation.id, operationFingerprint: savedOperation.fingerprint } };
    await assert.rejects((async () => { await artifactStores[0].create(artifactInput); throw new Error('Simulated lost write response'); })(), /Simulated lost/);
    const read = await artifactStores[1].get(savedOperation.id, { includeContent: true });
    const verified = readReservedArtifact(read, artifactScope, savedOperation);
    assert.equal(verified.content, bytes.toString()); assert.equal(verified.sha256, artifactInput.sha256);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM artifacts WHERE id=$1', [savedOperation.id])).rows[0].count, 1);
    await services[1].settleOperation(artifactTeam.id, owner, artifactClaim, savedOperation.id,
      { status: 'settled', artifact: { id: verified.id, sha256: verified.sha256 } });
    const restarted = new TeamService({ store: secondStore, verifyArtifact: async scope =>
      readBackArtifact(await artifactStores[1].get(scope.artifactId, { includeContent: true }), scope) });
    const result = await restarted.recordResult(artifactTeam.id, owner, artifactClaim,
      { status: 'succeeded', summary: 'Database fixture recovered through read-back.', artifactIds: [verified.id] });
    assert.equal(result.status, 'needs_review');
    assert.deepEqual(result.result.artifacts, [{ id: savedOperation.id, sha256: artifactInput.sha256 }]);
  });
  await check('reserved_artifact_duplicate_insert_never_overwrites_saved_bytes_or_scope', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => artifactStores[index % 2].create({
      ...artifactInput, contentBuffer: Buffer.from('Must not replace the original'), metadata: { ownerId: 'foreign' },
    })));
    assert.ok(attempts.every(value => value.status === 'rejected' && value.reason.code === '23505'));
    const read = await artifactStores[1].get(savedOperation.id, { includeContent: true });
    assert.deepEqual(read.contentBuffer, artifactInput.contentBuffer);
    assert.deepEqual(read.metadata, artifactInput.metadata);
    assert.equal(readReservedArtifact(read, artifactScope, savedOperation).sha256, artifactInput.sha256);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM artifacts')).rows[0].count, 1);
  });
  await check('execution_owner_commits_atomically_with_cross_pool_admission', async () => {
    const { createExecutionOwnerResolver } = require('../src/agent-teams/execution-owner');
    const owners = await Promise.all([createExecutionOwnerResolver({ environment: {} })(), createExecutionOwnerResolver({ environment: {} })()]);
    assert.notEqual(owners[0].bootId, owners[1].bootId);
    assert.equal(owners[0].platform, 'linux'); assert.ok(owners[0].kernel.startTicks);
    const ownerTeam = await services[0].create(owner, { ...input, name: 'Execution ownership', concurrency: 1 });
    const cmd = (action, body) => services[0].ownerCommand(ownerTeam.id, owner, action, body, randomUUID());
    const agent = await cmd('create_agent', { name: 'Owner fixture', job: 'Never executed.' });
    await cmd('configure_execution', { enabled: true });
    await cmd('assign_task', { agentId: agent.id, title: 'Owned task', instruction: 'Database fixture only.' });
    const before = await services[0].get(ownerTeam.id, owner);
    await assert.rejects(services[0].claimEnabled(ownerTeam.id, owner, 'invalid', 1, { bootId: 'bad-owner' }), { code: 'team_execution_owner_invalid' });
    assert.deepEqual(await services[1].get(ownerTeam.id, owner), before);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => services[index % 2]
      .claimEnabled(ownerTeam.id, owner, `owner-runner-${index % 2}`, 1, owners[index % 2])));
    assert.equal(results.flat().length, 1);
    const saved = (await new TeamService({ store: secondStore }).get(ownerTeam.id, owner)).tasks[0];
    const winner = Number(saved.worker.id.slice(-1));
    assert.deepEqual(saved.worker.executionOwner, owners[winner]);
    assert.equal(saved.worker.claimId, results.flat()[0].worker.claimId);
    assert.equal(saved.status, 'running');
    assert.ok(!JSON.stringify(await services[1].context(ownerTeam.id, owner, agent.id)).includes(owners[winner].bootId));
  });
  const { TeamReconciler } = require('../src/agent-teams/reconciler');
  let archiveOwner;
  await check('bound_container_identity_survives_claim_transaction_without_entering_model_context', async () => {
    const { normalizeExecutionOwner } = require('../src/agent-teams/execution-owner');
    const bootId = randomUUID();
    const fixtureOwner = normalizeExecutionOwner({ version: 2, bootId, platform: 'linux', pid: 1,
      startedAt: '2026-09-07T00:00:00.000Z', kernel: { bootId, startTicks: '100', pidNamespace: '1001', mountNamespace: '1002' },
      pod: { namespace: 'kimibuilt', name: 'binding-fixture', uid: bootId, containerName: 'backend' },
      containerBinding: { version: 2, containerId: `containerd://${'a'.repeat(64)}`, nodeName: 'fixture-node', podUid: bootId,
        hostBootId: bootId, initPid: 500, hostPid: 500, initStartTicks: '100', processStartTicks: '100',
        pidNamespace: '1001', mountNamespace: '1002', observedAt: '2026-09-07T00:00:00.000Z',
        cgroup: { path: `/kubepods/pod${bootId}/${'a'.repeat(64)}`, device: '29', inode: '1000' } } });
    // Synthetic binding for schema/transaction proof only; it is not evidence
    // that a live worker or container was inspected by this database verifier.
    const boundTeam = await services[0].create(owner, { ...input, name: 'Bound owner persistence', concurrency: 1 });
    const cmd = (action, body) => services[0].ownerCommand(boundTeam.id, owner, action, body, randomUUID());
    const agent = await cmd('create_agent', { name: 'Binding fixture', job: 'No execution.' });
    await cmd('configure_execution', { enabled: true });
    await cmd('assign_task', { agentId: agent.id, title: 'Persist owner', instruction: 'Database fixture only.' });
    const batches = await Promise.all(Array.from({ length: 20 }, (_, index) => services[index % 2]
      .claimEnabled(boundTeam.id, owner, `bound-runner-${index}`, 1, fixtureOwner)));
    assert.equal(batches.flat().length, 1);
    const saved = (await new TeamService({ store: secondStore }).get(boundTeam.id, owner)).tasks[0];
    assert.deepEqual(saved.worker.executionOwner, fixtureOwner);
    assert.equal(saved.worker.claimId, batches.flat()[0].worker.claimId);
    const context = JSON.stringify(await services[1].context(boundTeam.id, owner, agent.id));
    assert.ok(!context.includes(fixtureOwner.containerBinding.containerId));
    assert.ok(!context.includes(bootId));
    archiveOwner = saved.worker.executionOwner;
  });
  const { ContainerStopStore, ContainerStopArchive, ownerIdentity } = require('../src/agent-teams/container-stop-archive');
  const stopStores = [pool, otherPool].map(value => new ContainerStopStore({ database: database(value) }));
  await stopStores[0].initialize(); await stopStores[1].initialize();
  // Real SQL and production observation logic, but explicitly synthetic CRI and
  // cgroup readers. This does not establish any live container's termination.
  const fixtureStopReaders = executionOwner => ({
    inspectContainer: async () => ({ status: { id: executionOwner.containerBinding.containerId.slice('containerd://'.length),
      state: 'CONTAINER_EXITED', labels: { 'io.kubernetes.pod.uid': executionOwner.pod.uid,
        'io.kubernetes.pod.namespace': executionOwner.pod.namespace, 'io.kubernetes.pod.name': executionOwner.pod.name,
        'io.kubernetes.container.name': executionOwner.pod.containerName } } }),
    readCgroup: async () => ({ identity: executionOwner.containerBinding.cgroup, populated: false,
      hostBootId: executionOwner.containerBinding.hostBootId }),
  });
  let retainedStop;
  await check('stop_archive_concurrent_capture_is_insert_only_across_two_pools', async () => {
    const archives = stopStores.map((stopStore, index) => new ContainerStopArchive({ store: stopStore,
      ...fixtureStopReaders(archiveOwner), now: () => `2026-09-07T00:00:0${index + 1}.000Z` }));
    const captures = await Promise.all(Array.from({ length: 20 }, (_, index) => archives[index % 2].capture(archiveOwner)));
    retainedStop = captures[0];
    assert.equal(retainedStop.stopped, true);
    assert.ok(captures.every(receipt => JSON.stringify(receipt) === JSON.stringify(retainedStop)));
    const rows = await otherPool.query('SELECT receipt FROM lilly_container_stop_receipts WHERE owner_fingerprint=$1', [ownerIdentity(archiveOwner).fingerprint]);
    assert.equal(rows.rowCount, 1); assert.deepEqual(rows.rows[0].receipt, retainedStop);
    // A later observer cannot replace the first record or rewrite its time.
    assert.deepEqual(await stopStores[1].insertOnce({ ...retainedStop, observedAt: '2026-09-07T00:10:00.000Z' }), retainedStop);
    assert.deepEqual(await archives[0].read(archiveOwner), retainedStop);
    archives.forEach(archive => archive.stop());
  });
  await check('stop_archive_survives_reconstruction_and_missing_runtime_resources', async () => {
    let observations = 0;
    const unavailable = async () => { observations += 1; throw new Error('Fixture resources have been removed.'); };
    const archive = new ContainerStopArchive({ store: new ContainerStopStore({ database: database(otherPool) }),
      inspectContainer: unavailable, readCgroup: unavailable });
    const reverseKeys = value => value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseKeys(nested)])) : value;
    assert.deepEqual(await archive.capture(reverseKeys(archiveOwner)), retainedStop);
    assert.equal(await archive.read({ ...archiveOwner, bootId: randomUUID() }), null);
    assert.equal(await archive.read({ ...archiveOwner, containerBinding: { ...archiveOwner.containerBinding,
      cgroup: { ...archiveOwner.containerBinding.cgroup, inode: '1001' } } }), null);
    assert.equal(observations, 0);
    archive.stop();
  });
  await check('stop_archive_recovers_committed_write_after_lost_database_acknowledgement', async () => {
    const lostOwner = { ...archiveOwner, bootId: randomUUID() };
    let lostReply = false; let observations = 0;
    const lostStore = new ContainerStopStore({ database: { query: async (...args) => {
      const result = await pool.query(...args);
      if (args[0].startsWith('INSERT INTO lilly_container_stop_receipts') && !lostReply) {
        lostReply = true; throw new Error('Fixture commit reply was lost.');
      }
      return result;
    } } });
    const readers = fixtureStopReaders(lostOwner);
    const beforeRestart = new ContainerStopArchive({ store: lostStore, ...readers,
      inspectContainer: async (...args) => { observations += 1; return readers.inspectContainer(...args); },
      now: () => '2026-09-07T00:01:00.000Z' });
    await assert.rejects(beforeRestart.capture(lostOwner), { code: 'team_stop_archive_unavailable' });
    assert.equal(lostReply, true); assert.equal(observations, 2);
    beforeRestart.stop();
    const unavailable = async () => { observations += 1; throw new Error('No re-observation allowed.'); };
    const afterRestart = new ContainerStopArchive({ store: stopStores[1], inspectContainer: unavailable, readCgroup: unavailable });
    const recovered = await afterRestart.capture(lostOwner);
    assert.equal(recovered.ownerBootId, lostOwner.bootId); assert.equal(recovered.stopped, true);
    assert.equal(observations, 2);
    assert.equal((await otherPool.query('SELECT count(*)::int AS count FROM lilly_container_stop_receipts WHERE owner_fingerprint=$1',
      [ownerIdentity(lostOwner).fingerprint])).rows[0].count, 1);
    afterRestart.stop();
  });
  const { createExecutionOwnerResolver } = require('../src/agent-teams/execution-owner');
  const recoveryOwner = await createExecutionOwnerResolver({ environment: {} })();
  const recoveryTeam = await services[0].create(owner, { ...input, name: 'Recovery transaction proof', concurrency: 1 });
  const recoveryCommand = (action, body) => services[0].ownerCommand(recoveryTeam.id, owner, action, body, randomUUID());
  const recoveryAgent = await recoveryCommand('create_agent', { name: 'Recovery fixture', job: 'No process or model dispatched.' });
  await recoveryCommand('configure_execution', { enabled: true });
  await recoveryCommand('assign_task', { agentId: recoveryAgent.id, title: 'Recover once', instruction: 'Database fixture only.' });
  const [recoveryTask] = await services[0].claimEnabled(recoveryTeam.id, owner, 'recovery-fixture', 1, recoveryOwner);
  const recoveryClaim = { taskId: recoveryTask.id, workerId: recoveryTask.worker.id, claimId: recoveryTask.worker.claimId };
  // Fixture observer evidence proves controller/transaction behavior, NOT a
  // deployed process's quiescence. No worker was dispatched for this claim.
  const recoveryEvidence = { receiptId: 'fixture-observer-receipt', claimId: recoveryClaim.claimId,
    ownerBootId: recoveryOwner.bootId, ownerStopped: true, workerStopped: true, browserStopped: true };
  let recoveryLease;
  await check('recovery_lease_has_one_winner_across_pools_and_uses_database_clock', async () => {
    const skewed = [new TeamService({ store, now: () => '2099-01-01T00:00:00Z' }), new TeamService({ store: secondStore, now: () => '2000-01-01T00:00:00Z' })];
    const before = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    const leases = await Promise.all(Array.from({ length: 20 }, (_, index) => skewed[index % 2].beginReconciliation(recoveryTeam.id, owner, recoveryClaim,
      { investigatorId: `investigator-${index}`, leaseMs: 1000 })));
    const after = (await otherPool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    assert.equal(leases.filter(Boolean).length, 1); [recoveryLease] = leases.filter(Boolean);
    assert.ok(Date.parse(recoveryLease.startedAt) >= before && Date.parse(recoveryLease.startedAt) <= after);
    assert.equal(Date.parse(recoveryLease.expiresAt) - Date.parse(recoveryLease.startedAt), 1000);
    await assert.rejects(services[1].heartbeat(recoveryTeam.id, owner, recoveryClaim), { code: 'team_claim_required' });
  });
  await check('expired_recovery_cannot_release_after_a_new_investigator_wins', async () => {
    await delay(1100);
    await assert.rejects(services[0].finishReconciliation(recoveryTeam.id, owner, recoveryClaim, recoveryLease.id, recoveryEvidence), { code: 'team_recovery_stale' });
    const next = await services[1].beginReconciliation(recoveryTeam.id, owner, recoveryClaim, { investigatorId: 'successor' });
    assert.notEqual(next.id, recoveryLease.id);
    await assert.rejects(services[0].finishReconciliation(recoveryTeam.id, owner, recoveryClaim, recoveryLease.id, recoveryEvidence), { code: 'team_recovery_stale' });
    const receipts = await Promise.all(Array.from({ length: 20 }, (_, index) => services[index % 2]
      .finishReconciliation(recoveryTeam.id, owner, recoveryClaim, next.id, recoveryEvidence)));
    assert.ok(receipts.every(task => task.status === 'failed'));
    assert.equal(new Set(receipts.map(task => task.result.finishedAt)).size, 1);
    assert.equal((await services[0].get(recoveryTeam.id, owner)).tasks.length, 1);
  });
  await check('recovery_controller_reads_reserved_artifact_from_other_pool_without_repeating_write', async () => {
    await recoveryCommand('assign_task', { agentId: recoveryAgent.id, title: 'Lost write observation', instruction: 'Database fixture only.' });
    const [task] = await services[1].claimEnabled(recoveryTeam.id, owner, 'artifact-recovery-fixture', 1, recoveryOwner);
    const claim = { taskId: task.id, workerId: task.worker.id, claimId: task.worker.claimId };
    const operation = await services[0].beginOperation(recoveryTeam.id, owner, claim, { callId: 'crashed-write', kind: 'artifact_write', fingerprint: 'e'.repeat(64) });
    await pool.query('INSERT INTO sessions (id) VALUES ($1)', [recoveryAgent.sessionId]);
    const contentBuffer = Buffer.from('Saved before fixture executor disappeared.');
    const sha256 = createHash('sha256').update(contentBuffer).digest('hex');
    await artifactStores[0].create({ ...artifactInput, id: operation.id, sessionId: recoveryAgent.sessionId, contentBuffer, sha256, sizeBytes: contentBuffer.length,
      metadata: { teamId: recoveryTeam.id, ownerId: owner, agentId: recoveryAgent.id, taskId: task.id,
        operationId: operation.id, operationFingerprint: operation.fingerprint } });
    await recoveryCommand('control_agent', { agentId: recoveryAgent.id, action: 'stop' });
    await recoveryCommand('configure_execution', { enabled: false });
    const reader = { getArtifact: (id, options) => artifactStores[1].get(id, options) };
    const restarted = new TeamService({ store: secondStore, verifyArtifact: async scope => readBackArtifact(await reader.getArtifact(scope.artifactId, { includeContent: true }), scope) });
    const controller = new TeamReconciler({ service: restarted, artifactService: reader,
      observeQuiescence: async scope => scope.claim.claimId === claim.claimId ? { ...recoveryEvidence, claimId: claim.claimId } : null });
    assert.equal((await controller.tick()).recovered, 1);
    const saved = (await services[0].get(recoveryTeam.id, owner)).tasks.find(item => item.id === task.id);
    assert.equal(saved.status, 'cancelled');
    assert.deepEqual(saved.result.artifacts, [{ id: operation.id, sha256 }]);
    assert.equal(saved.operations[0].status, 'settled');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM artifacts WHERE id=$1', [operation.id])).rows[0].count, 1);
    assert.deepEqual((await artifactStores[0].get(operation.id, { includeContent: true })).contentBuffer, contentBuffer);
    assert.equal((await controller.tick()).recovered, 0);
  });
  await check('recovery_inventory_paginates_real_rows_and_controller_reaches_beyond_first_hundred', async () => {
    const fixtureIds = [];
    for (let index = 0; index < 105; index += 1) {
      const id = randomUUID(); fixtureIds.push(id);
      // Inventory-only rows: no executor, model, browser or external tool runs.
      await store.create({ id, ownerId: owner, execution: { enabled: false }, tasks: [{ id: 'inventory-task',
        agentId: 'fixture-agent', status: 'running', worker: { id: 'fixture-worker', claimId: randomUUID(), executionOwner: recoveryOwner } }] });
    }
    const seen = []; let afterId = null;
    for (let page = 0; page < 5; page += 1) {
      const rows = await secondStore.listUnsettled({ afterId });
      assert.ok(rows.length <= 100);
      if (!rows.length) break;
      assert.ok(rows.every(row => afterId === null || row.id > afterId));
      seen.push(...rows.map(row => row.id)); afterId = rows.at(-1).id;
      // Updates cannot move an already visited ID ahead of the scan cursor.
      await store.mutate(rows[0].id, rows[0].ownerId, state => { state.inventoryProof = true; });
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.ok(fixtureIds.every(id => seen.includes(id)));
    const observed = new Set();
    const controller = new TeamReconciler({ service: services[1], artifactService: {}, maxTasks: 16,
      observeQuiescence: async scope => { observed.add(scope.teamId); return null; } });
    for (let tick = 0; tick < 20; tick += 1) assert.ok((await controller.tick()).inspected <= 16);
    assert.ok(fixtureIds.every(id => observed.has(id)));
    assert.equal((await secondStore.get(fixtureIds[0], owner)).tasks[0].status, 'running');
    controller.stop();
  });
  // Real row locks and persistence, synthetic browser resource identities only.
  // No Pod, browser process, profile lock or live model is created by these checks.
  const computerTeam = await services[0].create(owner, { ...input, name: 'Computer ownership SQL proof', restSeconds: 0 });
  const computerCommand = (action, body) => services[0].ownerCommand(computerTeam.id, owner, action, body, randomUUID());
  const computerAgent = await computerCommand('create_agent', { name: 'Computer fixture', job: 'Database records only.' });
  await computerCommand('configure_execution', { enabled: true });
  await computerCommand('assign_task', { agentId: computerAgent.id, title: 'Browser ownership', instruction: 'Do not dispatch a browser.' });
  const [computerTask] = await services[0].claimEnabled(computerTeam.id, owner, 'computer-fixture', 1, recoveryOwner);
  const computerClaim = { taskId: computerTask.id, workerId: computerTask.worker.id, claimId: computerTask.worker.claimId };
  const computerIdentity = { ownerId: owner, teamId: computerTeam.id, agentId: computerAgent.id, taskId: computerTask.id, claim: computerClaim };
  const computerImage = `registry.example/fixture-browser@sha256:${'f'.repeat(64)}`;
  let computerLease; const pvcUid = randomUUID(); const podUid = randomUUID();
  const computerUpdate = (index, update) => services[index].recordComputerLease(computerIdentity, { leaseId: computerLease.leaseId, ...update });
  await check('computer_reservation_has_one_cross_pool_winner_and_database_timestamp', async () => {
    const skewed = [new TeamService({ store, now: () => '2099-01-01T00:00:00Z' }), new TeamService({ store: secondStore, now: () => '2000-01-01T00:00:00Z' })];
    const before = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => skewed[i % 2]
      .reserveComputerLease(computerIdentity, { leaseId: randomUUID(), image: computerImage })));
    const winners = attempts.filter(value => value.status === 'fulfilled');
    assert.equal(winners.length, 1); computerLease = winners[0].value;
    assert.ok(attempts.filter(value => value.status === 'rejected').every(value => value.reason.code === 'team_computer_lease_conflict'));
    const after = (await otherPool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    assert.ok(Date.parse(computerLease.createdAt) >= before && Date.parse(computerLease.createdAt) <= after);
    const fresh = new TeamService({ store: secondStore });
    assert.deepEqual(await fresh.reserveComputerLease(computerIdentity, { leaseId: computerLease.leaseId, image: computerImage }), computerLease);
    await assert.rejects(fresh.reserveComputerLease({ ...computerIdentity, ownerId: 'foreign' },
      { leaseId: computerLease.leaseId, image: computerImage }), { code: 'team_not_found' });
  });
  await check('computer_identity_binding_rolls_back_conflicts_and_stays_private', async () => {
    await computerUpdate(0, { phase: 'provisioning', pvcUid, podUid });
    const before = await services[1].get(computerTeam.id, owner);
    await assert.rejects(computerUpdate(1, { phase: 'ready', pvcUid: randomUUID(), containerId: `containerd://${'a'.repeat(64)}` }),
      { code: 'team_computer_lease_conflict' });
    assert.deepEqual(await services[0].get(computerTeam.id, owner), before);
    await computerUpdate(1, { phase: 'ready', containerId: `containerd://${'a'.repeat(64)}` });
    const fresh = new TeamService({ store: secondStore }); const state = await fresh.get(computerTeam.id, owner);
    assert.equal(state.computerProfiles[0].pvcUid, pvcUid);
    const { workroomSnapshot } = require('../src/agent-teams/presentation');
    for (const view of [workroomSnapshot(state), await fresh.context(computerTeam.id, owner, computerAgent.id)]) {
      const text = JSON.stringify(view);
      for (const hidden of [pvcUid, podUid, computerLease.leaseId, computerLease.identityHash]) assert.ok(!text.includes(hidden));
    }
  });
  await check('computer_node_binding_survives_jsonb_and_rejects_replacement_across_pools', async () => {
    const current = (await services[0].get(computerTeam.id, owner)).tasks.find(task => task.id === computerTask.id).computerLease;
    const nodeBinding = { version: 1,
      ...Object.fromEntries(['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'].map(key => [key, current[key]])),
      nodeName: 'synthetic-sql-node', hostBootId: randomUUID(), initPid: 321, initStartTicks: '456', pidNamespace: '700', mountNamespace: '701',
      cgroup: { path: `/kubepods/pod${podUid}/${current.containerId.slice(13)}`, device: '0', inode: '987' },
      observedAt: new Date().toISOString() };
    await computerUpdate(0, { phase: 'ready', nodeBinding });
    const fresh = new TeamService({ store: secondStore });
    assert.deepEqual((await fresh.get(computerTeam.id, owner)).tasks.find(task => task.id === computerTask.id).computerLease.nodeBinding, nodeBinding);
    assert.deepEqual((await computerUpdate(1, { phase: 'ready', nodeBinding })).nodeBinding, nodeBinding);
    for (const mutation of [{ initStartTicks: '457' }, { leaseId: randomUUID() }, { cgroup: { ...nodeBinding.cgroup, inode: '988' } }]) {
      await assert.rejects(computerUpdate(1, { phase: 'ready', nodeBinding: { ...nodeBinding, ...mutation } }), { code: 'team_computer_lease_conflict' });
    }
    const saved = await fresh.get(computerTeam.id, owner);
    assert.deepEqual(saved.tasks.find(task => task.id === computerTask.id).computerLease.nodeBinding, nodeBinding);
    const { workroomSnapshot } = require('../src/agent-teams/presentation');
    for (const view of [workroomSnapshot(saved), await fresh.context(computerTeam.id, owner, computerAgent.id)]) {
      assert.ok(!JSON.stringify(view).includes(nodeBinding.hostBootId));
      assert.ok(!JSON.stringify(view).includes(nodeBinding.cgroup.path));
    }
  });
  const { BrowserStopArchive } = require('../src/agent-computer/stop-archive');
  let browserReceipt; let browserReadCount = 0;
  const browserLease = (await services[0].get(computerTeam.id, owner)).tasks.find(task => task.id === computerTask.id).computerLease;
  const browserReaders = { inspectContainer: async () => {
    browserReadCount += 1;
    return { status: { id: browserLease.containerId.slice(13), state: 'CONTAINER_EXITED', labels: {
      'io.kubernetes.pod.uid': browserLease.podUid, 'io.kubernetes.pod.namespace': browserLease.namespace,
      'io.kubernetes.pod.name': browserLease.podName, 'io.kubernetes.container.name': 'worker' } } };
  }, readCgroup: async () => ({ populated: false, hostBootId: browserLease.nodeBinding.hostBootId, identity: browserLease.nodeBinding.cgroup }) };
  await check('computer_stop_receipt_has_one_immutable_cross_pool_result_without_releasing_capacity', async () => {
    const archives = services.map(service => new BrowserStopArchive({ service, reader: browserReaders }));
    const receipts = await Promise.all(Array.from({ length: 20 }, (_, index) => archives[index % 2].capture(computerIdentity)));
    browserReceipt = receipts[0]; assert.ok(browserReceipt.podStopped);
    assert.ok(receipts.every(receipt => JSON.stringify(receipt) === JSON.stringify(browserReceipt)));
    const current = (await services[1].get(computerTeam.id, owner)).tasks.find(task => task.id === computerTask.id).computerLease;
    assert.deepEqual(current.stopEvidence, browserReceipt); assert.equal(current.phase, 'ready');
    const later = { ...browserReceipt, observedAt: new Date(Date.parse(browserReceipt.observedAt) + 1000).toISOString() };
    assert.deepEqual(await services[1].recordComputerStop(computerIdentity, later), browserReceipt);
    await assert.rejects(services[0].recordComputerStop(computerIdentity, { ...browserReceipt, fingerprint: '0'.repeat(64) }), { code: 'team_computer_lease_conflict' });
    const { workroomSnapshot } = require('../src/agent-teams/presentation');
    const state = await services[0].get(computerTeam.id, owner);
    for (const view of [workroomSnapshot(state), await services[1].context(computerTeam.id, owner, computerAgent.id)]) {
      assert.ok(!JSON.stringify(view).includes(browserReceipt.fingerprint));
    }
  });
  await check('computer_stop_receipt_survives_observer_restart_and_missing_runtime_records', async () => {
    const unavailable = async () => { throw new Error('Synthetic runtime records removed'); };
    const restarted = new BrowserStopArchive({ service: new TeamService({ store: secondStore }),
      reader: { inspectContainer: unavailable, readCgroup: unavailable } });
    const before = browserReadCount;
    assert.deepEqual(await restarted.read(computerIdentity), browserReceipt);
    assert.deepEqual(await restarted.capture(computerIdentity), browserReceipt);
    assert.equal(browserReadCount, before);
  });
  let recoveryHelper;
  const savedComputer = async (service = services[1]) => (await service.get(computerTeam.id, owner)).tasks
    .find(task => task.id === computerTask.id).computerLease;
  const helperUpdate = (index, update) => services[index].recordComputerRecoveryHelper(computerIdentity,
    { helperId: recoveryHelper.helperId, ...update });
  await check('recovery_helper_has_one_cross_pool_reservation_and_database_timestamp', async () => {
    await computerUpdate(0, { phase: 'closing' });
    const before = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => services[i % 2]
      .reserveComputerRecoveryHelper(computerIdentity, { helperId: randomUUID(), image: computerImage })));
    const winners = attempts.filter(value => value.status === 'fulfilled');
    assert.equal(winners.length, 1); recoveryHelper = winners[0].value;
    assert.ok(attempts.filter(value => value.status === 'rejected').every(value => value.reason.code === 'team_recovery_helper_conflict'));
    const after = (await otherPool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    assert.ok(Date.parse(recoveryHelper.createdAt) >= before && Date.parse(recoveryHelper.createdAt) <= after);
    const fresh = new TeamService({ store: secondStore });
    assert.deepEqual(await fresh.reserveComputerRecoveryHelper(computerIdentity,
      { helperId: recoveryHelper.helperId, image: computerImage }), recoveryHelper);
    const { workroomSnapshot } = require('../src/agent-teams/presentation');
    for (const view of [workroomSnapshot(await fresh.get(computerTeam.id, owner)), await fresh.context(computerTeam.id, owner, computerAgent.id)]) {
      for (const hidden of [recoveryHelper.helperId, recoveryHelper.podName]) assert.ok(!JSON.stringify(view).includes(hidden));
    }
  });
  await check('recovery_helper_launch_has_one_cross_pool_dispatch_winner', async () => {
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) => services[i % 2].beginComputerRecoveryHelperLaunch(computerIdentity,
      { helperId: recoveryHelper.helperId })));
    assert.equal(attempts.filter(value => value.dispatch).length, 1);
    assert.ok(attempts.every(value => value.helper.phase === 'provisioning'));
    recoveryHelper = attempts[0].helper;
    const fresh = new TeamService({ store: secondStore });
    assert.equal((await fresh.beginComputerRecoveryHelperLaunch(computerIdentity, { helperId: recoveryHelper.helperId })).dispatch, false);
  });
  await check('recovery_helper_lost_launch_reply_reloads_same_intent_without_replacement', async () => {
    // Commit the first launch intent, then simulate a lost reply. No Pod is created.
    const lostReply = async () => {
      const result = await services[0].beginComputerRecoveryHelperLaunch(computerIdentity, { helperId: recoveryHelper.helperId });
      assert.equal(result.dispatch, false);
      throw new Error('Synthetic launch acknowledgment lost after commit');
    };
    await assert.rejects(lostReply(), /Synthetic launch acknowledgment lost/);
    const fresh = new TeamService({ store: secondStore });
    recoveryHelper = (await savedComputer(fresh)).recoveryHelper;
    assert.equal(recoveryHelper.phase, 'provisioning'); assert.ok(recoveryHelper.launchStartedAt);
    assert.deepEqual(await fresh.reserveComputerRecoveryHelper(computerIdentity,
      { helperId: recoveryHelper.helperId, image: computerImage }), recoveryHelper);
    await assert.rejects(fresh.reserveComputerRecoveryHelper(computerIdentity,
      { helperId: randomUUID(), image: computerImage }), { code: 'team_recovery_helper_conflict' });
    recoveryHelper = await helperUpdate(1, { phase: 'provisioning', podUid: randomUUID(), containerId: `containerd://${'d'.repeat(64)}` });
    const lease = await savedComputer();
    // Synthetic runtime identity: this verifies persistence, not a live CRI observation.
    const nodeBinding = { version: 1, podUid: recoveryHelper.podUid, containerId: recoveryHelper.containerId,
      nodeName: lease.nodeBinding.nodeName, hostBootId: lease.nodeBinding.hostBootId, initPid: 444, initStartTicks: '555',
      pidNamespace: '800', mountNamespace: '801', cgroup: {
        path: `/kubepods/pod${recoveryHelper.podUid}/${recoveryHelper.containerId.slice(13)}`, device: '0', inode: '999' },
      observedAt: new Date().toISOString() };
    recoveryHelper = await helperUpdate(0, { phase: 'ready', nodeBinding });
    assert.deepEqual((await savedComputer(fresh)).recoveryHelper, recoveryHelper);
    for (const update of [{ podUid: randomUUID() }, { nodeBinding: { ...nodeBinding, initStartTicks: '556' } }]) {
      await assert.rejects(helperUpdate(1, { phase: 'ready', ...update }), { code: 'team_recovery_helper_conflict' });
    }
    assert.deepEqual((await savedComputer(fresh)).recoveryHelper, recoveryHelper);
  });
  await check('recovery_write_dispatch_has_one_sql_winner_and_retries_only_inspect', async () => {
    const input = { helperId: recoveryHelper.helperId, operationId: randomUUID(), root: { device: '1', inode: '10' }, mountId: '123', pvUid: randomUUID() };
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => services[i % 2].reserveComputerRecoveryWrite(computerIdentity, input)));
    assert.equal(results.filter(value => value.dispatch).length, 1);
    assert.ok(results.every(value => JSON.stringify(value.intent) === JSON.stringify(results[0].intent)));
    const fresh = new TeamService({ store: secondStore });
    assert.deepEqual(await fresh.reserveComputerRecoveryWrite(computerIdentity, input), { dispatch: false, intent: results[0].intent });
    assert.equal((await fresh.reserveComputerRecoveryWrite(computerIdentity, { ...input, operationId: randomUUID() })).dispatch, false);
    for (const change of [{ root: { device: '1', inode: '99' } }, { mountId: '999' }, { pvUid: randomUUID() }]) {
      await assert.rejects(fresh.reserveComputerRecoveryWrite(computerIdentity, { ...input, ...change }), { code: 'team_recovery_write_conflict' });
    }
    assert.deepEqual((await savedComputer(fresh)).recoveryHelper.writeIntent, results[0].intent);
  });
  let profileReceipt;
  await check('computer_profile_recovery_has_one_immutable_cross_pool_receipt_before_release', async () => {
    const { syntheticProfileRecovery } = require('../src/agent-computer/profile-recovery-fixture');
    await computerUpdate(0, { phase: 'closing' });
    await assert.rejects(computerUpdate(1, { phase: 'closed', podStopped: true, profileReleased: true }), { code: 'team_computer_lease_conflict' });
    const lease = (await services[0].get(computerTeam.id, owner)).tasks.find(task => task.id === computerTask.id).computerLease;
    const input = syntheticProfileRecovery(lease); // No live mount or filesystem recovery is asserted by this SQL proof.
    const receipts = await Promise.all(Array.from({ length: 20 }, (_, i) => services[i % 2].recordComputerRecovery(computerIdentity,
      { ...input, observedAt: new Date(Date.parse(input.observedAt) + i).toISOString() })));
    profileReceipt = receipts[0]; assert.ok(receipts.every(value => JSON.stringify(value) === JSON.stringify(profileReceipt)));
    const fresh = new TeamService({ store: secondStore }); const state = await fresh.get(computerTeam.id, owner);
    const saved = state.tasks.find(task => task.id === computerTask.id).computerLease;
    assert.deepEqual(saved.profileRecovery, profileReceipt); assert.equal(saved.phase, 'closing');
    const changed = structuredClone(profileReceipt); changed.filesystem.owner.marker.inode = '99';
    await assert.rejects(services[0].recordComputerRecovery(computerIdentity, changed), { code: 'team_computer_lease_conflict' });
    await assert.rejects(services[1].recordComputerRecovery({ ...computerIdentity, ownerId: 'foreign' }, profileReceipt), { code: 'team_not_found' });
    const { workroomSnapshot } = require('../src/agent-teams/presentation');
    for (const view of [workroomSnapshot(state), await fresh.context(computerTeam.id, owner, computerAgent.id)]) {
      assert.ok(!JSON.stringify(view).includes('verified-pvc-profile-retirement'));
    }
  });
  await check('computer_profile_recovery_lost_reply_is_read_back_without_replaying_helper', async () => {
    // The callback writes through the real second SQL pool, then loses its reply.
    const lostReply = async () => {
      await services[1].recordComputerRecovery(computerIdentity, profileReceipt);
      throw new Error('Synthetic acknowledgment lost after commit');
    };
    await assert.rejects(lostReply(), /Synthetic acknowledgment lost/);
    const fresh = new TeamService({ store: secondStore });
    const saved = (await fresh.get(computerTeam.id, owner)).tasks.find(task => task.id === computerTask.id).computerLease;
    assert.deepEqual(saved.profileRecovery, profileReceipt);
    assert.deepEqual(await fresh.recordComputerRecovery(computerIdentity, profileReceipt), profileReceipt);
  });
  await check('recovery_helper_stop_must_commit_before_browser_capacity_is_released', async () => {
    // Even with both browser receipts, a helper can still write to the volume.
    await assert.rejects(computerUpdate(1, { phase: 'closed', podStopped: true, profileReleased: true }), { code: 'team_computer_lease_conflict' });
    recoveryHelper = await helperUpdate(1, { phase: 'closing' });
    await assert.rejects(helperUpdate(0, { phase: 'closed' }), { code: 'team_recovery_helper_conflict' });
    const { observeRecoveryHelperStop } = require('../src/agent-computer/recovery-helper-observer');
    const stopEvidence = await observeRecoveryHelperStop({ lease: await savedComputer(), reader: {
      // Node inputs are fixtures; exercise the real observer-to-SQL receipt path.
      inspectContainer: async () => ({ status: { id: recoveryHelper.containerId.slice(13), state: 'CONTAINER_EXITED', labels: {
        'io.kubernetes.pod.uid': recoveryHelper.podUid, 'io.kubernetes.pod.namespace': recoveryHelper.namespace,
        'io.kubernetes.pod.name': recoveryHelper.podName, 'io.kubernetes.container.name': 'worker' } } }),
      readCgroup: async () => ({ populated: false, hostBootId: recoveryHelper.nodeBinding.hostBootId, identity: recoveryHelper.nodeBinding.cgroup }),
    } });
    assert.ok(stopEvidence);
    recoveryHelper = await helperUpdate(0, { phase: 'closed', stopEvidence });
    assert.equal(recoveryHelper.closure, 'observed_stopped');
    const fresh = new TeamService({ store: secondStore });
    assert.deepEqual((await savedComputer(fresh)).recoveryHelper, recoveryHelper);
    assert.deepEqual(await helperUpdate(1, { phase: 'closed' }), recoveryHelper);
    await assert.rejects(helperUpdate(1, { phase: 'provisioning' }), { code: 'team_recovery_helper_conflict' });
  });
  await check('computer_cleanup_fences_results_and_preserves_profile_for_next_task', async () => {
    const result = { status: 'cancelled', summary: 'Database fixture; no actual computer was started.', artifactIds: [] };
    await assert.rejects(services[1].recordResult(computerTeam.id, owner, computerClaim, result), { code: 'team_computer_unsettled' });
    await computerCommand('control_agent', { agentId: computerAgent.id, action: 'stop' });
    await computerUpdate(1, { phase: 'closing' });
    await assert.rejects(computerUpdate(0, { phase: 'closed', podStopped: true }), { code: 'team_computer_lease_conflict' });
    const closed = await computerUpdate(0, { phase: 'closed', podStopped: true, profileReleased: true });
    assert.deepEqual(await computerUpdate(1, { phase: 'closed', podStopped: true, profileReleased: true }), closed);
    await services[1].recordResult(computerTeam.id, owner, computerClaim, result);
    await computerCommand('control_agent', { agentId: computerAgent.id, action: 'resume' });
    await computerCommand('assign_task', { agentId: computerAgent.id, title: 'Continue profile', instruction: 'Database fixture only.' });
    const [nextTask] = await services[1].claimEnabled(computerTeam.id, owner, 'next-computer-fixture', 1, recoveryOwner);
    assert.ok(nextTask);
    const nextIdentity = { ...computerIdentity, taskId: nextTask.id,
      claim: { taskId: nextTask.id, workerId: nextTask.worker.id, claimId: nextTask.worker.claimId } };
    const next = await services[0].reserveComputerLease(nextIdentity, { leaseId: randomUUID(), image: computerImage });
    assert.equal(next.pvcName, computerLease.pvcName); assert.equal(next.pvcUid, pvcUid);
    assert.notEqual(next.podName, computerLease.podName); assert.notEqual(next.leaseId, computerLease.leaseId);
    const fresh = new TeamService({ store: secondStore });
    assert.deepEqual((await fresh.get(computerTeam.id, owner)).tasks.find(task => task.id === nextTask.id).computerLease, next);
    await assert.rejects(fresh.recordComputerLease(nextIdentity, { leaseId: computerLease.leaseId, phase: 'closing' }), { code: 'team_computer_lease_conflict' });
  });
  return checks;
}

async function runIsolated(runProof = prove) {
  assert.equal(process.platform, 'linux', 'Isolated container proof requires Linux.');
  assert.equal(typeof runProof, 'function', 'A trusted proof callback is required.');
  const proofId = randomUUID(); const name = `lilly-team-pg-proof-${proofId.slice(0, 8)}`;
  const root = fs.mkdtempSync('/tmp/lilly-team-pg-proof.'); fs.chmodSync(root, 0o700);
  const socket = path.join(root, 'socket'); fs.mkdirSync(socket, { mode: 0o777 }); fs.chmodSync(socket, 0o777);
  const report = { proofId, containerName: name, root, sourceSha256: {}, checks: [], cleaned: false, productionDatabaseAccess: false };
  for (const file of ['bin/lilly-team-postgres-proof.js', 'src/agent-teams/domain.js', 'src/agent-teams/service.js', 'src/agent-teams/store.js',
    'src/agent-teams/worker.js', 'src/agent-teams/computer-lease.js', 'src/agent-computer/node-binding.js',
    'src/agent-computer/stop-evidence.js', 'src/agent-computer/stop-archive.js', 'src/agent-computer/lease-state.js',
    'src/agent-computer/profile-recovery-evidence.js', 'src/agent-computer/profile-recovery-fixture.js',
    'src/agent-computer/recovery-helper.js', 'src/agent-computer/recovery-helper-observer.js',
    'src/agent-computer/recovery-write.js', 'src/agent-computer/recovery-launch.js',
    'src/agent-computer/runtime.js', 'src/agent-computer/profile-lease.js', 'src/agent-teams/presentation.js', 'src/agent-teams/execution-owner.js', 'src/agent-teams/reconciler.js',
    'src/agent-teams/team-wait.js', 'src/agent-teams/cgroup-reader.js', 'src/agent-teams/container-stop.js',
    'src/agent-teams/container-stop-archive.js', 'src/agent-computer/model-loop.js', 'src/artifacts/artifact-store.js', 'src/postgres.js']) {
    report.sourceSha256[file] = createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '..', file))).digest('hex');
  }
  process.stdout.write(`PROOF_HANDLE ${JSON.stringify({ proofId, name, root })}\n`);
  let containerId; const pools = [];
  try {
    const existing = spawnSync('podman', ['container', 'exists', name], { timeout: 10000, encoding: 'utf8' });
    assert.equal(existing.status, 1, 'Exact candidate must be absent before creating.');
    const cached = spawnSync('podman', ['image', 'exists', 'docker.io/library/postgres:16'], { timeout: 10000 });
    assert.ok([0, 1].includes(cached.status), 'Image inventory must succeed.');
    if (cached.status === 1) {
      process.stdout.write('Pulling official PostgreSQL16 image for isolated proof.\n');
      command(['pull', 'docker.io/library/postgres:16'], 180000);
    }
    const image = JSON.parse(command(['image', 'inspect', 'docker.io/library/postgres:16']))[0];
    const digest = image.RepoDigests?.find(value => value.startsWith('docker.io/library/postgres@sha256:'));
    assert.ok(digest, 'A resolved image digest is required.'); report.imageDigest = digest; report.imageId = image.Id;
    containerId = command(['run', '-d', '--name', name, '--label', `lilly.proof-id=${proofId}`, '--network', 'none', '--memory', '512m', '--cpus', '1',
      '--read-only', '--tmpfs', '/var/lib/postgresql/data:rw,size=256m', '--tmpfs', '/tmp:rw,size=16m',
      // Official docker_process_sql deliberately clears PGHOST/PGHOSTADDR.
      // Bind the private host socket at its standard container location:
      // https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh
      '-v', `${socket}:/var/run/postgresql:rw`, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=lilly_team_proof', '-e', 'POSTGRES_DB=lilly_team_proof',
      digest, 'postgres', '-c', 'listen_addresses=', '-c', 'shared_buffers=32MB', '-c', 'max_connections=24'], 30000);
    const inspect = JSON.parse(command(['inspect', containerId]))[0];
    assert.equal(inspect.Config.Labels['lilly.proof-id'], proofId);
    assert.equal(inspect.HostConfig.NetworkMode, 'none');
    assert.equal(inspect.HostConfig.Memory, 512 * 1024 * 1024);
    const cpuLimit = inspect.HostConfig.NanoCpus ? inspect.HostConfig.NanoCpus / 1e9 : inspect.HostConfig.CpuQuota / inspect.HostConfig.CpuPeriod;
    assert.equal(cpuLimit, 1);
    assert.ok(!inspect.HostConfig.PortBindings || Object.keys(inspect.HostConfig.PortBindings).length === 0);
    report.containerId = containerId; report.network = 'none'; report.memoryBytes = inspect.HostConfig.Memory; report.cpuLimit = cpuLimit;
    const { Pool } = require('pg');
    for (let i = 0; i < 2; i += 1) pools.push(new Pool({ host: socket, port: 5432, user: 'lilly_team_proof', database: 'lilly_team_proof', password: 'unused-isolated-proof',
      max: 8, connectionTimeoutMillis: 2000, idleTimeoutMillis: 1000, statement_timeout: 10000, application_name: `lilly-isolated-proof-${i}`, ssl: false }));
    const deadline = Date.now() + 60000;
    while (true) {
      try {
        // Do not connect to entrypoint's short-lived initialization server.
        // /proc/1/exe readlink is ptrace-gated across UIDs; comm is readable
        // without widening capabilities for the fixture's root exec helper.
        assert.equal(command(['exec', containerId, 'cat', '/proc/1/comm'], 5000), 'postgres');
        await pools[0].query('SELECT 1'); break;
      } catch { if (Date.now() >= deadline) throw new Error('Isolated PostgreSQL readiness deadline exceeded.'); await delay(500); }
    }
    report.postgresVersion = (await pools[0].query('SHOW server_version')).rows[0].server_version;
    assert.match(report.postgresVersion, /^16\./);
    report.checks = await runProof(...pools); report.passed = true;
  } catch (error) {
    report.passed = false; report.failure = error.code || error.name || 'proof_failed';
    report.failureMessage = String(error.message).slice(0, 1000);
    process.stderr.write(`PROOF_FAILED ${report.failure}\n`); process.exitCode = 1;
  } finally {
    await Promise.all(pools.map(pool => pool.end()));
    if (containerId) {
      try {
        const current = JSON.parse(command(['inspect', containerId]))[0];
        assert.equal(current.Id, containerId); assert.equal(current.Name.replace(/^\//, ''), name); assert.equal(current.Config.Labels['lilly.proof-id'], proofId);
        if (!report.passed) {
          // This is our disposable, credential-free fixture, never app logs.
          const logs = spawnSync('podman', ['logs', '--tail', '40', containerId], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
          report.databaseLogs = `${logs.stdout || ''}${logs.stderr || ''}`.slice(-6000);
          report.containerState = { status: current.State.Status, exitCode: current.State.ExitCode, oomKilled: current.State.OOMKilled };
        }
        command(['stop', '--time', '5', containerId], 15000);
        command(['rm', containerId], 15000);
        const absence = spawnSync('podman', ['container', 'exists', containerId], { timeout: 10000 });
        assert.equal(absence.status, 1); report.cleaned = true;
      } catch { report.cleanupUnconfirmed = true; process.exitCode = 1; }
    }
    fs.writeFileSync(path.join(root, 'proof-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`PROOF_REPORT ${JSON.stringify(report)}\n`);
  }
  return report;
}

if (require.main === module) {
  assert.deepEqual(process.argv.slice(2), ['--run-isolated'], 'Explicit --run-isolated is required.');
  runIsolated().catch(() => { process.stderr.write('Isolated proof setup failed.\n'); process.exitCode = 1; });
}
module.exports = { prove, runIsolated };
