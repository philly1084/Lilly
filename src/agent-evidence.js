'use strict';

const crypto = require('crypto');

const EVIDENCE_ATTESTATION_VERSION = 'EvidenceAttestation/v1';
const EVIDENCE_AUTHORITY_VERSION = 'EvidenceAuthority/v1';
const EVIDENCE_AUTHORITY_ISSUER = 'kimibuilt-runtime';
const EVIDENCE_AUTHORITY_SECRET = String(
  process.env.KIMIBUILT_EVIDENCE_SIGNING_SECRET
  || process.env.KIMIBUILT_ATTESTATION_SECRET
  || process.env.KIMIBUILT_JWT_SECRET
  || process.env.LILLYBUILT_JWT_SECRET
  || '',
).trim() || crypto.randomBytes(32).toString('hex');
const EVIDENCE_AUTHORITY_KEY_ID = crypto.createHash('sha256')
  .update(EVIDENCE_AUTHORITY_SECRET)
  .digest('hex')
  .slice(0, 16);
const EVIDENCE_REDACTION = '[REDACTED]';
const EVIDENCE_KINDS = Object.freeze([
  'test',
  'command',
  'git',
  'artifact_render',
  'browser_ui',
  'url_tls',
  'deployment',
  'source',
  'approval',
]);
const EVIDENCE_VERDICTS = Object.freeze([
  'pass',
  'fail',
  'blocked',
  'unknown',
]);

const SECRET_KEY_NAMES = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'authtoken',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'password',
  'passwd',
  'privatekey',
  'refreshtoken',
  'secret',
  'secretkey',
  'setcookie',
  'token',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeSecretKey(key = '') {
  return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSecretKey(key = '') {
  const normalized = normalizeSecretKey(key);
  return SECRET_KEY_NAMES.has(normalized)
    || normalized.endsWith('apikey')
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('authtoken')
    || normalized.endsWith('clientsecret')
    || normalized.endsWith('password')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('refreshtoken')
    || normalized.endsWith('secret')
    || normalized.endsWith('secretkey')
    || normalized.endsWith('token');
}

function redactSecretString(value = '') {
  return String(value)
    .replace(
      /\b(Authorization\s*[:=]\s*Bearer\s+)[A-Za-z0-9._~+/=-]{4,}\b/gi,
      `$1${EVIDENCE_REDACTION}`,
    )
    .replace(
      /\b((?:api[\s_-]*key|access[\s_-]*token|auth[\s_-]*token|client[\s_-]*secret|cookie|password|passwd|private[\s_-]*key|refresh[\s_-]*token|secret(?:[\s_-]*key)?|token)\s*[:=]\s*)(["']?)[^\s,;"']{4,}\2/gi,
      `$1${EVIDENCE_REDACTION}`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, `Bearer ${EVIDENCE_REDACTION}`)
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, EVIDENCE_REDACTION)
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{8,}\b/g, EVIDENCE_REDACTION)
    .replace(/\bglpat-[A-Za-z0-9_-]{8,}\b/g, EVIDENCE_REDACTION)
    .replace(/\bAKIA[A-Z0-9]{12,}\b/g, EVIDENCE_REDACTION)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, EVIDENCE_REDACTION);
}

function redactSecrets(value, options = {}) {
  const seen = options.seen || new WeakMap();
  const key = options.key || '';

  if (isSecretKey(key) && value !== undefined && value !== null) {
    return EVIDENCE_REDACTION;
  }
  if (typeof value === 'string') {
    return redactSecretString(value);
  }
  if (value === null || ['number', 'boolean'].includes(typeof value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return {
      type: 'Buffer',
      byteLength: value.byteLength,
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    const output = [];
    seen.set(value, output);
    value.forEach((entry) => {
      const redacted = redactSecrets(entry, { seen, key: '' });
      output.push(redacted === undefined ? null : redacted);
    });
    return output;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    const output = {};
    seen.set(value, output);
    Object.entries(value).forEach(([entryKey, entryValue]) => {
      if (['function', 'symbol', 'undefined'].includes(typeof entryValue)) {
        return;
      }
      output[entryKey] = redactSecrets(entryValue, { seen, key: entryKey });
    });
    return output;
  }
  if (value === undefined) {
    return undefined;
  }
  return redactSecretString(String(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((output, key) => {
        output[key] = canonicalize(value[key]);
        return output;
      }, {});
  }
  return value;
}

function stableStringify(value) {
  const serialized = JSON.stringify(canonicalize(redactSecrets(value)));
  return serialized === undefined ? 'null' : serialized;
}

function stableSha256(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function signEvidenceDigest(digest = '') {
  return crypto.createHmac('sha256', EVIDENCE_AUTHORITY_SECRET)
    .update(`${EVIDENCE_ATTESTATION_VERSION}:${String(digest || '').toLowerCase()}`)
    .digest('hex');
}

function verifyEvidenceAuthority(authority = {}, digest = '') {
  if (!isPlainObject(authority)
    || authority.version !== EVIDENCE_AUTHORITY_VERSION
    || authority.issuer !== EVIDENCE_AUTHORITY_ISSUER
    || authority.keyId !== EVIDENCE_AUTHORITY_KEY_ID) {
    return false;
  }
  const supplied = String(authority.signature || '').toLowerCase();
  const expected = signEvidenceDigest(digest);
  if (!/^[a-f0-9]{64}$/.test(supplied)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
}

function normalizeObservedAt(value = '') {
  const observedAt = value ? new Date(value) : new Date();
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error('Evidence attestation observedAt must be a valid date.');
  }
  return observedAt.toISOString();
}

function normalizeStructuredDetails(value = {}) {
  if (!isPlainObject(value) && !Array.isArray(value)) {
    throw new Error('Evidence attestation details must be a structured object or array.');
  }
  return redactSecrets(value);
}

function buildDigestPayload(attestation = {}) {
  return {
    version: EVIDENCE_ATTESTATION_VERSION,
    id: attestation.id,
    kind: attestation.kind,
    subject: attestation.subject,
    sourceInvocationId: attestation.sourceInvocationId,
    observedAt: attestation.observedAt,
    verdict: attestation.verdict,
    details: attestation.details,
  };
}

function createEvidenceAttestation(input = {}) {
  if (!isPlainObject(input)) {
    throw new Error('Evidence attestation input must be a structured object.');
  }

  const kind = String(input.kind || '').trim().toLowerCase();
  if (!EVIDENCE_KINDS.includes(kind)) {
    throw new Error(`Evidence attestation kind must be one of: ${EVIDENCE_KINDS.join(', ')}.`);
  }
  const subject = String(input.subject || '').trim();
  if (!subject) {
    throw new Error('Evidence attestation subject is required.');
  }
  const verdict = String(input.verdict || 'unknown').trim().toLowerCase();
  if (!EVIDENCE_VERDICTS.includes(verdict)) {
    throw new Error(`Evidence attestation verdict must be one of: ${EVIDENCE_VERDICTS.join(', ')}.`);
  }

  const sourceInvocationId = input.sourceInvocationId == null
    ? null
    : String(input.sourceInvocationId).trim() || null;
  const observedAt = normalizeObservedAt(input.observedAt);
  const details = normalizeStructuredDetails(input.details || {});
  const identityPayload = {
    kind,
    subject,
    sourceInvocationId,
    observedAt,
    verdict,
    details,
  };
  const id = String(input.id || '').trim()
    || `evidence-${stableSha256(identityPayload).slice(0, 24)}`;
  const attestation = {
    version: EVIDENCE_ATTESTATION_VERSION,
    id,
    kind,
    subject,
    sourceInvocationId,
    observedAt,
    digest: '',
    verdict,
    details,
  };
  attestation.digest = stableSha256(buildDigestPayload(attestation));
  attestation.authority = {
    version: EVIDENCE_AUTHORITY_VERSION,
    issuer: EVIDENCE_AUTHORITY_ISSUER,
    keyId: EVIDENCE_AUTHORITY_KEY_ID,
    signature: signEvidenceDigest(attestation.digest),
  };
  return attestation;
}

function normalizeEvidenceAttestation(value = {}) {
  if (!isPlainObject(value)) {
    return null;
  }
  try {
    const normalized = createEvidenceAttestation({
      id: value.id,
      kind: value.kind,
      subject: value.subject,
      sourceInvocationId: value.sourceInvocationId,
      observedAt: value.observedAt,
      verdict: value.verdict,
      details: value.details,
    });
    if (value.version && value.version !== EVIDENCE_ATTESTATION_VERSION) {
      return null;
    }
    if (!/^[a-f0-9]{64}$/i.test(String(value.digest || ''))) {
      return null;
    }
    if (normalized.digest !== String(value.digest).toLowerCase()) {
      return null;
    }
    if (!verifyEvidenceAuthority(value.authority, normalized.digest)) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function isEvidenceAttestation(value = {}) {
  return Boolean(normalizeEvidenceAttestation(value));
}

function collectEvidenceCandidates(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isPlainObject(value)) {
    return [];
  }
  if (Array.isArray(value.attestations)) {
    return value.attestations;
  }
  if (Array.isArray(value.evidenceAttestations)) {
    return value.evidenceAttestations;
  }
  return [value];
}

function extractEvidenceAttestations(metadata = {}) {
  const source = isPlainObject(metadata) ? metadata : {};
  const hasAttestations = Object.prototype.hasOwnProperty.call(source, 'evidenceAttestations');
  const hasEvidence = Object.prototype.hasOwnProperty.call(source, 'evidence');
  const candidates = [
    ...(hasAttestations ? collectEvidenceCandidates(source.evidenceAttestations) : []),
    ...(hasEvidence ? collectEvidenceCandidates(source.evidence) : []),
  ];
  const attestations = candidates
    .map(normalizeEvidenceAttestation)
    .filter(Boolean);

  return {
    present: hasAttestations || hasEvidence,
    attestations,
    invalidCount: Math.max(0, candidates.length - attestations.length),
  };
}

module.exports = {
  EVIDENCE_ATTESTATION_VERSION,
  EVIDENCE_AUTHORITY_VERSION,
  EVIDENCE_ATTESTATION_KINDS: EVIDENCE_KINDS,
  EVIDENCE_ATTESTATION_VERDICTS: EVIDENCE_VERDICTS,
  EVIDENCE_KINDS,
  EVIDENCE_REDACTION,
  EVIDENCE_VERDICTS,
  buildEvidenceAttestation: createEvidenceAttestation,
  createEvidenceAttestation,
  extractEvidenceAttestations,
  isEvidenceAttestation,
  isPlainObject,
  normalizeEvidenceAttestation,
  redactSecretString,
  redactSecrets,
  stableSha256,
  stableStringify,
  verifyEvidenceAuthority,
};
