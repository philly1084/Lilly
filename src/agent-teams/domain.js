'use strict';

const { randomUUID } = require('crypto');
const { isBrowserLeaseClosed } = require('../agent-computer/lease-state');

function fail(message, code = 'team_invalid', statusCode = 400) {
  throw Object.assign(new Error(message), { code, statusCode });
}

function text(value, name, max = 4000, required = true) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    fail(`${name} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`);
  }
  return value.trim();
}

function integer(value, fallback, min, max) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) fail(`Expected integer ${min}..${max}.`);
  return value;
}

function member(team, id) {
  return team.agents.find((agent) => agent.id === id) || fail('Teammate not found.', 'team_agent_not_found', 404);
}

function requiredArtifactNames(value) {
  const names = value ?? [];
  if (!Array.isArray(names) || names.length > 20
    || names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(name))
    || new Set(names).size !== names.length) fail('Required artifacts must be distinct portable filenames.');
  return [...names];
}

function operator(actor) {
  if (actor.agentId) fail('This action requires the team owner.', 'team_owner_required', 403);
}

function event(team, actor, type, data, now) {
  const entry = { id: randomUUID(), type, actorId: actor.agentId || 'owner', at: now, ...data };
  team.events.push(entry);
  // Events are a bounded projection. Tasks/messages retain their own records.
  if (team.events.length > 2000) team.events.splice(0, team.events.length - 2000);
  team.updatedAt = now;
  return entry;
}

function createTeam(ownerId, input = {}, now = new Date().toISOString()) {
  return {
    version: 1, id: randomUUID(), ownerId: text(ownerId, 'owner', 160),
    name: text(input.name, 'name', 120), objective: text(input.objective, 'objective', 12000),
    execution: { enabled: false, model: null, toolIds: [], origins: [], allowSideEffects: false, allowWebSockets: false, maxRounds: 12, maxCalls: 24, maxTimeMs: 120000 },
    limits: {
      maxAgents: integer(input.maxAgents, 6, 1, 24),
      concurrency: integer(input.concurrency, 3, 1, 8),
      maxTasks: integer(input.maxTasks, 200, 1, 1000),
      restSeconds: integer(input.restSeconds, 30, 0, 3600),
    },
    agents: [], tasks: [], messages: [], memories: [], skills: [], routines: [], receipts: [], events: [],
    createdAt: now, updatedAt: now,
  };
}

function enqueue(team, actor, input, now) {
  if (team.tasks.length >= team.limits.maxTasks) fail('Team task budget reached.', 'team_task_limit', 409);
  const assignee = member(team, input.agentId);
  const reviewTarget = input.reviewOf ? team.tasks.find((entry) => entry.id === input.reviewOf) : null;
  if (input.reviewOf && (!reviewTarget || reviewTarget.status !== 'needs_review' || reviewTarget.agentId === assignee.id || assignee.role !== 'reviewer')) fail('Review requires an independent reviewer and a result awaiting review.');
  const reviewer = input.reviewerId ? member(team, input.reviewerId) : null;
  if (reviewer && (reviewer.id === assignee.id || reviewer.role !== 'reviewer')) fail('Choose an independent reviewer.');
  const dependencies = input.dependencies || [];
  if (!Array.isArray(dependencies) || dependencies.length > 20
    || dependencies.some((id) => !team.tasks.some((task) => task.id === id))) fail('Invalid task dependencies.');
  const targets = input.writeTargets || [];
  if (!Array.isArray(targets) || targets.length > 20) fail('Invalid write targets.');
  const skill = input.skillId ? team.skills.find((entry) => entry.id === input.skillId) : null;
  if (input.skillId && (!skill || skill.status !== 'approved')) fail('Skill must exist and be approved.');
  const requiredArtifacts = requiredArtifactNames(input.requiredArtifacts);
  const task = {
    id: randomUUID(), agentId: assignee.id, title: text(input.title, 'title', 200),
    instruction: text(input.instruction, 'instruction', 12000),
    dependencies: [...new Set(dependencies)],
    writeTargets: [...new Set(targets.map((target) => normalizeTarget(target)))],
    requiredArtifacts: [...requiredArtifacts],
    skill: skill ? { id: skill.id, revision: skill.revision, instructions: skill.instructions, acceptance: skill.acceptance } : null,
    status: 'queued', requestedBy: actor.agentId || 'owner', createdAt: now,
    worker: null, result: null,
    reviewOf: reviewTarget?.id || null, reviewerId: reviewer?.id || null,
  };
  team.tasks.push(task);
  event(team, actor, 'task.queued', { taskId: task.id, agentId: task.agentId }, now);
  return task;
}

function normalizeTarget(value) {
  const target = text(value, 'write target', 500).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!target || target.split('/').some((part) => part === '..' || part === '.')) fail('Write targets must be canonical paths or resource identifiers.');
  return target;
}

function overlaps(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// Mutations run inside the store transaction. The caller supplies trusted actor
// identity; input fields cannot impersonate the owner or another teammate.
function command(team, actor, action, input = {}, now = new Date().toISOString()) {
  if (actor.agentId) member(team, actor.agentId);
  switch (action) {
    case 'configure_execution': {
      operator(actor);
      const previous = team.execution || {};
      const toolIds = input.toolIds ?? previous.toolIds ?? [];
      const origins = input.origins ?? previous.origins ?? [];
      if (!Array.isArray(toolIds) || toolIds.length > 40 || toolIds.some((id) => typeof id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(id))) fail('Invalid tool allowlist.');
      if (!Array.isArray(origins) || origins.length > 30) fail('Invalid browser origins.');
      const normalizedOrigins = origins.map((value) => {
        let url;
        try { url = new URL(value); } catch (_) { fail('Invalid browser origin.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('Use exact HTTP(S) origins without paths or credentials.');
        return url.origin;
      });
      for (const key of ['enabled', 'allowSideEffects', 'allowWebSockets']) {
        if (input[key] !== undefined && typeof input[key] !== 'boolean') fail(`${key} must be boolean.`);
      }
      team.execution = {
        enabled: input.enabled ?? previous.enabled ?? false,
        model: input.model === null ? null : text(input.model ?? previous.model ?? '', 'model', 160, false) || null,
        toolIds: [...new Set(toolIds)], origins: [...new Set(normalizedOrigins)],
        allowSideEffects: input.allowSideEffects ?? previous.allowSideEffects ?? false,
        allowWebSockets: input.allowWebSockets ?? previous.allowWebSockets ?? false,
        maxRounds: integer(input.maxRounds, previous.maxRounds || 12, 1, 40),
        maxCalls: integer(input.maxCalls, previous.maxCalls || 24, 1, 100),
        maxTimeMs: integer(input.maxTimeMs, previous.maxTimeMs || 120000, 1000, 600000),
      };
      event(team, actor, 'execution.configured', { enabled: team.execution.enabled }, now);
      return team.execution;
    }
    case 'create_agent': {
      if (actor.agentId && member(team, actor.agentId).role !== 'coordinator') {
        fail('Only the owner or coordinator can grow the team.', 'team_growth_forbidden', 403);
      }
      if (team.agents.length >= team.limits.maxAgents) fail('Team size limit reached.', 'team_agent_limit', 409);
      const source = input.copyFrom ? member(team, input.copyFrom) : null;
      const role = input.role || source?.role || 'specialist';
      if (!['coordinator', 'specialist', 'reviewer'].includes(role)) fail('Invalid teammate role.');
      if (actor.agentId && role === 'coordinator') fail('Only the owner can create a coordinator.', 'team_growth_forbidden', 403);
      const id = randomUUID();
      const agent = {
        id, name: text(input.name, 'name', 100), role,
        persona: text(input.persona ?? source?.persona ?? '', 'persona', 4000, false),
        job: text(input.job ?? source?.job, 'job', 4000),
        enabled: true, restUntil: null,
        sessionId: `lilly-team:${team.id}:${id}`, computerId: `lilly-computer:${team.id}:${id}`,
        createdAt: now,
      };
      team.agents.push(agent);
      event(team, actor, 'agent.created', { agentId: id }, now);
      return agent;
    }
    case 'update_agent': {
      operator(actor);
      const agent = member(team, input.agentId);
      // A profile edit cannot replace a session, grant coordinator authority,
      // enable execution or mutate a currently executing prompt in-place.
      if (Object.keys(input).some((key) => !['agentId', 'name', 'persona', 'job'].includes(key))) fail('Only teammate profile fields can be edited.');
      if (!['name', 'persona', 'job'].some((key) => input[key] !== undefined)) fail('Choose a teammate profile field to edit.');
      const next = {
        name: input.name === undefined ? agent.name : text(input.name, 'name', 100),
        persona: input.persona === undefined ? agent.persona : text(input.persona, 'persona', 4000, false),
        job: input.job === undefined ? agent.job : text(input.job, 'job', 4000),
      };
      Object.assign(agent, next, { updatedAt: now });
      event(team, actor, 'agent.updated', { agentId: agent.id }, now);
      return agent;
    }
    case 'control_agent': {
      operator(actor);
      const agent = member(team, input.agentId);
      if (!['stop', 'resume'].includes(input.action)) fail('Expected stop or resume.');
      agent.enabled = input.action === 'resume';
      for (const task of team.tasks.filter((entry) => entry.agentId === agent.id && entry.status === 'running')) {
        if (!agent.enabled) task.cancelRequestedAt = now;
      }
      event(team, actor, `agent.${input.action}`, { agentId: agent.id }, now);
      return agent;
    }
    case 'assign_task': return enqueue(team, actor, input, now);
    case 'send_message': {
      if (!Array.isArray(input.to)) fail('Message requires teammate recipients.');
      const recipients = [...new Set(input.to || [])];
      if (!Array.isArray(input.to) || !recipients.length || recipients.length > team.limits.maxAgents) fail('Message requires teammate recipients.');
      recipients.forEach((id) => member(team, id));
      if (actor.agentId && recipients.includes(actor.agentId)) fail('Self-waking messages are not supported.');
      if (!['request', 'reply', 'note'].includes(input.kind)) fail('Invalid message kind.');
      const parent = input.replyTo ? team.messages.find((entry) => entry.id === input.replyTo) : null;
      if (input.replyTo && (!parent || (actor.agentId && !parent.to.includes(actor.agentId) && parent.from !== actor.agentId))) {
        fail('Reply thread not found.', 'team_message_not_found', 404);
      }
      if (team.messages.length >= 2000) fail('Message history limit reached.', 'team_message_limit', 409);
      const message = {
        id: randomUUID(), from: actor.agentId || 'owner', to: recipients,
        kind: input.kind, body: text(input.body, 'message', 8000), replyTo: parent?.id || null,
        createdAt: now, taskIds: [],
      };
      // Only explicit work requests wake recipients. Reply/note cannot form an
      // unbounded ping-pong loop, and requests consume the same task budget.
      if (message.kind === 'request') {
        for (const id of recipients) message.taskIds.push(enqueue(team, actor, {
          agentId: id, title: input.title || 'Teammate request', instruction: message.body,
        }, now).id);
      }
      team.messages.push(message);
      event(team, actor, 'message.sent', { messageId: message.id, to: recipients, kind: message.kind }, now);
      return message;
    }
    case 'remember': {
      const agentId = actor.agentId || input.agentId;
      member(team, agentId);
      if (!['private', 'team'].includes(input.scope)) fail('Memory scope must be private or team.');
      if (team.memories.length >= 500) fail('Memory limit reached.', 'team_memory_limit', 409);
      const memory = {
        id: randomUUID(), agentId, scope: input.scope,
        content: text(input.content, 'memory', 4000), source: text(input.source, 'source', 1000),
        createdAt: now,
      };
      team.memories.push(memory);
      event(team, actor, 'memory.saved', { memoryId: memory.id, agentId, scope: memory.scope }, now);
      return memory;
    }
    case 'forget': {
      const memory = team.memories.find((entry) => entry.id === input.memoryId);
      if (!memory || (actor.agentId && memory.agentId !== actor.agentId)) fail('Memory not found.', 'team_memory_not_found', 404);
      team.memories = team.memories.filter((entry) => entry.id !== memory.id);
      for (const receipt of team.receipts) {
        if (receipt.result?.id === memory.id) receipt.result = { id: memory.id, forgotten: true };
      }
      event(team, actor, 'memory.forgotten', { memoryId: memory.id }, now);
      return { forgotten: true };
    }
    case 'update_memory': {
      const memory = team.memories.find((entry) => entry.id === input.memoryId);
      if (!memory || (actor.agentId && memory.agentId !== actor.agentId)) fail('Memory not found.', 'team_memory_not_found', 404);
      memory.content = text(input.content, 'memory', 4000);
      memory.source = text(input.source, 'source', 1000);
      memory.updatedAt = now;
      for (const receipt of team.receipts) {
        if (receipt.result?.id === memory.id) receipt.result = { id: memory.id, superseded: true };
      }
      event(team, actor, 'memory.updated', { memoryId: memory.id }, now);
      return memory;
    }
    case 'save_skill': {
      if (team.skills.length >= 200) fail('Skill limit reached.', 'team_skill_limit', 409);
      const previous = input.replaces ? team.skills.find((entry) => entry.id === input.replaces) : null;
      if (input.replaces && !previous) fail('Previous skill not found.');
      const skill = {
        id: randomUUID(), name: text(input.name, 'skill name', 120),
        instructions: text(input.instructions, 'skill instructions', 12000),
        acceptance: text(input.acceptance, 'acceptance checks', 4000),
        revision: (previous?.revision || 0) + 1, replaces: previous?.id || null,
        status: 'draft', author: actor.agentId || 'owner', createdAt: now,
      };
      team.skills.push(skill);
      event(team, actor, 'skill.drafted', { skillId: skill.id }, now);
      return skill;
    }
    case 'approve_skill': {
      operator(actor);
      const skill = team.skills.find((entry) => entry.id === input.skillId) || fail('Skill not found.');
      skill.status = 'approved';
      skill.approvedAt = now;
      event(team, actor, 'skill.approved', { skillId: skill.id }, now);
      return skill;
    }
    case 'create_routine': {
      operator(actor);
      member(team, input.agentId);
      if (team.routines.length >= 50) fail('Routine limit reached.', 'team_routine_limit', 409);
      const skill = team.skills.find((entry) => entry.id === input.skillId);
      if (!skill || skill.status !== 'approved') fail('Routine requires an approved skill.');
      const intervalSeconds = integer(input.intervalSeconds, 86400, 60, 2678400);
      const reviewer = input.reviewerId ? member(team, input.reviewerId) : null;
      if (reviewer && (reviewer.id === input.agentId || reviewer.role !== 'reviewer')) fail('Choose an independent reviewer.');
      const routine = {
        id: randomUUID(), agentId: input.agentId, skillId: skill.id,
        title: text(input.title, 'routine title', 200),
        instruction: text(input.instruction, 'routine instruction', 12000),
        requiredArtifacts: requiredArtifactNames(input.requiredArtifacts), reviewerId: reviewer?.id || null,
        intervalSeconds, enabled: false, nextAt: null, lastTaskId: null, createdAt: now,
      };
      team.routines.push(routine);
      event(team, actor, 'routine.created', { routineId: routine.id }, now);
      return routine;
    }
    case 'control_routine': {
      operator(actor);
      const routine = team.routines.find((entry) => entry.id === input.routineId) || fail('Routine not found.');
      if (typeof input.enabled !== 'boolean') fail('Routine enabled must be boolean.');
      routine.enabled = input.enabled;
      routine.nextAt = input.enabled ? new Date(Date.parse(now) + routine.intervalSeconds * 1000).toISOString() : null;
      event(team, actor, input.enabled ? 'routine.enabled' : 'routine.paused', { routineId: routine.id }, now);
      return routine;
    }
    case 'review_task': {
      const task = team.tasks.find((entry) => entry.id === input.taskId) || fail('Task not found.');
      if (actor.agentId && (member(team, actor.agentId).role !== 'reviewer' || actor.reviewOf !== task.id || actor.agentId === task.agentId)) {
        fail('An assigned independent reviewer is required.', 'team_review_forbidden', 403);
      }
      if (task.status !== 'needs_review') fail('Task is not awaiting review.');
      if (typeof input.approved !== 'boolean') fail('Review approval must be boolean.');
      if (input.approved && !task.result?.artifacts?.length) fail('Verified artifact read-back is required before completion.', 'team_evidence_required', 409);
      if (input.approved && task.result.artifacts.some((artifact) => actor.readArtifactHashes?.[artifact.id] !== artifact.sha256)) {
        fail('Read the exact recorded bytes of every assigned artifact before approving.', 'team_evidence_required', 409);
      }
      task.review = { approved: input.approved, note: text(input.note, 'review note', 4000), at: now };
      task.status = input.approved ? 'completed' : 'changes_requested';
      event(team, actor, 'task.reviewed', { taskId: task.id, status: task.status }, now);
      return task;
    }
    default: return fail('Unsupported team command.');
  }
}

function tickRoutines(team, now = new Date().toISOString()) {
  const created = [];
  for (const routine of team.routines || []) {
    if (!routine.enabled || !routine.nextAt || routine.nextAt > now) continue;
    const agent = member(team, routine.agentId);
    if (!agent.enabled || (agent.restUntil && agent.restUntil > now)) continue;
    const previous = team.tasks.find((task) => task.id === routine.lastTaskId);
    if (previous && !['completed', 'failed', 'cancelled'].includes(previous.status)) continue;
    if (team.tasks.length >= team.limits.maxTasks) {
      routine.enabled = false;
      event(team, {}, 'routine.budget_exhausted', { routineId: routine.id }, now);
      continue;
    }
    const task = enqueue(team, {}, routine, now);
    task.routineId = routine.id;
    task.occurrenceAt = routine.nextAt;
    routine.lastTaskId = task.id;
    // Skip missed occurrences instead of creating a catch-up storm after outage.
    routine.nextAt = new Date(Date.parse(now) + routine.intervalSeconds * 1000).toISOString();
    created.push(task);
  }
  return created;
}

function claimTasks(team, workerId, now = new Date().toISOString(), limit = 8) {
  text(workerId, 'worker', 160);
  integer(limit, 8, 0, 64);
  const active = team.tasks.filter((task) => ['running', 'reconciling'].includes(task.status));
  const claimed = [];
  for (const task of team.tasks) {
    if (claimed.length >= limit) break;
    if (active.length >= team.limits.concurrency) break;
    const agent = member(team, task.agentId);
    if (task.status !== 'queued' || !agent.enabled || (agent.restUntil && agent.restUntil > now)) continue;
    if (active.some((other) => other.agentId === task.agentId)) continue;
    if (team.tasks.some(other => other.agentId === task.agentId && other.computerLease
      && !isBrowserLeaseClosed(other.computerLease))) continue;
    if (task.dependencies.some((id) => team.tasks.find((entry) => entry.id === id)?.status !== 'completed')) continue;
    if (active.some((other) => other.writeTargets.some((a) => task.writeTargets.some((b) => overlaps(a, b))))) continue;
    task.status = 'running';
    task.worker = { id: workerId, claimId: randomUUID(), startedAt: now, heartbeatAt: now };
    active.push(task);
    claimed.push(task);
    event(team, {}, 'task.claimed', { taskId: task.id, agentId: task.agentId }, now);
  }
  return claimed;
}

function agentContext(team, agentId) {
  const agent = member(team, agentId);
  const context = {
    team: { id: team.id, name: team.name, objective: team.objective, limits: team.limits },
    agent,
    teammates: team.agents.map(({ id, name, role, job, enabled }) => ({ id, name, role, job: job.slice(0, 240), enabled })),
    memories: team.memories.filter((entry) => entry.scope === 'team' || entry.agentId === agentId)
      .slice(-16).map((entry) => ({ ...entry, content: entry.content.slice(0, 1200) })),
    messages: team.messages.filter((entry) => entry.to.includes(agentId) || entry.from === agentId)
      .slice(-20).map((entry) => ({ ...entry, body: entry.body.slice(0, 2000) })),
    // Progressive disclosure: carry the catalog, not every skill's full body.
    skills: team.skills.filter((entry) => entry.status === 'approved').slice(-20)
      .map(({ id, name, revision }) => ({ id, name, revision })),
    tasks: team.tasks.filter((task) => task.agentId === agentId).slice(-5)
      .map(({ id, title, status, dependencies, result }) => ({ id, title, status, dependencies,
        resultSummary: result?.summary?.slice(0, 1000) || null })),
    // Shared outputs are discoverable on the next wake without copying another
    // teammate's inbox, private memories or raw conversation into this context.
    artifacts: team.tasks.flatMap((task) => (task.result?.artifacts || []).map((artifact) => ({
      id: artifact.id, sha256: artifact.sha256, taskId: task.id, agentId: task.agentId,
    }))).slice(-20),
    contextTruncated: false,
  };
  while (JSON.stringify(context).length > 36000) {
    const bucket = [context.messages, context.memories, context.skills, context.tasks, context.artifacts, context.teammates]
      .find((entries) => entries.length);
    if (!bucket) break;
    bucket.shift();
    context.contextTruncated = true;
  }
  return context;
}

module.exports = { createTeam, command, claimTasks, tickRoutines, agentContext, fail };
