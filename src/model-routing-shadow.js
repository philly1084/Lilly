'use strict';

const {
  requiredCapabilitiesForRequest,
  selectAutoModel,
} = require('./model-catalog');

const MODEL_ROUTING_SHADOW_VERSION = 'ModelRoutingShadow/v1';

function normalizeText(value = '') {
  return String(value || '').trim();
}

function buildModelRoutingShadow({
  models = [],
  currentModel = '',
  request = {},
  role = 'direct',
} = {}) {
  const normalizedModels = [];
  const seen = new Set();
  (Array.isArray(models) ? models : []).forEach((model) => {
    const normalized = typeof model === 'string' ? { id: normalizeText(model) } : model;
    const id = normalizeText(normalized?.id);
    if (!id || seen.has(id)) return;
    seen.add(id);
    normalizedModels.push({ ...normalized, id });
  });
  const proposed = selectAutoModel(normalizedModels, request);
  const current = normalizeText(currentModel);
  return {
    schemaVersion: MODEL_ROUTING_SHADOW_VERSION,
    mode: 'shadow',
    role: normalizeText(role) || 'direct',
    currentModel: current || null,
    proposedModel: proposed?.id || null,
    changed: Boolean(current && proposed?.id && current !== proposed.id),
    requiredCapabilities: requiredCapabilitiesForRequest(request),
    candidateModels: normalizedModels.map((model) => model.id),
    applied: false,
    observedAt: new Date().toISOString(),
  };
}

module.exports = {
  MODEL_ROUTING_SHADOW_VERSION,
  buildModelRoutingShadow,
};
