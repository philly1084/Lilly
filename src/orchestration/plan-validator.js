function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePlanStep(step = {}) {
  if (!isPlainObject(step)) {
    return null;
  }
  return {
    tool: String(step.tool || step.name || '').trim(),
    reason: String(step.reason || '').trim(),
    params: isPlainObject(step.params) ? step.params : {},
  };
}

function validateRequired(schema = {}, params = {}) {
  const missing = [];
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    const value = params[key];
    const isBlankString = typeof value === 'string' && value.trim() === '';
    if (!Object.prototype.hasOwnProperty.call(params, key) || value === undefined || value === null || isBlankString) {
      missing.push(key);
    }
  }
  return missing;
}

function validateBuiltInRequiredParams(normalized = {}) {
  const params = isPlainObject(normalized?.params) ? normalized.params : {};
  const missing = [];

  if (['web-fetch', 'web-scrape'].includes(normalized?.tool)) {
    const url = params.url;
    if (!Object.prototype.hasOwnProperty.call(params, 'url')
      || url === undefined
      || url === null
      || (typeof url === 'string' && url.trim() === '')) {
      missing.push('url');
    }
  }

  if (normalized?.tool === 'document-workflow') {
    const action = params.action;
    if (!Object.prototype.hasOwnProperty.call(params, 'action')
      || action === undefined
      || action === null
      || (typeof action === 'string' && action.trim() === '')) {
      missing.push('action');
    }
  }

  if (normalized?.tool === 'code-sandbox') {
    const language = params.language;
    if (!Object.prototype.hasOwnProperty.call(params, 'language')
      || language === undefined
      || language === null
      || (typeof language === 'string' && language.trim() === '')) {
      missing.push('language');
    }
  }

  return missing;
}

function validateEnum(schema = {}, params = {}) {
  const invalid = [];
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(params, key) || !Array.isArray(propertySchema?.enum)) {
      continue;
    }
    if (!propertySchema.enum.includes(params[key])) {
      invalid.push({ key, allowed: propertySchema.enum, actual: params[key] });
    }
  }
  return invalid;
}

function validateAdditionalProperties(schema = {}, params = {}) {
  if (schema.additionalProperties !== false || !isPlainObject(schema.properties)) {
    return [];
  }
  return Object.keys(params).filter((key) => !Object.prototype.hasOwnProperty.call(schema.properties, key));
}

function requiresConfirmationForStep(contract = null, normalized = null) {
  if (contract?.requiresConfirmation !== true) {
    return false;
  }

  if (normalized?.tool === 'code-sandbox'
    && String(normalized?.params?.mode || '').trim().toLowerCase() === 'project') {
    return false;
  }

  return true;
}

function validatePlanStep(step = {}, {
  candidateToolIds = [],
  toolManager = null,
  contracts = {},
  allowUnsupportedManagedApp = false,
} = {}) {
  const normalized = normalizePlanStep(step);
  const rejections = [];
  if (!normalized?.tool) {
    return {
      ok: false,
      step: normalized,
      rejections: [{ code: 'missing_tool', message: 'Plan step is missing a tool id.' }],
    };
  }

  if (normalized.tool === 'managed-app' && !allowUnsupportedManagedApp) {
    rejections.push({ code: 'unsupported_tool', message: '`managed-app` is not an autonomous orchestration tool.' });
  }

  if (Array.isArray(candidateToolIds) && candidateToolIds.length > 0 && !candidateToolIds.includes(normalized.tool)) {
    rejections.push({ code: 'not_candidate', message: `Tool ${normalized.tool} is not in the active candidate set.` });
  }

  const tool = toolManager?.getTool?.(normalized.tool);
  if (toolManager && !tool) {
    rejections.push({ code: 'unknown_tool', message: `Tool ${normalized.tool} is not registered.` });
  }

  const contract = contracts[normalized.tool] || null;
  if (contract?.readiness?.status === 'unavailable') {
    rejections.push({
      code: 'tool_unavailable',
      message: `Tool ${normalized.tool} is unavailable: ${contract.readiness.reason || 'not ready'}`,
      readiness: contract.readiness,
    });
  }
  if (contract?.readiness?.status === 'degraded'
    && contract?.readiness?.executableShape === 'none') {
    rejections.push({
      code: 'tool_degraded',
      message: `Tool ${normalized.tool} is degraded: ${contract.readiness.reason || 'not executable'}`,
      readiness: contract.readiness,
    });
  }
  if (requiresConfirmationForStep(contract, normalized)) {
    rejections.push({ code: 'confirmation_required', message: `Tool ${normalized.tool} requires confirmation.` });
  }

  const builtInMissing = validateBuiltInRequiredParams(normalized);
  if (builtInMissing.length > 0) {
    rejections.push({
      code: 'missing_required_params',
      message: `Missing required params: ${builtInMissing.join(', ')}`,
      missing: builtInMissing,
    });
  }

  const schema = contract?.inputSchema || tool?.inputSchema || tool?.schema || null;
  if (schema) {
    const missing = validateRequired(schema, normalized.params);
    const schemaMissing = missing.filter((key) => !builtInMissing.includes(key));
    if (schemaMissing.length > 0) {
      rejections.push({ code: 'missing_required_params', message: `Missing required params: ${schemaMissing.join(', ')}`, missing: schemaMissing });
    }

    const invalidEnums = validateEnum(schema, normalized.params);
    for (const invalidEnum of invalidEnums) {
      rejections.push({
        code: 'invalid_enum',
        message: `${invalidEnum.key} must be one of: ${invalidEnum.allowed.join(', ')}`,
        ...invalidEnum,
      });
    }

    const unknown = validateAdditionalProperties(schema, normalized.params);
    if (unknown.length > 0) {
      rejections.push({ code: 'unknown_params', message: `Unknown params: ${unknown.join(', ')}`, unknown });
    }
  }

  return {
    ok: rejections.length === 0,
    step: normalized,
    rejections,
  };
}

function validatePlan(steps = [], options = {}) {
  const validations = (Array.isArray(steps) ? steps : []).map((step) => validatePlanStep(step, options));
  return {
    type: 'ValidatedPlan',
    ok: validations.every((validation) => validation.ok),
    steps: validations.filter((validation) => validation.ok).map((validation) => validation.step),
    rejected: validations.filter((validation) => !validation.ok),
  };
}

module.exports = {
  validatePlan,
  validatePlanStep,
};
