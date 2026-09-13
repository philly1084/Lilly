'use strict';

const { createHash } = require('node:crypto');
const { backendPodNames } = require('../agent-teams/node-owner-adapter');
const NAMESPACE = 'lilly-team-workers';
const fail = () => new Error('Reviewed node name and explicit profile volume names are required.');

// Pure rendering only. Never inventories a cluster, creates credentials, applies
// resources, or widens a missing volume allowlist into cluster-wide permission.
function createNodeRbac(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).sort().join(',') !== (Object.hasOwn(input, 'backendPodNames') ? 'backendPodNames,nodeName,profileVolumeNames' : 'nodeName,profileVolumeNames')
    || typeof input.nodeName !== 'string' || input.nodeName.length > 253
    || !input.nodeName.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !Array.isArray(input.profileVolumeNames) || input.profileVolumeNames.length > 32
    || input.profileVolumeNames.some(name => typeof name !== 'string'
      || !/^pvc-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name))
    || new Set(input.profileVolumeNames).size !== input.profileVolumeNames.length) throw fail();
  const pods = backendPodNames(input.backendPodNames === undefined ? [] : input.backendPodNames);
  const name = `lilly-node-${createHash('sha256').update(input.nodeName).digest('hex').slice(0, 32)}`;
  const labels = { 'app.kubernetes.io/name': 'lilly-node-recovery' };
  const annotations = { 'lilly.ai/node-name': input.nodeName };
  const metadata = namespaced => ({ name, ...(namespaced ? { namespace: NAMESPACE } : {}), labels: { ...labels }, annotations: { ...annotations } });
  const subject = { kind: 'ServiceAccount', name, namespace: NAMESPACE };
  const apiVersion = 'rbac.authorization.k8s.io/v1';
  const items = [
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: metadata(true), automountServiceAccountToken: false },
    { apiVersion, kind: 'Role', metadata: metadata(true), rules: [
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'create', 'delete'] },
      { apiGroups: [''], resources: ['pods/exec'], verbs: ['get', 'create'] },
      { apiGroups: [''], resources: ['persistentvolumeclaims'], verbs: ['get'] },
    ] },
    { apiVersion, kind: 'RoleBinding', metadata: metadata(true), subjects: [{ ...subject }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name } },
    // Always emit an empty ClusterRole as well: rendering an empty allowlist
    // after a previous grant must revoke that grant when deliberately applied.
    { apiVersion, kind: 'ClusterRole', metadata: metadata(false), rules: input.profileVolumeNames.length ? [
      { apiGroups: [''], resources: ['persistentvolumes'], verbs: ['get'], resourceNames: [...input.profileVolumeNames].sort() },
    ] : [] },
    { apiVersion, kind: 'ClusterRoleBinding', metadata: metadata(false), subjects: [{ ...subject }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name } },
  ];
  // Always render empty rules when absent, so a reviewed apply revokes an old
  // bootstrap grant. Only named backend Pods; no list, exec, logs or writes.
  items.push({ apiVersion, kind: 'Role', metadata: { ...metadata(true), namespace: 'kimibuilt' },
    rules: pods.length ? [{ apiGroups: [''], resources: ['pods'], verbs: ['get'], resourceNames: [...pods].sort() }] : [] },
  { apiVersion, kind: 'RoleBinding', metadata: { ...metadata(true), namespace: 'kimibuilt' }, subjects: [{ ...subject }],
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name } });
  return { apiVersion: 'v1', kind: 'List', items };
}

module.exports = { createNodeRbac };
