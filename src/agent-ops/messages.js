'use strict';

const { isRemoteExecutionPending } = require('../workloads/long-agent-mode');

// Handoffs are conversation, not downloadable documents or lifecycle logs.
function safeLink(value = '') {
  const text = String(value || '').trim();
  if (/^\/(?!\/)[^\s\\]*$/.test(text)) return text;
  try {
    const url = new URL(text);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch (_) {
    return null;
  }
}

function extractLinks(text = '') {
  const links = new Map();
  for (const match of String(text).matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const url = safeLink(match[0].replace(/[.,;:!?)\]}]+$/, ''));
    if (url && !links.has(url)) links.set(url, { url, label: new URL(url).hostname });
  }
  return [...links.values()].slice(0, 12);
}

function buildRuntimeLabel(remoteExecution) {
  const receipt = remoteExecution?.reasoningEffortReceipt;
  const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  if (!receipt || !efforts.includes(receipt.requested)) return '';
  const model = /^[a-z0-9._:/-]{1,160}$/i.test(remoteExecution?.providerModel || '')
    ? remoteExecution.providerModel : 'CLI model not reported';
  if (receipt.status === 'applied' && receipt.appliedTo === 'cli-invocation' && efforts.includes(receipt.applied)) {
    return `Runtime: ${model} · ${receipt.applied} effort applied to CLI invocation.`;
  }
  if (receipt.status === 'forwarded') return `Runtime: ${model} · ${receipt.requested} requested; application unconfirmed.`;
  return '';
}

function buildAgentMessages(workloads = [], runs = []) {
  const byId = new Map(workloads.map((workload) => [workload.id, workload]));
  return runs.flatMap((run) => {
    const workload = byId.get(run.workloadId);
    if (!workload) return [];
    const output = run.metadata?.output || {};
    // This is an immutable observation from this run, not the workload's latest
    // cursor (which may already belong to a later stage or a different goal).
    const remoteExecution = output.remoteExecution || null;
    const remotePending = isRemoteExecutionPending(remoteExecution);
    let message = String(output.text || run.error?.message || output.artifactMessage || '').trim();
    if (remotePending) {
      message = `At this stage, remote execution was still pending; this update is not a completed goal.${message ? `\n\n${message}` : ''}`;
    }
    const runtimeLabel = buildRuntimeLabel(remoteExecution);
    if (runtimeLabel) message = [message, runtimeLabel].filter(Boolean).join('\n\n');
    if (!message) return [];
    const company = workload.metadata?.agentCompany || {};
    const attachments = (Array.isArray(output.artifacts) ? output.artifacts : []).filter((artifact) => artifact.id).map((artifact) => ({
      id: artifact.id,
      label: artifact.filename || 'Download file',
      url: `/api/artifacts/${encodeURIComponent(artifact.id)}/download`,
    }));
    return [{
      id: `handoff:${run.id}`,
      runId: run.id,
      workloadId: workload.id,
      agentId: company.roleId || null,
      from: company.roleName || workload.title || 'Agent',
      task: workload.title || null,
      timestamp: run.finishedAt || run.updatedAt || run.createdAt || null,
      status: remotePending && run.status === 'completed' ? 'running' : run.status,
      runStatus: run.status,
      ...(remoteExecution ? { remoteExecution, ...(remotePending ? { goalComplete: false } : {}) } : {}),
      message,
      links: extractLinks(message),
      attachments,
    }];
  }).sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')) || a.id.localeCompare(b.id));
}

module.exports = { buildAgentMessages, extractLinks, safeLink };
