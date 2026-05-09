const { buildAgencyProfile, inferTaskIntent, AGENCY_MODES } = require('./intent-classifier');
const { getToolContract } = require('./tool-contracts');

function isOrchestrationRewriteEnabled() {
  return String(process.env.ORCHESTRATION_REWRITE_ENABLED || '').trim().toLowerCase() === 'true';
}

function shouldAllowManagedAppTool({
  objective = '',
  executionProfile = 'default',
} = {}) {
  const normalized = String(objective || '').trim().toLowerCase();
  return executionProfile === 'remote-build'
    || /\b(managed app|managed-app|gitlab|gitlab ci|gitlab runner|build events webhook)\b/.test(normalized);
}

function removeUnsupportedAutonomousTools(toolIds = [], {
  allowManagedApp = false,
} = {}) {
  return Array.from(new Set((Array.isArray(toolIds) ? toolIds : [])
    .map((toolId) => String(toolId || '').trim())
    .filter((toolId) => toolId && (allowManagedApp || toolId !== 'managed-app'))));
}

function selectCandidatesForAgencyMode({
  candidateToolIds = [],
  agencyProfile = null,
  allowManagedApp = false,
} = {}) {
  const candidates = removeUnsupportedAutonomousTools(candidateToolIds, { allowManagedApp });
  const mode = agencyProfile?.mode || AGENCY_MODES.RESPOND;

  if (mode === AGENCY_MODES.SCHEDULE || mode === AGENCY_MODES.SCHEDULE_MULTIPLE) {
    return candidates.includes('agent-workload') ? ['agent-workload'] : candidates;
  }
  if (mode === AGENCY_MODES.DELEGATE) {
    return candidates.includes('agent-delegate') ? ['agent-delegate'] : candidates;
  }
  if (mode === AGENCY_MODES.RESPOND) {
    return candidates.filter((toolId) => !['agent-workload', 'agent-delegate'].includes(toolId));
  }
  return candidates;
}

function buildToolContracts(toolManager, toolIds = [], options = {}) {
  const contracts = {};
  for (const toolId of removeUnsupportedAutonomousTools(toolIds, options)) {
    const contract = getToolContract(toolManager, toolId);
    if (contract) {
      contracts[toolId] = contract;
    }
  }
  return contracts;
}

function applyRewritePolicyOverlay({
  legacyPolicy = {},
  objective = '',
  instructions = '',
  executionProfile = 'default',
  classification = null,
  agencyProfile = null,
  toolManager = null,
} = {}) {
  const intent = inferTaskIntent({
    objective,
    instructions,
    executionProfile,
    classification,
  });
  const resolvedAgencyProfile = agencyProfile?.source === 'orchestration-rewrite'
    ? agencyProfile
    : buildAgencyProfile({ intent, objective, executionProfile });
  const allowManagedApp = shouldAllowManagedAppTool({ objective, executionProfile });
  const allowedToolIds = removeUnsupportedAutonomousTools(legacyPolicy.allowedToolIds || [], { allowManagedApp });
  const baseCandidates = removeUnsupportedAutonomousTools(legacyPolicy.candidateToolIds || [], { allowManagedApp });
  const candidateToolIds = isOrchestrationRewriteEnabled()
    ? selectCandidatesForAgencyMode({
      candidateToolIds: baseCandidates,
      agencyProfile: resolvedAgencyProfile,
      allowManagedApp,
    })
    : baseCandidates;
  const contracts = buildToolContracts(toolManager, allowedToolIds, { allowManagedApp });

  return {
    ...legacyPolicy,
    type: 'ToolPolicy',
    allowedToolIds,
    candidateToolIds,
    toolContracts: contracts,
    orchestrationRewrite: {
      enabled: isOrchestrationRewriteEnabled(),
      intent,
      agencyProfile: resolvedAgencyProfile,
    },
  };
}

module.exports = {
  applyRewritePolicyOverlay,
  buildToolContracts,
  isOrchestrationRewriteEnabled,
  removeUnsupportedAutonomousTools,
  selectCandidatesForAgencyMode,
  shouldAllowManagedAppTool,
};
