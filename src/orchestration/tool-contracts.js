const {
  TOOL_INVOCATION_VERSION,
  inferToolInvocationRisk,
} = require('../tool-invocation');

const TOOL_CONTRACT_OVERRIDES = Object.freeze({
  'agent-workload': {
    capabilities: ['schedule', 'background', 'workload'],
    foregroundEligible: false,
    backgroundEligible: true,
    supportsSchedule: true,
    destructiveRisk: 'low',
    requiresConfirmation: false,
    idempotency: 'runtime',
    risk: 'external',
  },
  'agent-delegate': {
    capabilities: ['delegate', 'background', 'parallel'],
    foregroundEligible: false,
    backgroundEligible: true,
    supportsSchedule: false,
    destructiveRisk: 'medium',
    requiresConfirmation: false,
    idempotency: 'caller',
    risk: 'external',
  },
  'remote-command': {
    capabilities: ['remote', 'shell', 'inspect', 'operate'],
    foregroundEligible: true,
    backgroundEligible: true,
    supportsSchedule: false,
    destructiveRisk: 'medium',
    requiresConfirmation: false,
    idempotency: 'caller',
    risk: 'external',
  },
  'remote-cli-agent': {
    capabilities: ['remote', 'agent', 'code'],
    foregroundEligible: true,
    backgroundEligible: true,
    supportsSchedule: false,
    destructiveRisk: 'medium',
    requiresConfirmation: false,
    idempotency: 'caller',
    risk: 'external',
  },
  'git-safe': {
    capabilities: ['git', 'repository'],
    foregroundEligible: true,
    backgroundEligible: true,
    supportsSchedule: false,
    destructiveRisk: 'medium',
    requiresConfirmation: false,
    idempotency: 'caller',
    risk: 'write',
  },
  'k3s-deploy': {
    capabilities: ['deploy', 'kubernetes', 'remote'],
    foregroundEligible: true,
    backgroundEligible: true,
    supportsSchedule: false,
    destructiveRisk: 'medium',
    requiresConfirmation: false,
    idempotency: 'caller',
    risk: 'external',
  },
  'design-resource-search': {
    capabilities: ['design', 'research', 'resource-index'],
    foregroundEligible: true,
    backgroundEligible: true,
    supportsSchedule: false,
    destructiveRisk: 'low',
    requiresConfirmation: false,
    idempotency: 'readonly',
    risk: 'read',
  },
  'code-sandbox': {
    capabilities: ['sandbox', 'build', 'preview', 'code'],
    foregroundEligible: true,
    backgroundEligible: true,
    supportsSchedule: false,
    destructiveRisk: 'medium',
    requiresConfirmation: true,
    idempotency: 'workspace',
    risk: 'write',
  },
});

function normalizeSideEffects(tool = {}) {
  if (Array.isArray(tool?.sideEffects)) {
    return tool.sideEffects;
  }
  if (Array.isArray(tool?.backend?.sideEffects)) {
    return tool.backend.sideEffects;
  }
  return [];
}

function inferCapabilities(toolId = '', tool = {}) {
  const text = `${toolId} ${tool?.name || ''} ${tool?.description || ''}`.toLowerCase();
  const capabilities = new Set();
  if (/search|fetch|scrape|web|research/.test(text)) capabilities.add('research');
  if (/file|document|artifact/.test(text)) capabilities.add('file');
  if (/remote|ssh|server|k3s|kubernetes|deploy|kubectl/.test(text)) capabilities.add('remote');
  if (/schedule|workload|cron|recurring|deferred/.test(text)) capabilities.add('schedule');
  if (/agent|delegate|parallel/.test(text)) capabilities.add('delegate');
  return Array.from(capabilities);
}

function classifyToolRisk(toolId = '', params = {}, tool = {}) {
  const override = TOOL_CONTRACT_OVERRIDES[toolId] || {};
  return inferToolInvocationRisk({
    toolId,
    input: params,
    sideEffects: normalizeSideEffects(tool),
    defaultRisk: override.risk,
  });
}

function buildToolContract(toolId = '', tool = {}) {
  const override = TOOL_CONTRACT_OVERRIDES[toolId] || {};
  const sideEffects = normalizeSideEffects(tool);
  const capabilities = Array.from(new Set([
    ...inferCapabilities(toolId, tool),
    ...(override.capabilities || []),
  ]));

  return {
    type: 'ToolContract',
    id: toolId,
    name: tool?.name || toolId,
    description: tool?.description || '',
    toolVersion: tool?.version || '1.0.0',
    inputSchema: tool?.inputSchema || tool?.schema || null,
    outputSchema: tool?.outputSchema || null,
    sideEffects,
    capabilities,
    foregroundEligible: override.foregroundEligible ?? true,
    backgroundEligible: override.backgroundEligible ?? sideEffects.includes('write'),
    supportsSchedule: override.supportsSchedule ?? capabilities.includes('schedule'),
    destructiveRisk: override.destructiveRisk || (sideEffects.includes('write') ? 'medium' : 'low'),
    requiresConfirmation: override.requiresConfirmation ?? tool?.skill?.requiresConfirmation === true,
    idempotency: override.idempotency || 'unknown',
    risk: classifyToolRisk(toolId, {}, tool),
    riskModel: TOOL_INVOCATION_VERSION,
    readiness: tool?.readiness || null,
  };
}

function getToolContract(toolManager, toolId = '') {
  const tool = toolManager?.getTool?.(toolId);
  if (!tool) {
    return null;
  }
  return buildToolContract(toolId, {
    ...tool,
    readiness: typeof toolManager?.getToolReadiness === 'function'
      ? toolManager.getToolReadiness(toolId)
      : null,
  });
}

module.exports = {
  buildToolContract,
  classifyToolRisk,
  getToolContract,
};
