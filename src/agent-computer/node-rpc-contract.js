'use strict';

const { normalizeBrowserBinding } = require('./node-binding');
const { normalizeBrowserStopEvidence } = require('./stop-evidence');
const { normalizeProfileRecoveryEvidence } = require('./profile-recovery-evidence');
const { normalizeExecutionOwner } = require('../agent-teams/execution-owner');
const OWNER_METHOD = 'bindExecutionOwner';
const METHODS = ['bindContainer', 'requestStop', 'captureStop', 'observeTermination'];
const PATH = '/internal/lilly-computer/v1';
const fail = () => Object.assign(new Error('Private node operation is unconfirmed.'), { code: 'computer_node_rpc_unknown' });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const nodeName = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value);
const fingerprint = value => {
  if (typeof value !== 'string' || !/^(?:[a-fA-F0-9]{64}|(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2})$/.test(value)) throw fail();
  return value.replaceAll(':', '').toLowerCase();
};
function identity(value) {
  if (!exact(value, ['ownerId', 'teamId', 'agentId', 'taskId', 'claim']) || !exact(value.claim, ['taskId', 'workerId', 'claimId'])) throw fail();
  const result = {}; const claim = {};
  for (const key of ['ownerId', 'teamId', 'agentId', 'taskId']) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 256) throw fail();
    result[key] = value[key];
  }
  for (const key of ['taskId', 'workerId', 'claimId']) {
    if (typeof value.claim[key] !== 'string' || !value.claim[key] || value.claim[key].length > 256) throw fail();
    claim[key] = value.claim[key];
  }
  if (result.taskId !== claim.taskId) throw fail(); return { ...result, claim };
}
function request(value) {
  if (value?.method === OWNER_METHOD) {
    if (!exact(value, ['version', 'id', 'method', 'owner', 'nodeName']) || value.version !== 1
      || !uuid(value.id) || !nodeName(value.nodeName)) throw fail();
    const owner = normalizeExecutionOwner(value.owner);
    if (owner.version !== 1 || owner.platform !== 'linux' || owner.pod?.namespace !== 'kimibuilt'
      || owner.pod.containerName !== 'backend') throw fail();
    return { version: 1, id: value.id, method: OWNER_METHOD, owner, nodeName: value.nodeName };
  }
  if (!exact(value, ['version', 'id', 'method', 'identity', 'leaseId', 'nodeName']) || value.version !== 1
    || !uuid(value.id) || !uuid(value.leaseId) || !nodeName(value.nodeName) || !METHODS.includes(value.method)) throw fail();
  return { version: 1, id: value.id, method: value.method, identity: identity(value.identity), leaseId: value.leaseId, nodeName: value.nodeName };
}
function result(method, value, lease) {
  if (method === OWNER_METHOD) {
    const owner = normalizeExecutionOwner({ ...lease, version: 2, containerBinding: value });
    if (owner.containerBinding.version !== 2) throw fail();
    return owner.containerBinding;
  }
  if (method === 'bindContainer') return normalizeBrowserBinding(value, lease);
  if (method === 'requestStop') {
    if (!exact(value, ['requested']) || typeof value.requested !== 'boolean') throw fail();
    return { requested: value.requested };
  }
  if (method === 'captureStop') return value === null ? null : normalizeBrowserStopEvidence(lease, value);
  if (method !== 'observeTermination') throw fail();
  const keys = ['leaseId', 'claimId', 'ownerBootId', 'podUid', 'pvcUid', 'containerId'];
  if (!exact(value, [...keys, 'podStopped', 'profileReleased', 'stopEvidence', 'profileRecovery'])
    || keys.some(key => value[key] !== lease[key]) || value.podStopped !== true || value.profileReleased !== true) throw fail();
  const stopEvidence = normalizeBrowserStopEvidence(lease, value.stopEvidence);
  return { ...Object.fromEntries(keys.map(key => [key, lease[key]])), podStopped: true, profileReleased: true, stopEvidence,
    profileRecovery: normalizeProfileRecoveryEvidence({ ...lease, stopEvidence }, value.profileRecovery) };
}
function tlsMaterial(value) {
  if (!value || !['key', 'cert', 'ca'].every(key => (typeof value[key] === 'string' || Buffer.isBuffer(value[key])) && value[key].length > 0)) throw fail();
  // Do not spread arbitrary TLS options: verification is not configurable off.
  return { key: value.key, cert: value.cert, ca: value.ca, minVersion: 'TLSv1.3', rejectUnauthorized: true };
}

module.exports = { METHODS, OWNER_METHOD, PATH, fail, exact, uuid, nodeName, fingerprint, identity, request, result, tlsMaterial };
