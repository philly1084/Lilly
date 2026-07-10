'use strict';

const AGENT_RUN_VERSION = 'AgentRun/v1';
const AGENT_RUN_SURFACE = 'agent-run';

const AGENT_RUN_STATES = Object.freeze([
  'created',
  'planning',
  'executing',
  'verifying',
  'waiting_for_approval',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

const TERMINAL_AGENT_RUN_STATES = new Set([
  'completed',
  'failed',
  'cancelled',
]);

const LEGAL_AGENT_RUN_TRANSITIONS = Object.freeze({
  created: new Set(['planning', 'waiting_for_approval', 'blocked', 'failed', 'cancelled']),
  planning: new Set(['executing', 'waiting_for_approval', 'blocked', 'failed', 'cancelled']),
  executing: new Set(['verifying', 'waiting_for_approval', 'blocked', 'failed', 'cancelled']),
  verifying: new Set(['completed', 'waiting_for_approval', 'blocked', 'failed', 'cancelled']),
  waiting_for_approval: new Set(['planning', 'executing', 'verifying', 'blocked', 'failed', 'cancelled']),
  blocked: new Set(['executing', 'waiting_for_approval', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(['executing', 'cancelled']),
  cancelled: new Set(),
});

function normalizeAgentRunState(value = '', fallback = 'created') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return AGENT_RUN_STATES.includes(normalized) ? normalized : fallback;
}

function canTransitionAgentRun(fromState = '', toState = '') {
  const from = normalizeAgentRunState(fromState, '');
  const to = normalizeAgentRunState(toState, '');
  return Boolean(from && to && LEGAL_AGENT_RUN_TRANSITIONS[from]?.has(to));
}

module.exports = {
  AGENT_RUN_STATES,
  AGENT_RUN_SURFACE,
  AGENT_RUN_VERSION,
  LEGAL_AGENT_RUN_TRANSITIONS,
  TERMINAL_AGENT_RUN_STATES,
  canTransitionAgentRun,
  normalizeAgentRunState,
};
