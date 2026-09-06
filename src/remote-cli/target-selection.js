'use strict';

const INVALID_REMOTE_CLI_TARGET_ID_PATTERN = /^(?:undefined|null|none|unknown|not[_\s-]?available|n\/a|na)$/i;

function normalizeRemoteCliTargetIdCandidate(value = '') {
  const normalized = String(value ?? '').trim();
  return normalized && !INVALID_REMOTE_CLI_TARGET_ID_PATTERN.test(normalized)
    ? normalized
    : '';
}

function normalizeRemoteCliHostCandidate(value = '') {
  let normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) ? normalized : `https://${normalized}`);
    normalized = parsed.hostname;
  } catch (_error) {
    normalized = normalized
      .replace(/^[^@\s]+@/, '')
      .replace(/:\d{2,5}$/, '')
      .replace(/[/?#].*$/, '');
  }

  return normalized.replace(/\.$/, '');
}

function extractRemoteCliHostCandidates(text = '') {
  const matches = String(text || '').match(
    /\b(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/ig,
  ) || [];
  return Array.from(new Set(matches.map(normalizeRemoteCliHostCandidate).filter(Boolean)));
}

function resolveConfiguredRemoteCliTargetForHost(host = '', targetHostMap = {}) {
  const normalizedHost = normalizeRemoteCliHostCandidate(host);
  if (!normalizedHost || !targetHostMap || typeof targetHostMap !== 'object') {
    return '';
  }

  const candidates = Object.entries(targetHostMap)
    .map(([configuredHost, targetId]) => ({
      host: normalizeRemoteCliHostCandidate(configuredHost),
      targetId: normalizeRemoteCliTargetIdCandidate(targetId),
    }))
    .filter((entry) => entry.host && entry.targetId)
    .sort((left, right) => right.host.length - left.host.length);

  const exact = candidates.find((entry) => entry.host === normalizedHost);
  if (exact) {
    return exact.targetId;
  }

  const suffix = candidates.find((entry) => normalizedHost.endsWith(`.${entry.host}`));
  return suffix?.targetId || '';
}

function resolveConfiguredRemoteCliTargetFromText(text = '', targetHostMap = {}) {
  for (const host of extractRemoteCliHostCandidates(text)) {
    const targetId = resolveConfiguredRemoteCliTargetForHost(host, targetHostMap);
    if (targetId) {
      return targetId;
    }
  }
  return '';
}

function resolveRemoteCliProjectTarget(input = {}, targetHostMap = {}) {
  const explicit = normalizeRemoteCliTargetIdCandidate(input.targetId || input.target_id);
  if (explicit) return explicit;
  // Session and job identities belong to their original host; never reroute a poll.
  if (input.jobId || input.job_id || input.remoteCodeJobId || input.remote_code_job_id
    || input.sessionId || input.session_id || input.remoteSessionId || input.remote_session_id
    || input.threadId || input.thread_id) return '';
  return resolveConfiguredRemoteCliTargetFromText([
    input.publicHost, input.publicUrl, input.task || input.prompt || input.message,
  ].filter(Boolean).join('\n'), targetHostMap);
}

module.exports = {
  extractRemoteCliHostCandidates,
  normalizeRemoteCliHostCandidate,
  normalizeRemoteCliTargetIdCandidate,
  resolveConfiguredRemoteCliTargetForHost,
  resolveConfiguredRemoteCliTargetFromText,
  resolveRemoteCliProjectTarget,
};
