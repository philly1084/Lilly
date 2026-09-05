'use strict';

const crypto = require('crypto');

const DEFAULT_LEASE_DURATION_SECONDS = 120;
const DEFAULT_STALE_AFTER_SECONDS = 120;

function normalizeIdentity(value) {
  const normalized = String(value || '').trim();
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/.test(normalized)) {
    throw new Error(`Invalid deployment lease owner '${normalized}'.`);
  }
  return normalized;
}

function leaseHolder(lease) {
  return String(lease?.spec?.holderIdentity || '').trim();
}

function leaseRenewTime(lease) {
  return String(lease?.spec?.renewTime || lease?.spec?.acquireTime || '').trim();
}

function isLeaseStale(lease, nowMs = Date.now(), staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS) {
  if (!lease || !leaseHolder(lease)) {
    return true;
  }

  const renewedAt = Date.parse(leaseRenewTime(lease));
  if (!Number.isFinite(renewedAt)) {
    return false;
  }

  const duration = Number(lease.spec?.leaseDurationSeconds || staleAfterSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return false;
  return nowMs - renewedAt >= Math.max(duration, Number(staleAfterSeconds)) * 1000;
}

function chooseLeaseAction(lease, { owner, nowMs = Date.now(), staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS } = {}) {
  const normalizedOwner = normalizeIdentity(owner);
  if (!lease) {
    return 'create';
  }

  const holder = leaseHolder(lease);
  if (holder === normalizedOwner) {
    return 'owned';
  }
  if (isLeaseStale(lease, nowMs, staleAfterSeconds)) {
    return 'takeover';
  }
  return 'wait';
}

function buildLeasePatch(lease, { owner, now = new Date().toISOString(), leaseDurationSeconds = DEFAULT_LEASE_DURATION_SECONDS } = {}) {
  now = new Date(now).toISOString().replace(/Z$/, '000Z');
  const normalizedOwner = normalizeIdentity(owner);
  const resourceVersion = String(lease?.metadata?.resourceVersion || '').trim();
  if (!resourceVersion) {
    throw new Error('Cannot patch a deployment Lease without resourceVersion.');
  }

  const hasHolder = Object.prototype.hasOwnProperty.call(lease?.spec || {}, 'holderIdentity');
  const hasRenew = Object.prototype.hasOwnProperty.call(lease?.spec || {}, 'renewTime');
  const hasAcquire = Object.prototype.hasOwnProperty.call(lease?.spec || {}, 'acquireTime');
  const operations = [
    { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
  ];

  if (hasHolder) {
    operations.push({ op: 'test', path: '/spec/holderIdentity', value: lease.spec.holderIdentity });
    operations.push({ op: 'replace', path: '/spec/holderIdentity', value: normalizedOwner });
  } else {
    operations.push({ op: 'add', path: '/spec/holderIdentity', value: normalizedOwner });
  }

  operations.push({ op: hasAcquire ? 'replace' : 'add', path: '/spec/acquireTime', value: now });
  operations.push({ op: hasRenew ? 'replace' : 'add', path: '/spec/renewTime', value: now });
  operations.push({ op: 'add', path: '/spec/leaseDurationSeconds', value: Number(leaseDurationSeconds) });
  return operations;
}

function buildRenewPatch(lease, { owner, now = new Date().toISOString(), leaseDurationSeconds = DEFAULT_LEASE_DURATION_SECONDS } = {}) {
  now = new Date(now).toISOString().replace(/Z$/, '000Z');
  const normalizedOwner = normalizeIdentity(owner);
  const resourceVersion = String(lease?.metadata?.resourceVersion || '').trim();
  if (!resourceVersion || leaseHolder(lease) !== normalizedOwner) {
    throw new Error(`Cannot renew deployment Lease: owner '${normalizedOwner}' does not hold the current resource.`);
  }
  const operations = [
    { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
    { op: 'test', path: '/spec/holderIdentity', value: normalizedOwner },
    { op: 'replace', path: '/spec/renewTime', value: now },
    { op: 'add', path: '/spec/leaseDurationSeconds', value: Number(leaseDurationSeconds) },
  ];
  return operations;
}

function buildReleasePatch(lease, owner) {
  const normalizedOwner = normalizeIdentity(owner);
  const resourceVersion = String(lease?.metadata?.resourceVersion || '').trim();
  if (!resourceVersion) {
    throw new Error('Cannot release a deployment Lease without resourceVersion.');
  }
  if (leaseHolder(lease) !== normalizedOwner) {
    throw new Error(`Deployment Lease is owned by '${leaseHolder(lease) || 'nobody'}', not '${normalizedOwner}'.`);
  }

  const operations = [
    { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
    { op: 'test', path: '/spec/holderIdentity', value: normalizedOwner },
    { op: 'replace', path: '/spec/holderIdentity', value: '' },
  ];
  for (const field of ['renewTime', 'acquireTime']) {
    if (Object.prototype.hasOwnProperty.call(lease.spec || {}, field)) {
      operations.push({ op: 'remove', path: `/spec/${field}` });
    }
  }
  return operations;
}

function hashConfigData(data = {}) {
  const sort = (value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
  const stable = sort(data);
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function provenanceAnnotations({ releaseId, sourceSha, image, previousImage, configChecksum, actor, now = new Date().toISOString() } = {}) {
  const annotations = {
    'kimibuilt.secdevsolutions.help/release-id': String(releaseId || 'unknown'),
    'kimibuilt.secdevsolutions.help/release-source-sha': String(sourceSha || 'unknown'),
    'kimibuilt.secdevsolutions.help/release-image': String(image || 'unknown'),
    'kimibuilt.secdevsolutions.help/release-previous-image': String(previousImage || 'unknown'),
    'kimibuilt.secdevsolutions.help/release-started-at': now,
  };
  if (configChecksum) {
    annotations['kimibuilt.secdevsolutions.help/config-checksum'] = String(configChecksum);
  }
  if (actor) {
    annotations['kimibuilt.secdevsolutions.help/release-actor'] = String(actor);
  }
  return annotations;
}

function buildDeploymentImagePatch(deployment, {
  expectedImage,
  image,
  annotations = {},
  container = 'backend',
} = {}) {
  if (!expectedImage || !image) {
    throw new Error('Image compare-and-swap requires both expectedImage and image.');
  }
  const containers = deployment?.spec?.template?.spec?.containers || [];
  const containerIndex = containers.findIndex((candidate) => candidate.name === container);
  if (containerIndex < 0) {
    throw new Error(`Deployment does not contain container '${container}'.`);
  }

  const templateMetadata = deployment.spec.template.metadata || {};
  // Attempt IDs and timestamps belong on the Deployment, not the pod template:
  // retrying the same release must not trigger another replacement.
  const templateAnnotations = Object.fromEntries(Object.entries(annotations).filter(([key]) =>
    key.endsWith('/config-checksum') || key.endsWith('/release-source-sha')));
  const operations = [
    {
      op: 'test',
      path: `/spec/template/spec/containers/${containerIndex}/image`,
      value: expectedImage,
    },
    {
      op: 'replace',
      path: `/spec/template/spec/containers/${containerIndex}/image`,
      value: image,
    },
  ];
  if (deployment.metadata?.resourceVersion) {
    operations.unshift({ op: 'test', path: '/metadata/resourceVersion', value: deployment.metadata.resourceVersion });
  }

  if (templateMetadata.annotations) {
    for (const [key, value] of Object.entries(templateAnnotations)) {
      operations.push({ op: 'add', path: `/spec/template/metadata/annotations/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, value });
    }
  } else {
    operations.push({ op: 'add', path: '/spec/template/metadata/annotations', value: templateAnnotations });
  }

  const deploymentMetadata = deployment.metadata || {};
  if (deploymentMetadata.annotations) {
    for (const [key, value] of Object.entries(annotations)) {
      operations.push({ op: 'add', path: `/metadata/annotations/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, value });
    }
  } else {
    operations.push({ op: 'add', path: '/metadata/annotations', value: annotations });
  }
  return operations;
}

module.exports = {
  DEFAULT_LEASE_DURATION_SECONDS,
  DEFAULT_STALE_AFTER_SECONDS,
  normalizeIdentity,
  leaseHolder,
  isLeaseStale,
  chooseLeaseAction,
  buildLeasePatch,
  buildRenewPatch,
  buildReleasePatch,
  hashConfigData,
  provenanceAnnotations,
  buildDeploymentImagePatch,
};
