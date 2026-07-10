'use strict';

const { redactSecretString } = require('../agent-evidence');

const DEFAULT_LIMITS = Object.freeze({
  maxArrayLength: 50,
  maxDepth: 8,
  maxObjectKeys: 100,
  maxStringLength: 4000,
});

const SENSITIVE_KEY_PATTERN = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|authorization|cookie|password|refresh[_-]?token|secret|token)(?:$|[_-])/i;

function normalizeKey(value = '') {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function isSensitiveKey(key = '') {
  const normalized = normalizeKey(key);
  if (normalized === 'continuation_token') {
    return false;
  }
  return SENSITIVE_KEY_PATTERN.test(`_${normalized}_`);
}

function boundString(value = '', maxLength = DEFAULT_LIMITS.maxStringLength) {
  const source = String(value || '');
  const limit = Math.max(16, Number(maxLength) || DEFAULT_LIMITS.maxStringLength);
  if (source.length <= limit) {
    return source;
  }
  const omitted = source.length - limit;
  const marker = `\n[truncated ${omitted} chars]`;
  return `${source.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function redactAndBound(value, options = {}, depth = 0) {
  const limits = {
    ...DEFAULT_LIMITS,
    ...(options || {}),
  };

  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'string') {
    return boundString(redactSecretString(value), limits.maxStringLength);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (depth >= limits.maxDepth) {
    return '[MAX_DEPTH]';
  }
  if (Array.isArray(value)) {
    const bounded = value
      .slice(0, limits.maxArrayLength)
      .map((entry) => redactAndBound(entry, limits, depth + 1));
    if (value.length > limits.maxArrayLength) {
      bounded.push(`[truncated ${value.length - limits.maxArrayLength} items]`);
    }
    return bounded;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).slice(0, limits.maxObjectKeys);
    const result = {};
    for (const [key, entry] of entries) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: isSensitiveKey(key)
          ? '[REDACTED]'
          : redactAndBound(entry, limits, depth + 1),
      });
    }
    if (Object.keys(value).length > limits.maxObjectKeys) {
      result.__truncatedKeys = Object.keys(value).length - limits.maxObjectKeys;
    }
    return result;
  }
  return boundString(String(value), limits.maxStringLength);
}

module.exports = {
  DEFAULT_LIMITS,
  boundString,
  isSensitiveKey,
  redactAndBound,
};
