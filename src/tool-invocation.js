'use strict';

const crypto = require('crypto');
const {
  EVIDENCE_ATTESTATION_VERSION,
  normalizeEvidenceAttestation,
  redactSecrets,
  stableSha256,
  stableStringify,
} = require('./agent-evidence');

const TOOL_INVOCATION_VERSION = 'ToolInvocation/v2';
const TOOL_INVOCATION_AUTHORITY_VERSION = 'ToolInvocationAuthority/v1';
const TOOL_INVOCATION_AUTHORITY_ISSUER = 'kimibuilt-runtime';
const TOOL_INVOCATION_AUTHORITY_SECRET = String(
  process.env.KIMIBUILT_TOOL_INVOCATION_SIGNING_SECRET
  || process.env.KIMIBUILT_ATTESTATION_SECRET
  || process.env.KIMIBUILT_JWT_SECRET
  || process.env.LILLYBUILT_JWT_SECRET
  || '',
).trim() || crypto.randomBytes(32).toString('hex');
const TOOL_INVOCATION_AUTHORITY_KEY_ID = crypto.createHash('sha256')
  .update(TOOL_INVOCATION_AUTHORITY_SECRET)
  .digest('hex')
  .slice(0, 16);
const APPROVAL_RECEIPT_VERSION = 'ApprovalReceipt/v1';
const APPROVAL_AUTHORITY_VERSION = 'ApprovalAuthority/v1';
const APPROVAL_AUTHORITY_ISSUER = 'kimibuilt-runtime';
const APPROVAL_AUTHORITY_SECRET = String(
  process.env.KIMIBUILT_APPROVAL_SIGNING_SECRET
  || process.env.KIMIBUILT_ATTESTATION_SECRET
  || process.env.KIMIBUILT_JWT_SECRET
  || process.env.LILLYBUILT_JWT_SECRET
  || '',
).trim() || crypto.randomBytes(32).toString('hex');
const APPROVAL_AUTHORITY_KEY_ID = crypto.createHash('sha256')
  .update(APPROVAL_AUTHORITY_SECRET)
  .digest('hex')
  .slice(0, 16);
const TOOL_APPROVAL_POLICY_VERSION = 'ToolApprovalPolicy/v1';
const TOOL_INVOCATION_RISKS = Object.freeze([
  'read',
  'write',
  'external',
  'destructive',
]);
const TOOL_INVOCATION_STATUSES = Object.freeze([
  'pending',
  'planned',
  'running',
  'succeeded',
  'completed',
  'failed',
  'blocked',
  'cancelled',
  'canceled',
]);

const DESTRUCTIVE_RE = /(?:\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f|push\b[^\n]*--force|branch\s+-D)\b|\brm\s+(?:-[^\s]*[rf]|--recursive|--force)\b|\bkubectl\s+delete\b|\bhelm\s+uninstall\b|\b(?:delete|destroy|drop|truncate|wipe|purge|erase|uninstall|revoke)\b)/i;
const SECRET_RE = /\b(?:api[\s_-]*keys?|credentials?|passwords?|private[\s_-]*keys?|secrets?|tokens?)\b/i;
const SECRET_MUTATION_RE = /\b(?:create|delete|destroy|drop|edit|patch|purge|replace|revoke|rotate|set|update|wipe)\b/i;
const EXTERNAL_MUTATION_RE = /\b(?:apply|deploy|expose|merge|publish|push|release|restart|rollout\s+restart|scale|send|start|stop|trigger|upgrade)\b/i;
const WRITE_RE = /\b(?:add|checkout|commit|copy|create|edit|fetch|generate|install|mkdir|modify|move|patch|restore|touch|update|write)\b/i;
const READ_ONLY_RE = /(?:\b(?:describe|get|health|inspect|list|logs?|query|read|search|show|status|version)\b|\bgit\s+(?:branch\s+--list|diff|log|ls-files|remote\s+-v|show|status)\b|\bkubectl\s+(?:auth\s+can-i|describe|get|logs|rollout\s+status|top)\b|\bdocker\s+(?:images|inspect|logs|ps|version)\b|\bhelm\s+(?:get|history|list|status)\b|\b(?:cat|find|grep|hostname|ls|pwd|rg|sed\s+-n|uname|uptime|whoami)\b)/i;

function isStructuredObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function collectActionText(value, parts = []) {
  if (typeof value === 'string') {
    parts.push(value);
    return parts;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectActionText(entry, parts));
    return parts;
  }
  if (isStructuredObject(value)) {
    Object.entries(value).forEach(([key, entry]) => {
      if (/^(?:action|args|command|commands|description|method|mode|operation|prompt|task|type)$/i.test(key)) {
        collectActionText(entry, parts);
      } else if (isStructuredObject(entry) || Array.isArray(entry)) {
        collectActionText(entry, parts);
      }
    });
  }
  return parts;
}

function normalizeSideEffectTypes(sideEffects = []) {
  return (Array.isArray(sideEffects) ? sideEffects : [])
    .map((effect) => String(effect?.type || effect || '').trim().toLowerCase())
    .filter(Boolean);
}

function inferToolInvocationRisk({
  toolId = '',
  input = {},
  sideEffects = [],
  defaultRisk = '',
} = {}) {
  const actionText = collectActionText(redactSecrets(input)).join('\n').trim();
  const toolText = String(toolId || '').trim().toLowerCase();
  const combined = `${toolText}\n${actionText}`;
  const effectTypes = normalizeSideEffectTypes(sideEffects);

  if (/\bgit(?:-safe)?\b/.test(toolText)) {
    if (/^(?:status|diff|branch|remote-info)$/i.test(actionText)) {
      return 'read';
    }
    if (/^(?:push|save-and-push)$/i.test(actionText)) {
      return 'external';
    }
    if (/^(?:add|commit)$/i.test(actionText)) {
      return 'write';
    }
  }
  if (/\bk3s-deploy\b/.test(toolText) && /^rollout-status$/i.test(actionText)) {
    return 'read';
  }

  if (DESTRUCTIVE_RE.test(actionText) || DESTRUCTIVE_RE.test(combined)) {
    return 'destructive';
  }
  if (SECRET_RE.test(combined)) {
    if (SECRET_MUTATION_RE.test(actionText)) {
      return 'destructive';
    }
    return 'external';
  }

  const hasExplicitReadOnlyAction = Boolean(actionText) && READ_ONLY_RE.test(actionText);
  const hasExternalMutation = EXTERNAL_MUTATION_RE.test(actionText);
  const hasWrite = WRITE_RE.test(actionText);
  if (hasExplicitReadOnlyAction && !hasExternalMutation && !hasWrite) {
    return 'read';
  }
  if (hasExternalMutation) {
    return 'external';
  }
  if (hasWrite) {
    return 'write';
  }

  const normalizedDefault = String(defaultRisk || '').trim().toLowerCase();
  if (TOOL_INVOCATION_RISKS.includes(normalizedDefault)) {
    return normalizedDefault;
  }
  if (effectTypes.some((effect) => ['delete', 'destructive'].includes(effect))) {
    return 'destructive';
  }
  if (effectTypes.some((effect) => ['network', 'remote', 'deploy', 'external'].includes(effect))) {
    return 'external';
  }
  if (effectTypes.some((effect) => ['write', 'execute'].includes(effect))) {
    return 'write';
  }
  if (/deploy|k3s|kubectl|remote-cli|ssh/.test(toolText)) {
    return 'external';
  }
  if (/git/.test(toolText)) {
    return 'write';
  }
  return 'read';
}

function normalizeStructuredArray(value, field) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Tool invocation ${field} must be an array.`);
  }
  return redactSecrets(value);
}

function normalizeEvidence(value = []) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('Tool invocation evidence must be an array.');
  }
  return value.map((entry, index) => {
    const normalized = normalizeEvidenceAttestation(entry);
    if (!normalized) {
      throw new Error(`Tool invocation evidence at index ${index} is not a valid ${EVIDENCE_ATTESTATION_VERSION}.`);
    }
    return normalized;
  });
}

function normalizeNullableString(value) {
  if (value == null) {
    return null;
  }
  return String(value).trim() || null;
}

function approvalSigningPayload(receipt = {}) {
  return {
    version: APPROVAL_RECEIPT_VERSION,
    id: receipt.id,
    status: receipt.status,
    scope: receipt.scope,
    runId: receipt.runId,
    toolId: receipt.toolId,
    risk: receipt.risk,
    inputHash: receipt.inputHash,
    grantedBy: receipt.grantedBy,
    grantedAt: receipt.grantedAt,
    expiresAt: receipt.expiresAt,
  };
}

function signApprovalReceipt(receipt = {}) {
  return crypto.createHmac('sha256', APPROVAL_AUTHORITY_SECRET)
    .update(stableStringify(approvalSigningPayload(receipt)))
    .digest('hex');
}

function verifyApprovalAuthority(receipt = {}, authority = {}) {
  if (!isStructuredObject(authority)
    || authority.version !== APPROVAL_AUTHORITY_VERSION
    || authority.issuer !== APPROVAL_AUTHORITY_ISSUER
    || authority.keyId !== APPROVAL_AUTHORITY_KEY_ID) {
    return false;
  }
  const supplied = String(authority.signature || '').toLowerCase();
  const expected = signApprovalReceipt(receipt);
  if (!/^[a-f0-9]{64}$/.test(supplied)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
}

function issueApprovalReceipt(input = {}) {
  if (!isStructuredObject(input)) {
    throw new Error('Approval receipt input must be a structured object.');
  }
  const now = new Date();
  const grantedAt = input.grantedAt ? new Date(input.grantedAt) : now;
  const expiresAt = input.expiresAt
    ? new Date(input.expiresAt)
    : new Date(now.getTime() + (15 * 60 * 1000));
  const receipt = {
    version: APPROVAL_RECEIPT_VERSION,
    id: String(input.id || input.receiptId || '').trim() || `approval-${crypto.randomUUID()}`,
    status: 'approved',
    scope: String(input.scope || '').trim(),
    runId: String(input.runId || '').trim(),
    toolId: String(input.toolId || '').trim(),
    risk: String(input.risk || '').trim().toLowerCase(),
    inputHash: String(input.inputHash || '').trim().toLowerCase(),
    grantedBy: String(input.grantedBy || '').trim(),
    grantedAt: Number.isNaN(grantedAt.getTime()) ? '' : grantedAt.toISOString(),
    expiresAt: Number.isNaN(expiresAt.getTime()) ? '' : expiresAt.toISOString(),
  };
  if (!receipt.scope) receipt.scope = `${receipt.toolId}:${receipt.risk}`;
  if (!receipt.runId || !receipt.toolId || !TOOL_INVOCATION_RISKS.includes(receipt.risk)
    || !/^[a-f0-9]{64}$/.test(receipt.inputHash) || !receipt.grantedBy
    || !receipt.grantedAt || !receipt.expiresAt || expiresAt.getTime() <= grantedAt.getTime()) {
    throw new Error('Approval receipts require exact run, tool, risk, input hash, issuer, and validity bounds.');
  }
  receipt.authority = {
    version: APPROVAL_AUTHORITY_VERSION,
    issuer: APPROVAL_AUTHORITY_ISSUER,
    keyId: APPROVAL_AUTHORITY_KEY_ID,
    signature: signApprovalReceipt(receipt),
  };
  return receipt;
}

function normalizeApprovalReceipt(value = null) {
  if (!isStructuredObject(value)) {
    return null;
  }
  const receipt = redactSecrets(value);
  const id = String(receipt.id || receipt.receiptId || '').trim();
  const status = String(receipt.status || '').trim().toLowerCase();
  const scope = String(receipt.scope || '').trim();
  const runId = String(receipt.runId || '').trim();
  const toolId = String(receipt.toolId || '').trim();
  const risk = String(receipt.risk || '').trim().toLowerCase();
  const inputHash = String(receipt.inputHash || '').trim().toLowerCase();
  const grantedBy = String(receipt.grantedBy || '').trim();
  const grantedAt = receipt.grantedAt ? new Date(receipt.grantedAt) : null;
  if (!id || !scope || status !== 'approved' || !runId || !toolId
    || !TOOL_INVOCATION_RISKS.includes(risk) || !/^[a-f0-9]{64}$/.test(inputHash)
    || !grantedBy || !grantedAt || Number.isNaN(grantedAt.getTime())) {
    return null;
  }
  const expiresAt = receipt.expiresAt ? new Date(receipt.expiresAt) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()
    || expiresAt.getTime() <= grantedAt.getTime()) {
    return null;
  }
  const normalized = {
    version: APPROVAL_RECEIPT_VERSION,
    id,
    status,
    scope,
    runId,
    toolId,
    risk,
    inputHash,
    grantedBy,
    grantedAt: grantedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  if (!verifyApprovalAuthority(normalized, receipt.authority)) {
    return null;
  }
  return {
    ...normalized,
    authority: receipt.authority,
  };
}

function approvalReceiptMatches(receipt = null, invocation = {}) {
  const normalized = normalizeApprovalReceipt(receipt);
  if (!normalized) return false;
  if (normalized.runId !== invocation.runId) return false;
  if (normalized.toolId !== invocation.toolId) return false;
  if (normalized.risk !== invocation.risk) return false;
  if (normalized.inputHash !== invocation.inputHash) return false;
  return normalized.scope === `${invocation.toolId}:${invocation.risk}`;
}

function decideToolInvocationApproval(invocation = {}, options = {}) {
  const risk = String(invocation.risk || '').trim().toLowerCase();
  if (risk === 'read') {
    return {
      version: TOOL_APPROVAL_POLICY_VERSION,
      allowed: true,
      mode: 'automatic-read',
      receipt: null,
      reason: 'Read-only invocations are allowed automatically.',
    };
  }
  if (risk === 'write' && options.sandboxMode === true && options.workspaceBounded === true) {
    return {
      version: TOOL_APPROVAL_POLICY_VERSION,
      allowed: true,
      mode: 'bounded-sandbox-write',
      receipt: null,
      reason: 'The write is bounded to the approved sandbox workspace.',
    };
  }
  const receipt = normalizeApprovalReceipt(options.approvalReceipt);
  if (approvalReceiptMatches(receipt, invocation)) {
    return {
      version: TOOL_APPROVAL_POLICY_VERSION,
      allowed: true,
      mode: 'scoped-approval',
      receipt,
      reason: 'A matching scoped approval receipt authorizes this invocation.',
    };
  }
  return {
    version: TOOL_APPROVAL_POLICY_VERSION,
    allowed: false,
    mode: 'approval-required',
    receipt: null,
    reason: `${risk || 'mutating'} invocation requires a matching scoped approval receipt.`,
  };
}

function toolInvocationSigningPayload(invocation = {}) {
  return {
    version: TOOL_INVOCATION_VERSION,
    id: invocation.id,
    runId: invocation.runId,
    toolId: invocation.toolId,
    toolVersion: invocation.toolVersion,
    inputHash: invocation.inputHash,
    risk: invocation.risk,
    approvalReceiptId: invocation.approvalReceiptId,
    idempotencyKey: invocation.idempotencyKey,
    retrySafe: invocation.retrySafe,
    preconditionsDigest: stableSha256(invocation.preconditions),
    resultDigest: stableSha256(invocation.result),
    postconditionsDigest: stableSha256(invocation.postconditions),
    evidenceDigests: (Array.isArray(invocation.evidence) ? invocation.evidence : [])
      .map((entry) => entry.digest),
    sideEffectsDigest: stableSha256(invocation.sideEffects),
    compensationDigest: stableSha256(invocation.compensation),
    status: invocation.status,
  };
}

function signToolInvocation(invocation = {}) {
  return crypto.createHmac('sha256', TOOL_INVOCATION_AUTHORITY_SECRET)
    .update(stableStringify(toolInvocationSigningPayload(invocation)))
    .digest('hex');
}

function verifyToolInvocationAuthority(invocation = {}) {
  const authority = invocation.authority;
  if (!isStructuredObject(authority)
    || authority.version !== TOOL_INVOCATION_AUTHORITY_VERSION
    || authority.issuer !== TOOL_INVOCATION_AUTHORITY_ISSUER
    || authority.keyId !== TOOL_INVOCATION_AUTHORITY_KEY_ID) {
    return false;
  }
  const supplied = String(authority.signature || '').toLowerCase();
  const expected = signToolInvocation(invocation);
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
}

function createToolInvocation(input = {}) {
  if (!isStructuredObject(input)) {
    throw new Error('Tool invocation input must be a structured object.');
  }
  const runId = String(input.runId || '').trim();
  const toolId = String(input.toolId || '').trim();
  if (!runId) {
    throw new Error('Tool invocation runId is required.');
  }
  if (!toolId) {
    throw new Error('Tool invocation toolId is required.');
  }

  const hasRawInput = Object.prototype.hasOwnProperty.call(input, 'input')
    || Object.prototype.hasOwnProperty.call(input, 'params');
  const rawInput = Object.prototype.hasOwnProperty.call(input, 'input') ? input.input : input.params;
  const computedInputHash = stableSha256(hasRawInput ? rawInput : {});
  const suppliedInputHash = String(input.inputHash || '').trim().toLowerCase();
  if (suppliedInputHash && !/^[a-f0-9]{64}$/.test(suppliedInputHash)) {
    throw new Error('Tool invocation inputHash must be a SHA-256 hex digest.');
  }
  if (suppliedInputHash && hasRawInput && suppliedInputHash !== computedInputHash) {
    throw new Error('Tool invocation inputHash does not match the structured input.');
  }
  const inputHash = suppliedInputHash || computedInputHash;

  const risk = String(input.risk || '').trim().toLowerCase()
    || inferToolInvocationRisk({
      toolId,
      input: hasRawInput ? rawInput : {},
      sideEffects: input.sideEffects,
      defaultRisk: input.defaultRisk,
    });
  if (!TOOL_INVOCATION_RISKS.includes(risk)) {
    throw new Error(`Tool invocation risk must be one of: ${TOOL_INVOCATION_RISKS.join(', ')}.`);
  }
  const status = String(input.status || 'planned').trim().toLowerCase();
  if (!TOOL_INVOCATION_STATUSES.includes(status)) {
    throw new Error(`Tool invocation status must be one of: ${TOOL_INVOCATION_STATUSES.join(', ')}.`);
  }

  const idempotencyKey = String(input.idempotencyKey || '').trim()
    || `${runId}:${toolId}:${inputHash.slice(0, 24)}`;
  const compensation = input.compensation == null ? null : redactSecrets(input.compensation);
  if (compensation !== null && !isStructuredObject(compensation)) {
    throw new Error('Tool invocation compensation must be a structured object or null.');
  }

  const retrySafe = risk === 'read'
    || input.retrySafe === true
    || input.idempotency?.safeToRetry === true;
  const approvalReceipt = normalizeApprovalReceipt(input.approvalReceipt);

  const invocation = {
    version: TOOL_INVOCATION_VERSION,
    id: String(input.id || '').trim() || `invocation-${crypto.randomUUID()}`,
    runId,
    toolId,
    toolVersion: String(input.toolVersion || '1.0.0').trim() || '1.0.0',
    inputHash,
    risk,
    approvalReceiptId: normalizeNullableString(input.approvalReceiptId || approvalReceipt?.id),
    idempotencyKey,
    retrySafe,
    preconditions: normalizeStructuredArray(input.preconditions, 'preconditions'),
    result: input.result === undefined ? null : redactSecrets(input.result),
    postconditions: normalizeStructuredArray(input.postconditions, 'postconditions'),
    evidence: normalizeEvidence(input.evidence),
    sideEffects: normalizeStructuredArray(input.sideEffects, 'sideEffects'),
    compensation,
    status,
  };
  invocation.authority = {
    version: TOOL_INVOCATION_AUTHORITY_VERSION,
    issuer: TOOL_INVOCATION_AUTHORITY_ISSUER,
    keyId: TOOL_INVOCATION_AUTHORITY_KEY_ID,
    signature: signToolInvocation(invocation),
  };
  return invocation;
}

function validateToolInvocation(value = {}) {
  const errors = [];
  if (!isStructuredObject(value)) {
    return { valid: false, errors: ['Tool invocation must be an object.'] };
  }
  if (value.version !== TOOL_INVOCATION_VERSION) errors.push(`version must be ${TOOL_INVOCATION_VERSION}`);
  ['id', 'runId', 'toolId', 'toolVersion', 'idempotencyKey'].forEach((field) => {
    if (!String(value[field] || '').trim()) errors.push(`${field} is required`);
  });
  if (!/^[a-f0-9]{64}$/i.test(String(value.inputHash || ''))) errors.push('inputHash must be SHA-256 hex');
  if (!TOOL_INVOCATION_RISKS.includes(value.risk)) errors.push('risk is invalid');
  if (!TOOL_INVOCATION_STATUSES.includes(value.status)) errors.push('status is invalid');
  if (typeof value.retrySafe !== 'boolean') errors.push('retrySafe must be boolean');
  ['preconditions', 'postconditions', 'evidence', 'sideEffects'].forEach((field) => {
    if (!Array.isArray(value[field])) errors.push(`${field} must be an array`);
  });
  if (Array.isArray(value.evidence)) {
    value.evidence.forEach((entry, index) => {
      if (!normalizeEvidenceAttestation(entry)) errors.push(`evidence[${index}] is invalid`);
    });
  }
  if (value.compensation !== null && !isStructuredObject(value.compensation)) {
    errors.push('compensation must be an object or null');
  }
  if (!verifyToolInvocationAuthority(value)) {
    errors.push('authority signature is invalid');
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

function isToolInvocation(value = {}) {
  return validateToolInvocation(value).valid;
}

module.exports = {
  APPROVAL_RECEIPT_VERSION,
  APPROVAL_AUTHORITY_VERSION,
  TOOL_APPROVAL_POLICY_VERSION,
  TOOL_INVOCATION_RISKS,
  TOOL_INVOCATION_STATUSES,
  TOOL_INVOCATION_AUTHORITY_VERSION,
  TOOL_INVOCATION_VERSION,
  buildToolInvocation: createToolInvocation,
  createToolInvocation,
  decideToolInvocationApproval,
  inferToolRisk: inferToolInvocationRisk,
  inferToolInvocationRisk,
  issueApprovalReceipt,
  isToolInvocation,
  normalizeApprovalReceipt,
  verifyApprovalAuthority,
  verifyToolInvocationAuthority,
  validateToolInvocation,
};
