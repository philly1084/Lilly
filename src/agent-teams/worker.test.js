'use strict';

const { createHash, randomUUID } = require('crypto');
const { TeamService } = require('./service');
const { TeamRunner } = require('./runner');
const { createTeamWorker, readBackArtifact, readReservedArtifact } = require('./worker');
const { TestStore } = require('./test-store');

const toolCall = (name, args, id = randomUUID()) => ({ output: [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id }] });
const final = (text = 'Saved and checked.') => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });

async function setup(extra = {}) {
  const store = new TestStore();
  const records = new Map();
  const sessions = new Map();
  const artifactService = {
    createStoredArtifact: jest.fn(async (input) => {
      const id = input.reservedArtifactId || randomUUID();
      records.set(id, { ...input, id, contentBuffer: input.buffer, sha256: createHash('sha256').update(input.buffer).digest('hex') });
      return records.get(id);
    }),
    getArtifact: jest.fn(async (id) => records.get(id)),
  };
  const sessionStore = { getOrCreateOwned: jest.fn(async (id, metadata) => {
    if (!sessions.has(id)) sessions.set(id, { id, metadata });
    return sessions.get(id);
  }) };
  const service = new TeamService({ store, verifyArtifact: async (scope) => readBackArtifact(await artifactService.getArtifact(scope.artifactId), scope) });
  const team = await service.create('owner', { name: 'Studio', objective: 'Build and review.', restSeconds: 0 });
  const command = (action, input) => service.ownerCommand(team.id, 'owner', action, input, randomUUID());
  await command('configure_execution', { enabled: true, ...extra });
  const writer = await command('create_agent', { name: 'Writer', job: 'Write artifacts.' });
  const reviewer = await command('create_agent', { name: 'Reviewer', role: 'reviewer', job: 'Review artifacts.' });
  return { service, team, command, writer, reviewer, artifactService, sessionStore, records };
}

async function drain(runner) {
  await Promise.all([...runner.active.values()].map((entry) => entry.done));
}

test('completion evidence stays false after draft and becomes true only after final read-back', async () => {
  const env = await setup();
  const loop = async ({ dispatch, hasCompletionEvidence, input }) => {
    expect(input[0].content).toContain('["draft.md","final.md"]');
    expect(await hasCompletionEvidence()).toBe(false);
    await dispatch('artifact_write', { filename: 'draft.md', content: 'Draft' }, { callId: 'draft-write' });
    expect(await hasCompletionEvidence()).toBe(false);
    await dispatch('artifact_write', { filename: 'final.md', content: 'Final' }, { callId: 'final-write' });
    expect(await hasCompletionEvidence()).toBe(true);
    return { summary: 'Both saved' };
  };
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, loop }) });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Deliver', instruction: 'Save both.', requiredArtifacts: ['draft.md', 'final.md'] });
  await runner.tick(); await drain(runner);
  const state = await env.service.get(env.team.id, 'owner');
  expect(state.tasks[0].status).toBe('needs_review');
  expect(state.tasks[0].result.artifacts).toHaveLength(2); runner.stop();
});

test('an explicitly reviewed deliverable cannot finish with only a promise to write', async () => {
  const env = await setup();
  const loop = jest.fn(async ({ hasCompletionEvidence }) => {
    expect(await hasCompletionEvidence()).toBe(false);
    return { summary: 'I will save the draft now.' };
  });
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, loop }) });
  await env.command('assign_task', { agentId: env.writer.id, reviewerId: env.reviewer.id,
    title: 'Save deliverable', instruction: 'Write an artifact for review.' });
  await runner.tick(); await drain(runner);
  const state = await env.service.get(env.team.id, 'owner');
  expect(loop).toHaveBeenCalledTimes(1);
  expect(state.tasks[0].status).not.toBe('needs_review');
  expect(state.tasks[0].status).not.toBe('completed');
  expect(env.artifactService.createStoredArtifact).not.toHaveBeenCalled();
  runner.stop();
});

test('two teammates request, wait, read shared work and reply without polling the model or creating a reply storm', async () => {
  const env = await setup();
  let notifyWait; const waiting = new Promise(resolve => { notifyWait = resolve; });
  let notifyPeer; const peerStarted = new Promise(resolve => { notifyPeer = resolve; });
  let releasePeer; const peerRelease = new Promise(resolve => { releasePeer = resolve; });
  const turns = { writer: 0, reviewer: 0 };
  const results = input => input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));
  const respond = jest.fn(async ({ instructions, input, tools }) => {
    const context = JSON.parse(instructions.slice(instructions.indexOf('\n') + 1));
    const output = results(input);
    if (context.agent.id === env.writer.id) {
      turns.writer += 1;
      if (output.length === 0) return toolCall('artifact_write', { filename: 'draft.md', content: 'A draft for the peer to read.' });
      if (output.length === 1) return toolCall('team_command', { action: 'send_message', input: {
        to: [env.reviewer.id], kind: 'request', body: `Read and review artifact ${output[0].id}. Reply with the review artifact id.`,
      } });
      if (output.length === 2) {
        expect(tools.some(tool => tool.name === 'team_wait')).toBe(true);
        notifyWait();
        return toolCall('team_wait', { afterMessageId: output[1].id, taskIds: output[1].taskIds, timeoutMs: 5000 });
      }
      // The peer may first move queued -> running. Wait again only after an
      // actual task-change event, not repeated model polling while unchanged.
      const observed = output.at(-1);
      if (observed.reason === 'task_changed' && !observed.messages.length) {
        return toolCall('team_wait', { afterMessageId: output[1].id, taskIds: output[1].taskIds, timeoutMs: 5000 });
      }
      if (observed.reason === 'message') {
        expect(observed.messages[0].body).toMatch(/^Reviewed artifact /);
        return toolCall('artifact_write', { filename: 'final.md', content: `Peer confirmation: ${observed.messages[0].body}` });
      }
      return final('Draft and peer-reviewed final saved.');
    }
    turns.reviewer += 1;
    if (output.length === 0) {
      notifyPeer(); await peerRelease;
      const request = context.messages.find(message => message.kind === 'request');
      expect(request.from).toBe(env.writer.id);
      return toolCall('artifact_read', { artifactId: /artifact ([a-f0-9-]+)/.exec(request.body)[1] });
    }
    if (output.length === 1) {
      expect(output[0].content).toBe('A draft for the peer to read.');
      return toolCall('artifact_write', { filename: 'review.md', content: 'Read the stored draft and verified its content.' });
    }
    if (output.length === 2) return toolCall('team_command', { action: 'remember', input: {
      scope: 'team', content: 'The draft was independently read; review is saved.', source: output[1].id,
    } });
    if (output.length === 3) return toolCall('team_command', { action: 'send_message', input: {
      to: [env.writer.id], kind: 'reply', replyTo: context.messages.find(message => message.kind === 'request').id,
      body: `Reviewed artifact ${output[1].id}.`,
    } });
    return final('Review saved and reply delivered.');
  });
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, respond }) });
  try {
    await env.command('assign_task', { agentId: env.writer.id, title: 'Coordinate', instruction: 'Write and ask the peer to review.' });
    await runner.tick(); await waiting;
    await runner.tick(); await peerStarted;
    expect(runner.active.size).toBe(2);
    // Allow the queued->running notification to settle before checking quiet
    // waiting. No provider is involved: this is the real runner/model-loop
    // with scripted inference and in-memory artifact/database adapters.
    await new Promise(resolve => setTimeout(resolve, 50));
    const modelCallsWhileWaiting = turns.writer;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(turns.writer).toBe(modelCallsWhileWaiting);
    releasePeer(); await drain(runner);
    await runner.tick(); await drain(runner);
    const state = await env.service.get(env.team.id, 'owner');
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks.every(task => task.status === 'needs_review')).toBe(true);
    expect(state.messages.map(message => message.kind)).toEqual(['request', 'reply']);
    expect(state.memories.some(memory => memory.scope === 'team' && memory.content.includes('independently read'))).toBe(true);
    expect([...env.records.values()].map(record => record.filename).sort()).toEqual(['draft.md', 'final.md', 'review.md']);
    expect(turns.writer).toBeLessThanOrEqual(6);
    expect(turns.reviewer).toBe(5);
  } finally { releasePeer(); await runner.drain({ timeoutMs: 2000 }); }
});

test('artifact dispatch is reserved durably before writing and stores only identity/hash evidence', async () => {
  const env = await setup();
  const create = env.artifactService.createStoredArtifact.getMockImplementation();
  env.artifactService.createStoredArtifact.mockImplementation(async (input) => {
    const state = await env.service.get(env.team.id, 'owner');
    const operation = state.tasks[0].operations[0];
    expect(operation).toMatchObject({ kind: 'artifact_write', status: 'started', callId: 'write-once' });
    expect(input.metadata.operationId).toBe(operation.id);
    return create(input);
  });
  const respond = jest.fn().mockResolvedValueOnce(toolCall('artifact_write', { filename: 'result.md', content: 'PRIVATE_CONTENT_SENTINEL' }, 'write-once')).mockResolvedValueOnce(final());
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, respond }) });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Write', instruction: 'Save output.' });
  await runner.tick(); await drain(runner);
  const task = (await env.service.get(env.team.id, 'owner')).tasks[0];
  expect(task.status).toBe('needs_review');
  expect(task.operations[0]).toMatchObject({ status: 'settled', artifact: task.result.artifacts[0] });
  expect(JSON.stringify(task.operations)).not.toContain('PRIVATE_CONTENT_SENTINEL');
});

test('lost artifact write response with unavailable read remains unknown and cannot create another artifact', async () => {
  const env = await setup();
  const create = env.artifactService.createStoredArtifact.getMockImplementation();
  env.artifactService.createStoredArtifact.mockImplementation(async (input) => { await create(input); throw new Error('Lost response after commit'); });
  env.artifactService.getArtifact.mockRejectedValue(new Error('Read unavailable'));
  const loop = async ({ dispatch }) => {
    const invoke = () => dispatch('artifact_write', { filename: 'result.md', content: 'Saved once.' }, { callId: 'same-write' });
    await expect(invoke()).rejects.toThrow('Read unavailable');
    await expect(invoke()).rejects.toMatchObject({ code: 'team_operation_replayed' });
    await expect(dispatch('artifact_write', { filename: 'result.md', content: 'Saved once.' }, { callId: 'new-write-id' }))
      .rejects.toMatchObject({ code: 'team_operations_unsettled' });
    expect((await dispatch('team_context', {}, { callId: 'read-context' })).publicResult.team.id).toBe(env.team.id);
    return { summary: 'Unknown output, not proof of completion.' };
  };
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, loop }) });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Write', instruction: 'Save output.' });
  await runner.tick(); await drain(runner);
  const task = (await env.service.get(env.team.id, 'owner')).tasks[0];
  expect(task.status).toBe('reconciling');
  expect(task.operations[0].status).toBe('unknown');
  expect(env.records.size).toBe(1);
  expect(env.artifactService.createStoredArtifact).toHaveBeenCalledTimes(1);
});

test('lost write response recovers the reserved artifact through scoped read-back without repeating the write', async () => {
  const env = await setup();
  const create = env.artifactService.createStoredArtifact.getMockImplementation();
  env.artifactService.createStoredArtifact.mockImplementation(async (input) => { await create(input); throw new Error('Lost response after commit'); });
  const respond = jest.fn().mockResolvedValueOnce(toolCall('artifact_write', { filename: 'recovered.md', content: 'Saved once.' }, 'reserved-write'))
    .mockImplementationOnce(async ({ input }) => {
      const result = JSON.parse(input.find(item => item.type === 'function_call_output').output);
      expect(result.id).toBe([...env.records.keys()][0]);
      expect(result.sha256).toBe(createHash('sha256').update('Saved once.').digest('hex'));
      return final('Recovered saved artifact.');
    });
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, respond }) });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Write', instruction: 'Save output.' });
  await runner.tick(); await drain(runner);
  const task = (await env.service.get(env.team.id, 'owner')).tasks[0];
  expect(task.status).toBe('needs_review');
  expect(task.operations[0]).toMatchObject({ status: 'settled', artifact: task.result.artifacts[0] });
  expect(task.operations[0].id).toBe(task.result.artifacts[0].id);
  expect(env.artifactService.createStoredArtifact).toHaveBeenCalledTimes(1);
  expect(env.records.size).toBe(1);
});

test.each(['missing', 'foreign-operation', 'foreign-fingerprint', 'tampered', 'wrong-id'])('unverifiable reserved write stays unknown: %s', async mode => {
  const env = await setup();
  const create = env.artifactService.createStoredArtifact.getMockImplementation();
  env.artifactService.createStoredArtifact.mockImplementation(async (input) => {
    const record = await create(input);
    if (mode === 'missing') env.records.delete(record.id);
    if (mode === 'foreign-operation') record.metadata.operationId = 'foreign';
    if (mode === 'foreign-fingerprint') record.metadata.operationFingerprint = 'b'.repeat(64);
    if (mode === 'tampered') record.contentBuffer = Buffer.from('Changed bytes');
    if (mode === 'wrong-id') return { ...record, id: 'unreserved' };
    throw new Error('Lost response');
  });
  const respond = jest.fn().mockResolvedValueOnce(toolCall('artifact_write', { filename: 'result.md', content: 'Saved once.' })).mockResolvedValueOnce(final());
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, respond }) });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Write', instruction: 'Save output.' });
  await runner.tick(); await drain(runner);
  const task = (await env.service.get(env.team.id, 'owner')).tasks[0];
  expect(task.status).toBe('reconciling');
  expect(task.operations[0].status).toBe('unknown');
  expect(env.artifactService.createStoredArtifact).toHaveBeenCalledTimes(1);
});

test.each(['id', 'sourceMode', 'direction', 'ownerId', 'teamId', 'agentId', 'taskId', 'operationId', 'operationFingerprint'])('reserved read-back rejects foreign %s', key => {
  const scope = { ownerId: 'owner', teamId: 'team', agentId: 'agent', taskId: 'task' };
  const operation = { id: 'reserved', fingerprint: 'a'.repeat(64) };
  const contentBuffer = Buffer.from('Verified');
  const artifact = { id: operation.id, sourceMode: 'agent-teams', direction: 'generated', contentBuffer,
    sha256: createHash('sha256').update(contentBuffer).digest('hex'),
    metadata: { ...scope, operationId: operation.id, operationFingerprint: operation.fingerprint } };
  expect(readReservedArtifact(artifact, scope, operation).id).toBe(operation.id);
  if (['id', 'sourceMode', 'direction'].includes(key)) artifact[key] = 'foreign';
  else artifact.metadata[key] = 'foreign';
  expect(() => readReservedArtifact(artifact, scope, operation)).toThrow();
});

test.each(['artifact_write', 'lilly_tool'])('reordered effective arguments cannot duplicate a pending %s', async (kind) => {
  const env = await setup({ toolIds: ['web-search'] });
  let entered; let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const create = env.artifactService.createStoredArtifact.getMockImplementation();
  env.artifactService.createStoredArtifact.mockImplementation(async (input) => {
    entered(); await pending; return create(input);
  });
  const toolManager = { getTool: () => ({ inputSchema: {} }), executeTool: jest.fn(async () => {
    entered(); await pending; return { success: true };
  }) };
  const first = kind === 'artifact_write' ? { filename: 'once.md', content: 'Once.' }
    : { toolId: 'web-search', params: { query: 'fixture', options: { first: 1, second: 2 }, sites: ['a', 'b'] } };
  const reordered = kind === 'artifact_write' ? { content: 'Once.', filename: 'once.md', ignored: 'not an effect' }
    : { params: { sites: ['a', 'b'], options: { second: 2, first: 1 }, query: 'fixture' }, toolId: 'web-search', ignored: true };
  const loop = async ({ dispatch }) => {
    const work = dispatch(kind, first, { callId: 'original' });
    await started;
    try {
      await expect(dispatch(kind, reordered, { callId: 'changed-id' })).rejects.toMatchObject({ code: 'team_operations_unsettled' });
      await expect(dispatch(kind, reordered, { callId: 'original' })).rejects.toMatchObject({ code: 'team_operation_replayed' });
    } finally { release(); await work; }
    return { summary: 'One dispatch settled.' };
  };
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, loop, toolManager,
    authorizeTool: async () => true, observeToolSettlement: async () => true }) });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Once', instruction: 'Fixture only.' });
  await runner.tick(); await drain(runner);
  const task = (await env.service.get(env.team.id, 'owner')).tasks[0];
  expect(task.operations).toHaveLength(1);
  expect(task.status).toBe('needs_review');
  expect(task.operations[0].status).toBe('settled');
  expect(kind === 'artifact_write' ? env.artifactService.createStoredArtifact : toolManager.executeTool).toHaveBeenCalledTimes(1);
});

test('journal persistence failure prevents external dispatch', async () => {
  const env = await setup();
  jest.spyOn(env.service, 'beginOperation').mockRejectedValue(new Error('Persistence unavailable'));
  const respond = jest.fn().mockResolvedValueOnce(toolCall('artifact_write', { filename: 'result.md', content: 'Never stored.' })).mockResolvedValueOnce(final('Write failed.'));
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, respond }) });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Write', instruction: 'Save output.' });
  await runner.tick(); await drain(runner);
  expect(env.artifactService.createStoredArtifact).not.toHaveBeenCalled();
});

test.each(['reservation', 'heartbeat'])('cancellation during %s persistence prevents late artifact dispatch', async (stage) => {
  const env = await setup();
  const controller = new AbortController();
  const reserve = env.service.beginOperation.bind(env.service);
  const heartbeat = env.service.heartbeat.bind(env.service);
  let reserved = false;
  jest.spyOn(env.service, 'beginOperation').mockImplementation(async (...args) => {
    const reservation = await reserve(...args);
    reserved = true;
    if (stage === 'reservation') controller.abort();
    return reservation;
  });
  jest.spyOn(env.service, 'heartbeat').mockImplementation(async (...args) => {
    const status = await heartbeat(...args);
    if (reserved && stage === 'heartbeat') controller.abort();
    return status;
  });
  const loop = async ({ dispatch }) => {
    await expect(dispatch('artifact_write', { filename: 'result.md', content: 'Never written.' }, { callId: 'cancelled-write', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'team_worker_cancelled' });
    return { summary: 'Reservation cancelled before dispatch.' };
  };
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, loop }) });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Write', instruction: 'Save output.' });
  await runner.tick(); await drain(runner);
  expect(env.artifactService.createStoredArtifact).not.toHaveBeenCalled();
  expect((await env.service.get(env.team.id, 'owner')).tasks[0].operations[0].status).toBe('settled');
});

test('a generic tool job handle is not terminal settlement without a dedicated observer', async () => {
  const env = await setup({ toolIds: ['remote-command'] });
  const toolManager = { getTool: () => ({ inputSchema: {} }), executeTool: jest.fn(async () => ({ status: 'running', jobId: 'external-job' })) };
  const respond = jest.fn().mockResolvedValueOnce(toolCall('lilly_tool', { toolId: 'remote-command', params: { command: 'fixture-only' } })).mockResolvedValueOnce(final('Job accepted.'));
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, respond, toolManager, authorizeTool: async () => true }) });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Run', instruction: 'Fixture job.' });
  await runner.tick(); await drain(runner);
  const task = (await env.service.get(env.team.id, 'owner')).tasks[0];
  expect(toolManager.executeTool).toHaveBeenCalledTimes(1);
  expect(task.status).toBe('reconciling');
  expect(task.operations[0]).toMatchObject({ kind: 'lilly_tool', status: 'unknown' });
});

test.each([true, false])('browser no-dispatch provenance, not an error code, controls journal settlement (%s)', async (beforeDispatch) => {
  const env = await setup({ origins: ['https://fixture.test'], allowSideEffects: true });
  const error = Object.assign(new Error('Stale frame'), { code: 'computer_stale_frame' });
  const proven = new WeakSet(beforeDispatch ? [error] : []);
  const computer = { act: jest.fn(async () => { throw error; }), isPreDispatchFailure: value => proven.has(value) };
  const respond = jest.fn().mockResolvedValueOnce(toolCall('computer_act', { computerId: 'owned', frameId: 'stale', action: { type: 'click', x: 1, y: 1 } })).mockResolvedValueOnce(final('Need a fresh observation.'));
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, respond, computer, visionEnabled: true }) });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Inspect', instruction: 'Use private browser.' });
  await runner.tick(); await drain(runner);
  const task = (await env.service.get(env.team.id, 'owner')).tasks[0];
  expect(task.operations[0].status).toBe(beforeDispatch ? 'settled' : 'unknown');
  expect(task.status).toBe(beforeDispatch ? 'needs_review' : 'reconciling');
});

test('approved acceptance checks are pinned into worker input and independent reviewer assignment', async () => {
  const env = await setup();
  const skill = await env.command('save_skill', { name: 'Evidence', instructions: 'Write checked output.', acceptance: 'Include a reproducible checksum.' });
  await env.command('approve_skill', { skillId: skill.id });
  const task = await env.command('assign_task', { agentId: env.writer.id, reviewerId: env.reviewer.id,
    title: 'Build', instruction: 'Produce a report.', skillId: skill.id });
  const revised = await env.command('save_skill', { name: 'Evidence', instructions: 'New method.', acceptance: 'Changed criterion.', replaces: skill.id });
  await env.command('approve_skill', { skillId: revised.id });
  const respond = jest.fn().mockImplementationOnce(async ({ input }) => {
    expect(input[0].content).toContain('Acceptance checks:\nInclude a reproducible checksum.');
    expect(input[0].content).not.toContain('Changed criterion.');
    return toolCall('artifact_write', { filename: 'report.md', content: 'Report with evidence.' });
  }).mockResolvedValueOnce(final());
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, respond }) });
  await runner.tick(); await drain(runner);
  const state = await env.service.get(env.team.id, 'owner');
  const review = state.tasks.find((entry) => entry.reviewOf === task.id);
  expect(review.instruction).toContain('Pinned skill revision 1 acceptance checks:\nInclude a reproducible checksum.');
  expect(review.instruction).not.toContain('Changed criterion.');
  expect(review.instruction).toContain(`Use team_task with taskId ${task.id}`);
  expect(state.tasks.find((entry) => entry.id === task.id).status).toBe('needs_review');
});

test('team_task reads full assignment and pinned criteria without another task claim or session', async () => {
  const env = await setup();
  const skill = await env.command('save_skill', { name: 'Review', instructions: 'Inspect all output.', acceptance: 'Verify final requirement.' });
  await env.command('approve_skill', { skillId: skill.id });
  const source = await env.command('assign_task', { agentId: env.writer.id, title: 'Large task', instruction: 'A'.repeat(11000) + 'FINAL REQUIREMENT', skillId: skill.id });
  await env.service.store.mutate(env.team.id, 'owner', (team) => {
    const task = team.tasks.find((entry) => entry.id === source.id);
    task.status = 'reconciling'; task.worker = { claimId: 'PRIVATE_CLAIM', id: 'PRIVATE_WORKER' };
    task.engineLease = { token: 'PRIVATE_TOKEN' };
    task.computerLease = { podUid: 'PRIVATE_BROWSER_POD' };
  });
  await env.command('assign_task', { agentId: env.reviewer.id, title: 'Inspect task', instruction: 'Read the source task.' });
  const respond = jest.fn().mockResolvedValueOnce(toolCall('team_task', { taskId: source.id }))
    .mockImplementationOnce(async ({ input }) => {
      const output = input.find((item) => item.type === 'function_call_output').output;
      const detail = JSON.parse(output);
      expect(detail.instruction.endsWith('FINAL REQUIREMENT')).toBe(true);
      expect(detail.skill.acceptance).toBe('Verify final requirement.');
      expect(output).not.toContain('PRIVATE_');
      return toolCall('team_task', { taskId: 'foreign-task' });
    }).mockImplementationOnce(async ({ input }) => {
      expect(JSON.parse(input.filter((item) => item.type === 'function_call_output').at(-1).output).success).toBe(false);
      return final('Scoped task inspected.');
    });
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, respond }) });
  await runner.tick(); await drain(runner);
  expect(respond).toHaveBeenCalledTimes(3);
});

test('review cannot approve replacement bytes under a previously recorded artifact id', async () => {
  const env = await setup();
  const original = await env.command('assign_task', { agentId: env.writer.id, reviewerId: env.reviewer.id, title: 'Draft', instruction: 'Write.' });
  const write = createTeamWorker({ ...env, respond: jest.fn()
    .mockResolvedValueOnce(toolCall('artifact_write', { filename: 'draft.md', content: 'Original bytes.' }))
    .mockResolvedValueOnce(final()) });
  const runner = new TeamRunner({ service: env.service, execute: write });
  await runner.tick(); await drain(runner);
  const artifact = [...env.records.values()][0];
  artifact.contentBuffer = Buffer.from('Replacement bytes.');
  artifact.sha256 = createHash('sha256').update(artifact.contentBuffer).digest('hex');
  const reviewModel = jest.fn().mockResolvedValueOnce(toolCall('artifact_read', { artifactId: artifact.id }))
    .mockResolvedValueOnce(toolCall('team_command', { action: 'review_task', input: { taskId: original.id, approved: true, note: 'Read replacement.' } }))
    .mockImplementationOnce(async ({ input }) => {
      expect(JSON.parse(input.filter((item) => item.type === 'function_call_output').at(-1).output).success).toBe(false);
      return final('Approval refused.');
    });
  runner.execute = createTeamWorker({ ...env, respond: reviewModel });
  await runner.tick(); await drain(runner);
  expect((await env.service.get(env.team.id, 'owner')).tasks.find((task) => task.id === original.id).status).toBe('needs_review');
});

test('runner executes a persisted handoff through tools and verified artifact read-back', async () => {
  const env = await setup();
  const { service, team, writer, reviewer, command, records } = env;
  let artifactId;
  const respond = jest.fn(async ({ input, instructions }) => {
    const context = JSON.parse(instructions.slice(instructions.indexOf('\n') + 1));
    const outputs = input.filter((item) => item.type === 'function_call_output');
    if (context.agent.id === writer.id) {
      if (!outputs.length) return toolCall('artifact_write', { filename: 'draft.md', content: '# Draft\nA real stored fixture.' });
      if (outputs.length === 1) {
        artifactId = JSON.parse(outputs[0].output).id;
        return toolCall('team_command', { action: 'send_message', input: { to: [reviewer.id], kind: 'request', body: `Review artifact:${artifactId}` } });
      }
      return final('Draft saved and sent for review.');
    }
    if (!outputs.length) return toolCall('artifact_read', { artifactId });
    if (outputs.length === 1) {
      expect(JSON.parse(outputs[0].output).content).toContain('A real stored fixture.');
      return toolCall('artifact_write', { filename: 'review.md', content: 'Read the stored draft. It contains the requested fixture.' });
    }
    return final('Review saved.');
  });
  const execute = createTeamWorker({ ...env, respond });
  const runner = new TeamRunner({ service, execute });
  await command('assign_task', { agentId: writer.id, title: 'Draft', instruction: 'Write the draft and ask Reviewer to review.' });
  await runner.tick(); await drain(runner);
  let state = await service.get(team.id, 'owner');
  expect(state.tasks.map((task) => task.status)).toEqual(['needs_review', 'queued']);
  await runner.tick(); await drain(runner);
  state = await service.get(team.id, 'owner');
  expect(state.tasks.every((task) => task.status === 'needs_review')).toBe(true);
  expect(state.tasks.every((task) => task.result.artifacts.length === 1)).toBe(true);
  expect(state.messages[0]).toMatchObject({ from: writer.id, to: [reviewer.id] });
  expect(records.size).toBe(2);
  expect((await service.context(team.id, 'owner', reviewer.id)).artifacts).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: artifactId, agentId: writer.id }),
  ]));
  expect(state.events.some((event) => event.tool === 'artifact_read')).toBe(true);
  expect(JSON.stringify(state.events)).not.toContain('A real stored fixture.');
});

test('private browser image reaches model while persisted activity excludes pixels', async () => {
  const env = await setup({ origins: ['https://fixture.test'], allowSideEffects: true });
  const image = 'data:image/png;base64,cGl4ZWxz';
  const computer = {
    open: jest.fn(async () => ({ computerId: 'owned', frameId: 'frame1', private: true })),
    getModelInput: jest.fn(async () => [{ type: 'input_image', image_url: image }]),
  };
  const respond = jest.fn().mockResolvedValueOnce(toolCall('computer_open', { url: 'https://fixture.test' })).mockImplementationOnce(async ({ input }) => {
    expect(input.at(-1).content[0].image_url).toBe(image);
    return final('Observed the private page.');
  });
  const execute = createTeamWorker({ ...env, respond, computer, visionEnabled: true });
  const runner = new TeamRunner({ service: env.service, execute });
  await env.command('assign_task', { agentId: env.writer.id, title: 'See', instruction: 'Observe approved page.' });
  await runner.tick(); await drain(runner);
  expect(computer.open).toHaveBeenCalledWith({ ownerId: 'owner', teamId: env.team.id, agentId: env.writer.id,
    claim: expect.objectContaining({ taskId: expect.any(String), workerId: expect.any(String), claimId: expect.any(String) }) }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(JSON.stringify((await env.service.get(env.team.id, 'owner')).events)).not.toContain('data:image');
});

test('stopped task receives cancellation and uncertain result stays reserved for reconciliation', async () => {
  const env = await setup();
  let signal;
  const execute = jest.fn((input) => {
    signal = input.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('unknown outcome')), { once: true }));
  });
  const runner = new TeamRunner({ service: env.service, execute });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Work', instruction: 'Work.' });
  await runner.tick();
  await env.command('control_agent', { agentId: env.writer.id, action: 'stop' });
  await runner.tick(); await drain(runner);
  expect(signal.aborted).toBe(true);
  expect((await env.service.get(env.team.id, 'owner')).tasks[0].status).toBe('reconciling');
  await env.command('control_agent', { agentId: env.writer.id, action: 'resume' });
  await runner.tick();
  expect(execute).toHaveBeenCalledTimes(1);
});

test('process capacity does not claim tasks it cannot start', async () => {
  const env = await setup();
  const pending = [];
  const execute = jest.fn(() => new Promise((resolve) => pending.push(resolve)));
  const runner = new TeamRunner({ service: env.service, execute, maxActive: 1 });
  for (const agent of [env.writer, env.reviewer]) await env.command('assign_task', { agentId: agent.id, title: 'Work', instruction: 'Work.' });
  await runner.tick();
  expect((await env.service.get(env.team.id, 'owner')).tasks.map((task) => task.status)).toEqual(['running', 'queued']);
  pending[0]({ status: 'failed', summary: 'Fixture ended.', artifactIds: [] });
  await drain(runner);
});

test('ordinary Lilly tools remain denied unless the server policy grants them', async () => {
  const env = await setup({ toolIds: ['remote-command'] });
  const toolManager = { getTool: jest.fn(() => ({ inputSchema: {} })), executeTool: jest.fn() };
  const respond = jest.fn().mockResolvedValueOnce(toolCall('lilly_tool', { toolId: 'remote-command', params: { command: 'never-run' } })).mockResolvedValueOnce(final('Could not run.'));
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, respond, toolManager }) });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Work', instruction: 'Work.' });
  await runner.tick(); await drain(runner);
  expect(toolManager.executeTool).not.toHaveBeenCalled();
});

test('artifact verifier rejects foreign task/team and tampered bytes', () => {
  const contentBuffer = Buffer.from('original');
  const artifact = { id: 'a', metadata: { ownerId: 'o', teamId: 't', taskId: 'job' }, contentBuffer,
    sha256: createHash('sha256').update(contentBuffer).digest('hex') };
  expect(() => readBackArtifact(artifact, { ownerId: 'o', teamId: 'foreign' })).toThrow('accessible');
  expect(() => readBackArtifact(artifact, { ownerId: 'o', teamId: 't', taskId: 'other-job' })).toThrow('accessible');
  expect(() => readBackArtifact({ ...artifact, contentBuffer: Buffer.from('tampered') }, { ownerId: 'o', teamId: 't' })).toThrow('integrity');
});

test('independent reviewer is queued automatically and must read before approving', async () => {
  const env = await setup();
  const { service, team, writer, reviewer, command } = env;
  const original = await command('assign_task', { agentId: writer.id, reviewerId: reviewer.id,
    title: 'Deliver', instruction: 'Save the deliverable.' });
  let artifactId;
  const respond = jest.fn(async ({ input, instructions }) => {
    const context = JSON.parse(instructions.slice(instructions.indexOf('\n') + 1));
    const outputs = input.filter((item) => item.type === 'function_call_output');
    if (context.agent.id === writer.id) {
      if (!outputs.length) return toolCall('artifact_write', { filename: 'deliverable.md', content: 'Evidence-backed deliverable.' });
      artifactId = JSON.parse(outputs[0].output).id;
      return final();
    }
    if (!outputs.length) return toolCall('team_command', { action: 'review_task', input: { taskId: original.id, approved: true, note: 'Attempt before reading.' } });
    if (outputs.length === 1) {
      expect(JSON.parse(outputs[0].output).success).toBe(false);
      return toolCall('artifact_read', { artifactId });
    }
    if (outputs.length === 2) return toolCall('team_command', { action: 'review_task', input: { taskId: original.id, approved: true, note: 'Read saved bytes; matches requested deliverable.' } });
    return final('Reviewed.');
  });
  const runner = new TeamRunner({ service, execute: createTeamWorker({ ...env, respond }) });
  await runner.tick(); await drain(runner);
  expect((await service.get(team.id, 'owner')).tasks[1]).toMatchObject({ agentId: reviewer.id, reviewOf: original.id, status: 'queued' });
  await runner.tick(); await drain(runner);
  expect((await service.get(team.id, 'owner')).tasks[0].status).toBe('completed');
});

test.each([false, true])('worker awaits claim cleanup before returning, including loop failure=%s', async loopFails => {
  const env = await setup(); const failure = new Error('Fixture loop failed');
  let entered; const cleanupEntered = new Promise(resolve => { entered = resolve; });
  let release; const cleanup = new Promise(resolve => { release = resolve; });
  const computer = { releaseClaim: jest.fn(async () => { entered(); await cleanup; }) };
  await env.command('assign_task', { agentId: env.writer.id, title: 'Cleanup', instruction: 'Fixture only.' });
  const [task] = await env.service.claimEnabled(env.team.id, 'owner', 'cleanup-worker');
  const claim = { taskId: task.id, workerId: task.worker.id, claimId: task.worker.claimId };
  const execute = createTeamWorker({ ...env, computer, loop: async () => {
    if (loopFails) throw failure;
    return { summary: 'Loop finished' };
  } });
  let settled = false;
  const result = execute({ teamId: env.team.id, ownerId: 'owner', task, claim })
    .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  await cleanupEntered;
  expect(settled).toBe(false);
  expect(computer.releaseClaim).toHaveBeenCalledWith({ teamId: env.team.id, ownerId: 'owner', agentId: env.writer.id, claim });
  release(); const observed = await result;
  if (loopFails) expect(observed.error).toBe(failure);
  else expect(observed.value.status).toBe('succeeded');
});

test('failed browser cleanup prevents a successful worker report', async () => {
  const env = await setup(); const failure = Object.assign(new Error('Fixture cleanup unknown'), { code: 'computer_cleanup_unconfirmed' });
  const computer = { releaseClaim: jest.fn(async () => { throw failure; }) };
  await env.command('assign_task', { agentId: env.writer.id, title: 'Cleanup', instruction: 'Fixture only.' });
  const [task] = await env.service.claimEnabled(env.team.id, 'owner', 'cleanup-worker');
  const claim = { taskId: task.id, workerId: task.worker.id, claimId: task.worker.claimId };
  const execute = createTeamWorker({ ...env, computer, loop: async () => ({ summary: 'Not completion evidence' }) });
  await expect(execute({ teamId: env.team.id, ownerId: 'owner', task, claim })).rejects.toBe(failure);
});

test('team command results strip private browser ownership records', async () => {
  const env = await setup();
  jest.spyOn(env.service, 'workerCommand').mockResolvedValue({ id: 'fixture-result',
    computerLease: { podUid: 'PRIVATE_BROWSER_POD', pvcUid: 'PRIVATE_BROWSER_PROFILE' } });
  const loop = async ({ dispatch }) => {
    const result = await dispatch('team_command', { action: 'send_message', input: {} }, { callId: 'privacy-check' });
    expect(result).toEqual({ publicResult: { id: 'fixture-result' } });
    return { summary: 'Fixture privacy checked' };
  };
  const runner = new TeamRunner({ service: env.service, execute: createTeamWorker({ ...env, loop }) });
  await env.command('assign_task', { agentId: env.writer.id, title: 'Privacy', instruction: 'Fixture only.' });
  await runner.tick(); await drain(runner);
  expect(env.service.workerCommand).toHaveBeenCalledTimes(1);
});
