'use strict';

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

function buildAgentMessages(workloads = [], runs = []) {
  const byId = new Map(workloads.map((workload) => [workload.id, workload]));
  return runs.flatMap((run) => {
    const workload = byId.get(run.workloadId);
    if (!workload) return [];
    const output = run.metadata?.output || {};
    const message = String(output.text || run.error?.message || output.artifactMessage || '').trim();
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
      status: run.status,
      message,
      links: extractLinks(message),
      attachments,
    }];
  }).sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')) || a.id.localeCompare(b.id));
}

module.exports = { buildAgentMessages, extractLinks, safeLink };
