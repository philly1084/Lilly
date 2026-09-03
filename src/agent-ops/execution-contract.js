'use strict';

const { normalizeRemoteWorkspace } = require('../remote-cli/workspace-contract');

const VERSION = 'AgentCompanyExecution/v1';
const LANES = {
  'tool-doc-read': 'Read the current parameter schema and examples before using an unfamiliar tool.',
  'remote-cli-agent': 'Stateful coding/build/test work. Pass task, optional targetId, model and reasoningEffort. Never pass raw command/shell fields. Omit cwd unless a workspace on THIS target has been verified.',
  'remote-command': 'One bounded, non-interactive terminal inspection or verification command; read its SSH schema first.',
  'remote-workbench': 'Structured repository, file, build, test and log operations.',
  'k3s-deploy': 'Standard deployment and rollout actions, only within approved scope.',
  'managed-app': 'Inventory existing projects first; reuse matching projects. Catalog/control-plane actions are distinct from CLI implementation.',
  'web-search': 'Research current facts and discover sources; this is not a coding terminal.',
  'web-fetch': 'Read selected source pages and verify claims.',
  'file-read': 'Read backend-visible files; these are not automatically the remote CLI filesystem.',
  'file-write': 'Write backend-visible files; verify read-back and do not assume remote workspace synchronization.',
};

function buildCompanyExecutionGuide({ toolManager, targets = [], targetDiscoveryError = '', model, reasoningEffort, metadata = {}, policy = {} } = {}) {
  const tools = Object.entries(LANES).filter(([id]) => toolManager?.getTool?.(id));
  return [
    `[${VERSION}: shared framework protocol]`,
    `Workload: ${metadata.workloadId || 'unknown'}; run: ${metadata.runId || 'unknown'}; goal: ${metadata.companyGoalHash || 'workload-scoped'}.`,
    `Model: ${model || 'configured default'}; reasoning effort: ${reasoningEffort || 'configured default'}. Preserve these when delegating.`,
    `Side effects approved by workload policy: ${policy.allowSideEffects === true}. Tool presence is NOT permission; runtime policy remains authoritative.`,
    'Navigation map (registered tools only; runtime policy/readiness can further restrict them):',
    ...tools.map(([id, description]) => `- ${id}: ${description}`),
    'Current gateway targets (defaults are host-specific, not interchangeable):',
    ...targets.map((target) => `- ${target.targetId}: default cwd ${target.defaultCwd || '(gateway-selected)'}; ${target.description || ''}`),
    targets.length ? '' : `Target discovery unavailable${targetDiscoveryError ? `: ${targetDiscoveryError}` : ''}. Do not invent a target or path; use the configured default or surface the discovery blocker.`,
    'Execution rhythm: inspect inventory and current goal evidence -> choose one tool lane -> act -> verify durable output -> hand off.',
    'The gateway owns target-specific default workspaces and allowed roots. Never copy a cwd, jobId or sessionId between targets, projects or goals. A log line, grep match or model claim is not workspace metadata.',
    'Only the inner CLI runner uses remote_code_run/remote_code_status. The company agent calls remote-cli-agent; preserve its returned jobId/sessionId and poll the same running job instead of launching a duplicate.',
    'Coordinate through the existing shared whiteboard and stage scratch record. Label each entry with goal/workload, owner, target, cwd, jobId/sessionId, changed files, verification, blocker and next owner/action. Read only entries relevant to this goal; do not act on stale goals or example domains.',
    'A heartbeat schedules/checks work; it is not proof of progress. A scheduler step returning does not mean its remote job or overall goal finished. Report running jobs as still running and blocked jobs as blocked; a final reply alone does not prove files were built or deployed.',
    'On failure, read the actual tool error and refresh the relevant target/tool contract. Make one materially different recovery attempt; stop and surface the blocker if the same failure repeats. Never broaden allowed roots, bypass permissions or substitute an HTML brief for unfinished implementation.',
    'Final handoff: speak directly to the user, link the actual website/preview/download with Markdown, state what changed and which checks passed, and disclose unfinished work. Do not hide links in HTML. Claim completion only with tool evidence and read-back.',
  ].join('\n');
}

function getCompanyExecutionFailure(result = {}) {
  const events = result.toolEvents || result.response?.metadata?.toolEvents || [];
  // A later successful call of the same tool can be a legitimate recovery.
  const latest = new Map();
  for (const event of events) {
    const id = event.toolCall?.function?.name || event.toolId || event.tool;
    if (id && event.result) latest.set(id, event.result);
  }
  for (const [id, outcome] of latest) {
    const data = outcome.data || outcome;
    if (outcome.success === false || ['failed', 'blocked'].includes(data.completionStatus)) {
      return `${id} ${data.completionStatus || 'failed'}: ${outcome.error?.message || outcome.error || data.blocker || data.error || 'Tool did not complete successfully.'}`;
    }
  }
  const text = String(result.outputText || '').trim();
  return /^(?:remote-cli-agent failed\s*:|Remote CLI task is blocked\.)/i.test(text) ? text : '';
}

function getCompanyRemoteExecution(result = {}, workload = {}) {
  const events = result.toolEvents || result.response?.metadata?.toolEvents || [];
  const event = [...events].reverse().find((entry) =>
    (entry.toolCall?.function?.name || entry.toolId || entry.tool) === 'remote-cli-agent' && entry.result);
  const data = event?.result?.data || event?.result;
  if (!data?.targetId || !(data.remoteCodeJobId || data.sessionId)) return null;
  const state = {};
  for (const key of ['targetId', 'sessionId', 'mcpSessionId', 'remoteCodeSessionId', 'remoteCodeJobId', 'completionStatus', 'publicUrl', 'publicHost']) {
    if (typeof data[key] === 'string') state[key] = data[key];
  }
  state.cwd = normalizeRemoteWorkspace(data.cwd);
  return { workloadId: workload.id, companyGoalHash: workload.metadata?.agentCompany?.companyGoalHash || null, state };
}

function createCompanySessionView(session, context = {}) {
  if (!session) return session;
  // Company roles share a transcript for communication, not an implicit CLI
  // cursor. Continuation evidence comes from this workload's stage context.
  const metadata = { ...(session.metadata || {}) };
  for (const key of Object.keys(metadata)) {
    if (/controlState|remote|ssh|activeProject|projectMemory|promptState|taskFrame|lastToolIntent|agentJournal/i.test(key)) {
      delete metadata[key];
    }
  }
  const cursor = context.companyRemoteExecution;
  const state = cursor?.workloadId === context.workloadId
    && cursor?.companyGoalHash === (context.companyGoalHash || null) ? cursor?.state : null;
  return { ...session, metadata, controlState: state ? { remoteCliAgent: state } : {}, previousResponseId: null };
}

module.exports = { VERSION, buildCompanyExecutionGuide, getCompanyExecutionFailure, getCompanyRemoteExecution, createCompanySessionView };
