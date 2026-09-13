'use strict';

const { createHash } = require('node:crypto');
const { normalizeBrowserBinding } = require('./node-binding');
const fail = () => Object.assign(new Error('Private browser stop evidence is unconfirmed.'), { code: 'computer_stop_evidence_unknown' });
const fields = ['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'];
const observationKeys = [...fields, 'podStopped', 'source', 'observedAt'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function browserFingerprint(lease) {
  const binding = normalizeBrowserBinding(lease?.nodeBinding, lease);
  // The normalizer returns a fixed-key-order record, including its cgroup.
  return createHash('sha256').update(JSON.stringify({ namespace: lease.namespace, podName: lease.podName, binding })).digest('hex');
}

function createBrowserStopEvidence(lease, observation) {
  const fingerprint = browserFingerprint(lease);
  if (!exact(observation, observationKeys) || !fields.every(key => observation[key] === lease[key])
    || observation.podStopped !== true || !['cri-exited-and-cgroup-v2-empty', 'cri-exited-and-kernel-owner-retired'].includes(observation.source)
    || typeof observation.observedAt !== 'string' || !Number.isFinite(Date.parse(observation.observedAt))
    || new Date(observation.observedAt).toISOString() !== observation.observedAt
    || Date.parse(observation.observedAt) < Date.parse(lease.nodeBinding.observedAt)) throw fail();
  return { version: 1, fingerprint, ...Object.fromEntries(observationKeys.map(key => [key, observation[key]])) };
}

function normalizeBrowserStopEvidence(lease, value) {
  if (!exact(value, ['version', 'fingerprint', ...observationKeys]) || value.version !== 1) throw fail();
  const { version, fingerprint, ...observation } = value;
  const expected = createBrowserStopEvidence(lease, observation);
  if (fingerprint !== expected.fingerprint) throw fail();
  return expected;
}

module.exports = { browserFingerprint, createBrowserStopEvidence, normalizeBrowserStopEvidence };
