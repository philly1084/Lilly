const crypto = require('crypto');
const { detectPii } = require('./pii-detectors');
const { resolvePiiPolicy, assertPiiReady } = require('./pii-policy');
const { piiVaultStore, valueIndexHmac } = require('./pii-vault-store');

function typeToken(type = '') {
  return String(type || 'PII').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'PII';
}

function buildPlaceholder(match = {}, policy = {}, stablePlaceholders = new Map()) {
  const mode = policy.placeholderMode || 'typed-random';
  if (mode === 'stable-per-value') {
    const key = valueIndexHmac(match.value, match.type).slice(0, 16);
    if (stablePlaceholders.has(key)) return stablePlaceholders.get(key);
    const placeholder = `[[PII:${typeToken(match.type)}:${key}]]`;
    stablePlaceholders.set(key, placeholder);
    return placeholder;
  }
  const suffix = crypto.randomBytes(6).toString('hex');
  if (mode === 'opaque-random') {
    return `[[PII:${suffix}]]`;
  }
  return `[[PII:${typeToken(match.type)}:${suffix}]]`;
}

function normalizeAction(action = '') {
  const normalized = String(action || '').trim();
  if (['vault-placeholder', 'mask', 'remove', 'ignore'].includes(normalized)) {
    return normalized;
  }
  return 'vault-placeholder';
}

function resolveDetectorAction(match = {}, policy = {}) {
  const actions = policy.detectorActions && typeof policy.detectorActions === 'object' && !Array.isArray(policy.detectorActions)
    ? policy.detectorActions
    : {};
  const action = normalizeAction(actions[match.type] || actions[typeToken(match.type)] || actions.default || 'vault-placeholder');
  if (action === 'vault-placeholder' && policy.failClosed === false && (!policy.hasMasterKey || !policy.storageReady)) {
    return 'mask';
  }
  return action;
}

function buildNonRestorablePlaceholder(match = {}, action = 'mask') {
  const type = typeToken(match.type);
  return action === 'remove'
    ? `[[PII:${type}:REMOVED]]`
    : `[[PII:${type}:MASKED]]`;
}

function buildModelFrame(replacements = []) {
  const entries = (Array.isArray(replacements) ? replacements : [])
    .map((entry) => ({
      placeholder: entry.placeholder,
      type: entry.type,
      occurrenceIndex: Number(entry.occurrenceIndex || 0),
      sourceRange: entry.sourceRange || { start: entry.start, end: entry.end },
    }))
    .filter((entry) => entry.placeholder);
  if (entries.length === 0) {
    return null;
  }
  const countsByType = entries.reduce((acc, entry) => {
    const key = typeToken(entry.type);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    instruction: [
      'Privacy gateway is active for this request.',
      'Private values were replaced with placeholders before this model call.',
      'Preserve placeholders exactly when the private value should appear in the answer.',
      'Do not invent, infer, transform, or reveal the underlying private values.',
      'Use the placeholder type as semantic context for reasoning, citations, summaries, and section-scoped search.',
    ].join(' '),
    countsByType,
    placeholders: entries,
  };
}

function appendModelFrameInstruction(instructions, frame = null) {
  if (!frame?.instruction || typeof instructions !== 'string') {
    return instructions;
  }
  return [instructions, `PII placeholder framing: ${frame.instruction}`].filter(Boolean).join('\n\n');
}

async function sanitizeText(text = '', {
  sessionId = '',
  ownerId = null,
  clientSurface = '',
  route = '',
  metadata = {},
  policy = null,
} = {}) {
  const source = String(text || '');
  const resolvedPolicy = policy || resolvePiiPolicy({ metadata, clientSurface, route });
  if (!resolvedPolicy.enabled || !source) {
    return {
      text: source,
      changed: false,
      contextId: null,
      replacements: [],
      policy: resolvedPolicy,
    };
  }
  if (resolvedPolicy.failClosed !== false) {
    assertPiiReady(resolvedPolicy);
  }

  const matches = detectPii(source, resolvedPolicy);
  if (matches.length === 0) {
    return {
      text: source,
      changed: false,
      contextId: null,
      replacements: [],
      policy: resolvedPolicy,
    };
  }

  const stablePlaceholders = new Map();
  const replacements = matches
    .map((match, index) => {
      const action = resolveDetectorAction(match, resolvedPolicy);
      if (action === 'ignore') {
        return null;
      }
      return {
        ...match,
        action,
        restorable: action === 'vault-placeholder',
        placeholder: action === 'vault-placeholder'
          ? buildPlaceholder(match, resolvedPolicy, stablePlaceholders)
          : buildNonRestorablePlaceholder(match, action),
        occurrenceIndex: index,
        sourceRange: { start: match.start, end: match.end },
      };
    })
    .filter(Boolean);

  if (replacements.length === 0) {
    return {
      text: source,
      changed: false,
      contextId: null,
      replacements: [],
      policy: resolvedPolicy,
    };
  }

  let sanitized = source;
  [...replacements].reverse().forEach((match) => {
    sanitized = `${sanitized.slice(0, match.start)}${match.placeholder}${sanitized.slice(match.end)}`;
  });

  const vaultReplacements = replacements.filter((entry) => entry.restorable);
  let context = null;
  if (vaultReplacements.length > 0) {
    assertPiiReady(resolvedPolicy);
    context = await piiVaultStore.createContext({
      sessionId,
      ownerId,
      sourceSurface: clientSurface || route || 'unknown',
      policySnapshot: {
        placeholderMode: resolvedPolicy.placeholderMode,
        reintroductionMode: resolvedPolicy.reintroductionMode,
        detectors: resolvedPolicy.detectors,
        detectorActions: resolvedPolicy.detectorActions || {},
        customPatternCount: Array.isArray(resolvedPolicy.customPatterns) ? resolvedPolicy.customPatterns.length : 0,
        dictionaryCount: Array.isArray(resolvedPolicy.dictionary) ? resolvedPolicy.dictionary.length : 0,
        auditProfile: resolvedPolicy.auditProfile || 'baseline',
      },
    });
    await piiVaultStore.addEntries(context.id, vaultReplacements);
  }
  const modelFrame = buildModelFrame(replacements);

  return {
    text: sanitized,
    changed: sanitized !== source,
    contextId: context?.id || null,
    modelFrame,
    replacements: replacements.map((entry) => ({
      placeholder: entry.placeholder,
      type: entry.type,
      action: entry.action,
      restorable: entry.restorable,
      start: entry.start,
      end: entry.end,
      occurrenceIndex: entry.occurrenceIndex,
      sourceRange: entry.sourceRange,
    })),
    policy: resolvedPolicy,
  };
}

async function sanitizeStringValues(value, options = {}, state = { contextIds: [], replacements: [] }) {
  if (typeof value === 'string') {
    const result = await sanitizeText(value, options);
    if (result.contextId) state.contextIds.push(result.contextId);
    if (Array.isArray(result.replacements)) state.replacements.push(...result.replacements);
    return result.text;
  }
  if (Array.isArray(value)) {
    const next = [];
    for (const item of value) {
      next.push(await sanitizeStringValues(item, options, state));
    }
    return next;
  }
  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = await sanitizeStringValues(item, options, state);
    }
    return next;
  }
  return value;
}

async function sanitizeRuntimePayload(payload = {}, options = {}) {
  const policy = resolvePiiPolicy(options);
  if (!policy.enabled) {
    return { payload, changed: false, contextIds: [], replacements: [], policy, modelFrame: null };
  }
  if (policy.failClosed !== false) {
    assertPiiReady(policy);
  }
  const state = { contextIds: [], replacements: [] };
  const next = { ...payload };
  for (const key of ['input', 'memoryInput', 'instructions', 'contextMessages', 'recentMessages']) {
    if (next[key] !== undefined && next[key] !== null) {
      next[key] = await sanitizeStringValues(next[key], { ...options, policy }, state);
    }
  }
  const modelFrame = buildModelFrame(state.replacements);
  next.instructions = appendModelFrameInstruction(next.instructions, modelFrame);
  next.metadata = {
    ...(next.metadata && typeof next.metadata === 'object' ? next.metadata : {}),
    piiCleansing: {
      enabled: true,
      contextIds: Array.from(new Set(state.contextIds)),
      replacementCount: state.replacements.length,
      placeholderMode: policy.placeholderMode,
      modelFrame,
    },
  };
  return {
    payload: next,
    changed: state.replacements.length > 0,
    contextIds: Array.from(new Set(state.contextIds)),
    replacements: state.replacements,
    policy,
    modelFrame,
  };
}

module.exports = {
  sanitizeText,
  sanitizeRuntimePayload,
  sanitizeStringValues,
  buildModelFrame,
};
