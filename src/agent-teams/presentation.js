'use strict';

// A display contract, deliberately separate from durable execution state.
// Never spread agents/tasks/events into an operator response: new internal
// fields (claims, leases, ACP sessions, private computer data) stay private.
const strings = (source, keys) => Object.fromEntries(keys.filter((key) => typeof source?.[key] === 'string')
  .map((key) => [key, source[key]]));
const stringList = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
const list = (value) => Array.isArray(value) ? value : [];
const eventTypes = new Set(['agent.created', 'agent.updated', 'agent.stop', 'agent.resume', 'task.queued', 'task.reviewed',
  'execution.configured', 'message.sent', 'memory.saved', 'memory.forgotten', 'memory.updated',
  'skill.drafted', 'skill.approved', 'routine.created', 'routine.enabled', 'routine.paused',
  'model_started', 'model_finished', 'tool_started', 'tool_finished', 'tool_failed', 'bridge_ready', 'bridge_closed']);

function savedArtifacts(task) {
  const artifacts = list(task.result?.artifacts).map(artifact => ({
    ...strings(artifact, ['id', 'sha256']), taskId: task.id, agentId: task.agentId, reviewStatus: task.status,
  }));
  const seen = new Set(artifacts.map(artifact => artifact.id));
  for (const operation of list(task.operations)) {
    const artifact = operation.artifact;
    // A write intent or model summary is not a saved file. Settlement follows
    // authenticated byte read-back; expose only its artifact ID/hash, never the
    // operation journal, call fingerprint, browser data, paths or credentials.
    if (operation.kind !== 'artifact_write' || operation.status !== 'settled'
      || !artifact || artifact.id !== operation.id || seen.has(artifact.id)
      || !/^[A-Za-z0-9:_-]{1,160}$/.test(artifact.id || '') || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '')) continue;
    seen.add(artifact.id);
    artifacts.push({ id: artifact.id, sha256: artifact.sha256, taskId: task.id, agentId: task.agentId,
      // Even a completed task cannot approve an output omitted from its review.
      reviewStatus: 'unreviewed' });
  }
  return artifacts;
}

function workroomSnapshot(team, now = new Date().toISOString()) {
  const tasks = list(team.tasks).map((task) => ({
    ...strings(task, ['id', 'agentId', 'title', 'instruction', 'status', 'createdAt', 'cancelRequestedAt',
      'reviewOf', 'reviewerId', 'reviewTaskId', 'reviewQueueIssue']),
    dependencies: stringList(task.dependencies), writeTargets: stringList(task.writeTargets),
    requiredArtifacts: stringList(task.requiredArtifacts),
    heartbeatAt: typeof task.worker?.heartbeatAt === 'string' ? task.worker.heartbeatAt : null,
    skill: task.skill ? { ...strings(task.skill, ['id']), revision: task.skill.revision } : null,
    result: task.result ? {
      ...strings(task.result, ['summary', 'finishedAt']),
      artifacts: list(task.result.artifacts).map((artifact) => strings(artifact, ['id', 'sha256'])),
    } : null,
    review: task.review ? { ...strings(task.review, ['note', 'at']), approved: task.review.approved === true } : null,
  }));
  const events = list(team.events).filter((entry) => eventTypes.has(entry.type)).map((entry) => ({
    ...strings(entry, ['id', 'type', 'at', 'actorId', 'agentId', 'taskId']),
    ...(typeof entry.tool === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(entry.tool) ? { tool: entry.tool } : {}),
    // Call IDs are correlation only; do not expose arbitrary model text.
    ...(typeof entry.callId === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(entry.callId) ? { callId: entry.callId } : {}),
  }));
  const agents = list(team.agents).map((agent) => {
    const ownTasks = tasks.filter((task) => task.agentId === agent.id);
    const current = ownTasks.find((task) => task.status === 'reconciling')
      || ownTasks.find((task) => task.status === 'running');
    const pending = ownTasks.find((task) => task.status === 'queued');
    let status = 'idle';
    if (current) status = current.status === 'running' && current.cancelRequestedAt ? 'stopping' : current.status;
    else if (!agent.enabled) status = 'stopped';
    else if (!team.execution?.enabled) status = 'paused';
    else if (Date.parse(agent.restUntil) > Date.parse(now)) status = 'resting';
    else if (pending) status = pending.dependencies.some((id) => tasks.find((task) => task.id === id)?.status !== 'completed') ? 'waiting' : 'queued';
    else if (ownTasks.some((task) => task.status === 'needs_review')) status = 'needs_review';
    else if (ownTasks.some((task) => task.status === 'changes_requested')) status = 'changes_requested';
    const lastEvent = events.filter((entry) => entry.agentId === agent.id || entry.actorId === agent.id).at(-1);
    let activity;
    if (current?.status === 'running' && !current.cancelRequestedAt) {
      const age = Date.parse(now) - Date.parse(current.heartbeatAt);
      // Ten missed default runner ticks are an observation gap, not proof the
      // underlying worker exited. Do not mutate task state or infer completion.
      if (!Number.isFinite(age) || age > 30000 || age < -10000) activity = { kind: 'unconfirmed' };
      else {
        const observed = team.tasks.find(task => task.id === current.id)?.worker?.activity;
        activity = { kind: ['waiting_for_team', 'using_tool', 'working'].includes(observed?.kind) ? observed.kind : 'working' };
        if (observed?.kind === 'using_tool' && /^[A-Za-z0-9_-]{1,100}$/.test(observed.tool || '')) activity.tool = observed.tool;
        if (Number.isFinite(Date.parse(observed?.since))) activity.since = observed.since;
      }
    }
    return {
      ...strings(agent, ['id', 'name', 'role', 'persona', 'job', 'restUntil', 'createdAt', 'updatedAt']),
      enabled: agent.enabled === true, status, currentTaskId: current?.id || pending?.id || null,
      lastActivityAt: current?.heartbeatAt || lastEvent?.at || null,
      ...(activity ? { activity } : {}),
    };
  });
  const execution = team.execution || {};
  return {
    schemaVersion: 1, generatedAt: now,
    team: { ...strings(team, ['id', 'name', 'objective', 'createdAt', 'updatedAt']),
      limits: Object.fromEntries(['maxAgents', 'concurrency', 'maxTasks', 'restSeconds']
        .filter((key) => Number.isSafeInteger(team.limits?.[key])).map((key) => [key, team.limits[key]])) },
    execution: {
      enabled: execution.enabled === true, model: typeof execution.model === 'string' ? execution.model : null,
      toolIds: stringList(execution.toolIds), origins: stringList(execution.origins),
      allowSideEffects: execution.allowSideEffects === true, allowWebSockets: execution.allowWebSockets === true,
      ...Object.fromEntries(['maxRounds', 'maxCalls', 'maxTimeMs'].filter((key) => Number.isSafeInteger(execution[key])).map((key) => [key, execution[key]])),
    },
    agents, tasks, events,
    messages: list(team.messages).map((message) => ({
      ...strings(message, ['id', 'from', 'kind', 'body', 'replyTo', 'createdAt']),
      to: stringList(message.to), taskIds: stringList(message.taskIds),
    })),
    notes: list(team.memories).filter((memory) => memory.scope === 'team')
      .map((memory) => strings(memory, ['id', 'agentId', 'content', 'source', 'createdAt', 'updatedAt'])),
    skills: list(team.skills).map((skill) => ({
      ...strings(skill, ['id', 'name', 'instructions', 'acceptance', 'replaces', 'status', 'author', 'createdAt', 'approvedAt']),
      revision: skill.revision,
    })),
    routines: list(team.routines).map((routine) => ({
      ...strings(routine, ['id', 'agentId', 'skillId', 'title', 'instruction', 'nextAt', 'lastTaskId', 'createdAt', 'reviewerId']),
      requiredArtifacts: stringList(routine.requiredArtifacts),
      enabled: routine.enabled === true, intervalSeconds: routine.intervalSeconds,
    })),
    artifacts: list(team.tasks).flatMap(savedArtifacts),
  };
}

// Explicit owner-management view. Private memories must never be appended to
// the shared workroom projection or another agent's context by UI convenience.
function ownerMemorySnapshot(team) {
  return { memories: list(team.memories).filter((memory) => ['private', 'team'].includes(memory.scope))
    .map((memory) => strings(memory, ['id', 'agentId', 'scope', 'content', 'source', 'createdAt', 'updatedAt'])) };
}

module.exports = { workroomSnapshot, ownerMemorySnapshot };
