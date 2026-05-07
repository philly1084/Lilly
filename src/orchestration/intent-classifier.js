const { hasWorkloadIntent } = require('../workloads/natural-language');

const AGENCY_MODES = Object.freeze({
  RESPOND: 'respond',
  SINGLE_STEP: 'single-step',
  MULTI_STEP: 'multi-step',
  SCHEDULE: 'schedule',
  SCHEDULE_MULTIPLE: 'schedule-multiple',
  DELEGATE: 'delegate',
});

function normalizeText(value = '') {
  return String(value || '').trim();
}

function hasExplicitDelegationIntent(text = '') {
  return /\b(sub[-\s]?agents?|delegate(?:d)?|parallel agents?|spawn (?:workers?|agents?)|multiple agents?|worker agents?)\b/i.test(text);
}

function hasSchedulingIntent(text = '') {
  return hasWorkloadIntent(text);
}

function hasMultipleSchedulingIntent(text = '') {
  const normalized = normalizeText(text).toLowerCase();
  if (!hasSchedulingIntent(normalized)) {
    return false;
  }

  return /\b(multiple|several|each of these|for each|separate|two|three|2|3)\b[\s\S]{0,80}\b(?:jobs?|automations?|cron|schedules?|reminders?|workloads?)\b/i.test(normalized)
    || /\b(?:jobs?|automations?|cron|schedules?|reminders?|workloads?)\b[\s\S]{0,80}\b(multiple|several|separate|two|three|2|3)\b/i.test(normalized)
    || (normalized.match(/\b(?:every|daily|weekly|monthly|tomorrow|next week|cron)\b/g) || []).length > 1;
}

function hasRemoteOrToolIntent(text = '') {
  return /\b(remote|server|ssh|k3s|k8s|kubernetes|kubectl|deploy|rollout|logs?|restart|git|github|file|read|write|search|research|look up|browse|latest|current|today|url|http|https)\b/i.test(text);
}

function hasLongRunningIntent(text = '') {
  return /\b(continue|keep going|work until|end to end|multi[-\s]?step|long[-\s]?running|full implementation|investigate|debug|triage|clean it up|rewrite|refactor|implement|build|deploy)\b/i.test(text);
}

function inferTaskIntent({
  objective = '',
  instructions = '',
  executionProfile = 'default',
  classification = null,
} = {}) {
  const text = normalizeText(`${objective}\n${instructions}`);
  const lower = text.toLowerCase();
  const scheduling = hasSchedulingIntent(lower);
  const multipleSchedules = hasMultipleSchedulingIntent(lower);
  const delegation = hasExplicitDelegationIntent(lower);
  const remoteOrTool = hasRemoteOrToolIntent(lower);
  const longRunning = hasLongRunningIntent(lower)
    || executionProfile === 'remote-build'
    || classification?.requiresTools === true;

  let mode = AGENCY_MODES.RESPOND;
  if (delegation) {
    mode = AGENCY_MODES.DELEGATE;
  } else if (multipleSchedules) {
    mode = AGENCY_MODES.SCHEDULE_MULTIPLE;
  } else if (scheduling) {
    mode = AGENCY_MODES.SCHEDULE;
  } else if (longRunning) {
    mode = AGENCY_MODES.MULTI_STEP;
  } else if (remoteOrTool) {
    mode = AGENCY_MODES.SINGLE_STEP;
  }

  return {
    type: 'TaskIntent',
    mode,
    requiresTools: mode !== AGENCY_MODES.RESPOND || remoteOrTool || scheduling || delegation,
    explicitDelegation: delegation,
    schedulingIntent: scheduling,
    multipleSchedulingIntent: multipleSchedules,
    remoteOrToolIntent: remoteOrTool,
    longRunningIntent: longRunning,
    shouldAskBeforeActing: false,
    source: 'orchestration-rewrite',
  };
}

function buildAgencyProfile({
  intent = null,
  objective = '',
  executionProfile = 'default',
} = {}) {
  const resolvedIntent = intent || inferTaskIntent({ objective, executionProfile });
  const mode = resolvedIntent.mode || AGENCY_MODES.RESPOND;
  const multiStep = mode === AGENCY_MODES.MULTI_STEP || executionProfile === 'remote-build';

  return {
    type: 'AgencyProfile',
    mode,
    canUseTools: resolvedIntent.requiresTools,
    canSchedule: mode === AGENCY_MODES.SCHEDULE || mode === AGENCY_MODES.SCHEDULE_MULTIPLE,
    canDelegate: mode === AGENCY_MODES.DELEGATE,
    shouldSplitWorkloads: mode === AGENCY_MODES.SCHEDULE_MULTIPLE,
    shouldContinueUntilDone: multiStep,
    maxRoundsHint: multiStep ? 4 : 1,
    maxToolCallsHint: multiStep ? 12 : 4,
    source: 'orchestration-rewrite',
  };
}

module.exports = {
  AGENCY_MODES,
  buildAgencyProfile,
  hasExplicitDelegationIntent,
  hasMultipleSchedulingIntent,
  hasSchedulingIntent,
  inferTaskIntent,
};
