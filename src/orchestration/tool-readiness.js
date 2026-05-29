const childProcess = require('child_process');

const READINESS_READY = 'ready';
const READINESS_DEGRADED = 'degraded';
const READINESS_UNAVAILABLE = 'unavailable';

const SSH_BACKED_TOOL_IDS = new Set([
  'ssh-execute',
  'remote-command',
  'remote-workbench',
  'k3s-deploy',
]);

let cachedSshProbe = null;

function probeSshBinary() {
  const now = Date.now();
  if (cachedSshProbe && now - cachedSshProbe.checkedAt < 30000) {
    return cachedSshProbe;
  }

  const candidates = process.platform === 'win32'
    ? ['ssh.exe', 'ssh']
    : ['/usr/bin/ssh', '/bin/ssh', 'ssh'];
  let lastError = '';

  for (const candidate of candidates) {
    const result = childProcess.spawnSync(candidate, ['-V'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 1500,
      windowsHide: true,
    });
    if (!result.error || result.error.code !== 'ENOENT') {
      cachedSshProbe = {
        ok: true,
        path: candidate,
        checkedAt: now,
      };
      return cachedSshProbe;
    }
    lastError = result.error.message;
  }

  cachedSshProbe = {
    ok: false,
    path: '',
    reason: 'SSH client is not installed in the backend container.',
    lastError,
    checkedAt: now,
  };
  return cachedSshProbe;
}

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

  const sshProbe = SSH_BACKED_TOOL_IDS.has(id) ? probeSshBinary() : null;
  if (sshProbe && !sshProbe.ok) {
    status = READINESS_UNAVAILABLE;
    reason = sshProbe.reason;
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
    runtimeProbe: sshProbe ? {
      kind: 'ssh-binary',
      ok: sshProbe.ok,
      path: sshProbe.path,
      reason: sshProbe.reason || '',
    } : null,
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

function resetRuntimeReadinessProbeCacheForTests() {
  cachedSshProbe = null;
}

module.exports = {
  READINESS_READY,
  READINESS_DEGRADED,
  READINESS_UNAVAILABLE,
  evaluateToolReadiness,
  summarizeToolReadiness,
  resetRuntimeReadinessProbeCacheForTests,
};
