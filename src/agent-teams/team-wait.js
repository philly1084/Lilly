'use strict';

const { createHash } = require('crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');
const { fail } = require('./domain');

const id = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
const attention = new Set(['needs_review', 'completed', 'failed', 'cancelled', 'changes_requested', 'reconciling']);
const whiteboardRevision = team => createHash('sha256').update(JSON.stringify(team.memories
  .filter(memory => memory.scope === 'team').map(memory => [memory.id, memory.updatedAt, memory.content]))).digest('hex');

// A model-free, bounded observation wait. It does not queue work, release the
// worker's capacity/claim, imply task success or authorize another agent.
async function waitForTeamUpdate({ service, identity, options = {}, signal,
  now = () => performance.now(), sleep = (ms, abortSignal) => pause(ms, undefined, { signal: abortSignal }) }) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('Invalid team wait.', 'team_wait_invalid');
  const { afterMessageId, taskIds = [], watchWhiteboard = false, timeoutMs = 15000 } = options;
  if (Object.keys(options).some(key => !['afterMessageId', 'taskIds', 'watchWhiteboard', 'timeoutMs'].includes(key))
    || (afterMessageId !== undefined && !id(afterMessageId)) || !Array.isArray(taskIds) || taskIds.length > 8
    || taskIds.some(value => !id(value)) || new Set(taskIds).size !== taskIds.length
    || typeof watchWhiteboard !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    fail('Invalid team wait. Use at most eight tasks and a deadline up to 30 seconds.', 'team_wait_invalid');
  }
  const guard = () => { if (signal?.aborted) fail('Worker cancelled.', 'team_worker_cancelled', 409); };
  const read = async () => {
    guard();
    const team = await service.get(identity.teamId, identity.ownerId);
    guard();
    service.engineTask(team, identity);
    return team;
  };
  const deadline = now() + timeoutMs;
  let current = await read();
  const visible = team => team.messages.filter(message => message.from === identity.agentId || message.to.includes(identity.agentId));
  const initialMessages = visible(current);
  if (afterMessageId !== undefined && !initialMessages.some(message => message.id === afterMessageId)) {
    fail('Inbox cursor not found for this teammate.', 'team_wait_cursor_invalid', 404);
  }
  const cursor = afterMessageId ?? initialMessages.at(-1)?.id ?? null;
  const initialTasks = taskIds.map(taskId => {
    const task = current.tasks.find(entry => entry.id === taskId);
    if (!task) fail('Watched task not found in this team.', 'team_task_not_found', 404);
    if (task.id === identity.taskId) fail('A worker cannot wait for its own task to finish.', 'team_wait_invalid');
    return { id: task.id, status: task.status };
  });
  const revision = watchWhiteboard ? whiteboardRevision(current) : null;
  while (true) {
    guard();
    const messages = visible(current);
    const index = cursor === null ? -1 : messages.findIndex(message => message.id === cursor);
    if (cursor !== null && index === -1) fail('Inbox history changed; reread team context.', 'team_wait_cursor_invalid', 409);
    const incoming = messages.slice(index + 1).filter(message => message.to.includes(identity.agentId)).slice(0, 20);
    const tasks = initialTasks.map(initial => {
      const task = current.tasks.find(entry => entry.id === initial.id);
      if (!task) fail('Watched task not found in this team.', 'team_task_not_found', 404);
      return { id: task.id, agentId: task.agentId, status: task.status };
    });
    const whiteboardChanged = watchWhiteboard && whiteboardRevision(current) !== revision;
    const occupied = current.tasks.filter(task => ['running', 'reconciling'].includes(task.status)).length;
    const capacityBlocked = tasks.some(task => task.status === 'queued'
      && (occupied >= current.limits.concurrency || task.agentId === identity.agentId));
    const reason = incoming.length ? 'message'
      : tasks.some((task, i) => task.status !== initialTasks[i].status || attention.has(task.status)) ? 'task_changed'
        : whiteboardChanged ? 'whiteboard_changed' : capacityBlocked ? 'capacity_blocked'
          : now() >= deadline ? 'timeout' : null;
    if (reason) {
      const result = {
        reason, cursor: incoming.at(-1)?.id || messages.at(-1)?.id || null, tasks, whiteboardChanged,
        messages: incoming.map(message => ({ id: message.id, from: message.from, kind: message.kind,
          body: message.body.slice(0, 2000), replyTo: message.replyTo, createdAt: message.createdAt, taskIds: [...message.taskIds] })),
        ...(capacityBlocked ? { guidance: 'Queued work cannot start while its required worker slot is occupied. Finish this turn or do independent work; waiting does not release your slot.' } : {}),
      };
      // Both engines consume this result. Stay below the native Lilly loop's
      // 20k JSON limit and advance only over messages actually returned.
      while (JSON.stringify(result).length > 18000 && result.messages.length > 1) {
        result.messages.pop(); result.cursor = result.messages.at(-1).id;
      }
      if (JSON.stringify(result).length > 18000) fail('Team update exceeds the result limit.', 'team_wait_output_limit');
      return result;
    }
    try { await sleep(Math.min(1000, Math.max(1, deadline - now())), signal); }
    catch (error) { guard(); throw error; }
    current = await read();
  }
}

module.exports = { waitForTeamUpdate };
