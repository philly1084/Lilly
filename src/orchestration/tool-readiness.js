const READINESS_READY = 'ready';
const READINESS_DEGRADED = 'degraded';
const READINESS_UNAVAILABLE = 'unavailable';

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getExecutableShape(tool = null) {
  if (!tool) {
    return 'missing';
  }
  if (typeof tool.execute === 'function') {
    return 'execute';
  }
  if (typeof tool.backend?.handler === 'function') {
    return 'backend.handler';
  }
  return 'none';
}

function inferRequiredConfig(toolId = '', tool = {}) {
  const id = normalizeText(toolId).toLowerCase();
  const category = normalizeText(tool?.category).toLowerCase();
  const required = [];

  if (category === 'ssh' || /\b(remote|ssh|k3s|docker)\b/.test(id)) {
    required.push('remote runner or SSH configuration');
  }
  if (id === 'image-search-unsplash') {
    required.push('Unsplash access key');
  }
  if (id === 'speech-generate') {
    required.push('TTS provider configuration');
  }
  if (id === 'image-generate') {
    required.push('image-capable provider/model');
  }

  return required;
}

function defaultRecoveryHints({ toolId = '', status = READINESS_READY, executableShape = 'none' } = {}) {
  const hints = [];
  if (status === READINESS_UNAVAILABLE) {
    hints.push('Choose another compatible tool or answer without tools if safe.');
  }
  if (executableShape === 'none') {
    hints.push('Tool is registered but has no executable handler; route through ToolManager or repair the registration.');
  }
  if (/^(remote-command|remote-cli-agent|k3s-deploy|remote-workbench|ssh-execute)$/.test(toolId)) {
    hints.push('Run a baseline or configuration check before retrying remote operations.');
  }
  if (toolId === 'web-fetch' || toolId === 'web-scrape' || toolId === 'web-search') {
    hints.push('Retry with a smaller request, alternate source, or lower-cost discovery path.');
  }
  return hints;
}

function evaluateToolReadiness(toolId = '', tool = null, {
  skill = null,
  previous = null,
  probe = null,
} = {}) {
  const id = normalizeText(toolId || tool?.id);
  const now = new Date().toISOString();
  const executableShape = getExecutableShape(tool);
  const enabled = skill?.enabled !== false;
  let status = READINESS_READY;
  let reason = 'Tool is registered and executable.';

  if (!tool) {
    status = READINESS_UNAVAILABLE;
    reason = 'Tool is not registered.';
  } else if (!enabled) {
    status = READINESS_UNAVAILABLE;
    reason = 'Tool skill is disabled.';
  } else if (executableShape === 'none') {
    status = READINESS_DEGRADED;
    reason = 'Tool is registered but has no executable handler.';
  }

  if (probe?.status && [READINESS_READY, READINESS_DEGRADED, READINESS_UNAVAILABLE].includes(probe.status)) {
    status = probe.status;
    reason = probe.reason || reason;
  }

  const requiredConfig = inferRequiredConfig(id, tool || {});
  return {
    toolId: id,
    status,
    reason,
    executableShape,
    requiredConfig,
    recoveryHints: Array.from(new Set([
      ...(Array.isArray(previous?.recoveryHints) ? previous.recoveryHints : []),
      ...defaultRecoveryHints({ toolId: id, status, executableShape }),
    ])),
    lastProbe: probe?.lastProbe || previous?.lastProbe || null,
    lastCheckedAt: now,
  };
}

function summarizeToolReadiness(readiness = {}) {
  return {
    toolId: readiness.toolId || null,
    status: readiness.status || READINESS_UNAVAILABLE,
    reason: readiness.reason || '',
    executableShape: readiness.executableShape || 'unknown',
    requiredConfig: Array.isArray(readiness.requiredConfig) ? readiness.requiredConfig : [],
    recoveryHints: Array.isArray(readiness.recoveryHints) ? readiness.recoveryHints.slice(0, 4) : [],
    lastCheckedAt: readiness.lastCheckedAt || null,
  };
}

module.exports = {
  READINESS_READY,
  READINESS_DEGRADED,
  READINESS_UNAVAILABLE,
  evaluateToolReadiness,
  summarizeToolReadiness,
};
