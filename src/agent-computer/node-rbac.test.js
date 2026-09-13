'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createNodeRbac } = require('./node-rbac');
const volume = 'pvc-12345678-1234-1234-1234-123456789abc';
const input = () => ({ nodeName: 'node-1.example', profileVolumeNames: [volume] });

test('separates the node identity from backend/workers and renders no workload or credential', () => {
  const result = createNodeRbac(input());
  expect(result.items.map(item => item.kind)).toEqual(['ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding']);
  expect(result.items[5].rules).toEqual([]);
  const [account, role, binding, pvRole, pvBinding] = result.items;
  expect(account.automountServiceAccountToken).toBe(false);
  expect(account.metadata.name).toMatch(/^lilly-node-[a-f0-9]{32}$/);
  expect(role.metadata.namespace).toBe('lilly-team-workers');
  expect(role.rules).toEqual([
    { apiGroups: [''], resources: ['pods'], verbs: ['get', 'create', 'delete'] },
    { apiGroups: [''], resources: ['pods/exec'], verbs: ['get', 'create'] },
    { apiGroups: [''], resources: ['persistentvolumeclaims'], verbs: ['get'] },
  ]);
  expect(pvRole.rules).toEqual([{ apiGroups: [''], resources: ['persistentvolumes'], verbs: ['get'], resourceNames: [volume] }]);
  for (const item of [binding, pvBinding]) {
    expect(item.subjects).toEqual([{ kind: 'ServiceAccount', name: account.metadata.name, namespace: 'lilly-team-workers' }]);
    expect(item.roleRef.name).toBe(account.metadata.name);
  }
  expect(pvRole.metadata.namespace).toBeUndefined();
});

test('optional startup grant is exact-name GET only and an omitted list revokes it', () => {
  const result = createNodeRbac({ ...input(), backendPodNames: ['backend-b', 'backend-a'] });
  expect(result.items[5].metadata.namespace).toBe('kimibuilt');
  expect(result.items[5].rules).toEqual([{ apiGroups: [''], resources: ['pods'], verbs: ['get'], resourceNames: ['backend-a', 'backend-b'] }]);
  expect(result.items[6].subjects[0].namespace).toBe('lilly-team-workers');
  expect(createNodeRbac(input()).items[5].rules).toEqual([]);
  expect(() => createNodeRbac({ ...input(), backendPodNames: ['*'] })).toThrow();
});

test('empty allowlist renders an explicit revocation rather than unbounded volume reads', () => {
  const before = createNodeRbac(input());
  const after = createNodeRbac({ ...input(), profileVolumeNames: [] });
  expect(after.items[3].rules).toEqual([]);
  expect(after.items[3].metadata).toEqual(before.items[3].metadata);
});

test('identity is stable per node, distinct across nodes, and input is not mutated', () => {
  const value = input(); Object.freeze(value.profileVolumeNames); Object.freeze(value);
  expect(createNodeRbac(value)).toEqual(createNodeRbac(input()));
  expect(createNodeRbac({ ...value, nodeName: 'node-2.example' }).items[0].metadata.name)
    .not.toBe(createNodeRbac(value).items[0].metadata.name);
});

test.each([
  null, {}, { ...input(), extra: true }, { ...input(), nodeName: '' }, { ...input(), nodeName: '../node' },
  { ...input(), nodeName: 'NODE' }, { ...input(), nodeName: 'a..b' }, { ...input(), nodeName: 'a'.repeat(64) },
  { ...input(), profileVolumeNames: undefined }, { ...input(), profileVolumeNames: '*' },
  { ...input(), profileVolumeNames: ['*'] }, { ...input(), profileVolumeNames: [volume, volume] },
  { ...input(), profileVolumeNames: [null] }, { ...input(), profileVolumeNames: Array(33).fill(volume) },
])('rejects ambiguous or broad configuration %#', value => {
  expect(() => createNodeRbac(value)).toThrow();
});

test('CLI emits only parseable manifests and rejects malformed input without leaking it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilly-node-rbac-'));
  const file = path.join(dir, 'reviewed.json');
  const script = path.resolve(__dirname, '../../bin/lilly-node-rbac.js');
  try {
    fs.writeFileSync(file, JSON.stringify(input()));
    const run = () => spawnSync(process.execPath, [script, '--config', file], { encoding: 'utf8', timeout: 10000 });
    const good = run(); expect(good.status).toBe(0); expect(good.stderr).toBe('');
    expect(JSON.parse(good.stdout)).toEqual(createNodeRbac(input()));
    fs.writeFileSync(file, 'private-invalid-content');
    const bad = run(); expect(bad.status).toBe(1); expect(bad.stdout).toBe('');
    expect(bad.stderr).not.toContain('private-invalid-content');
    fs.writeFileSync(file, ' '.repeat(65537)); expect(run().status).toBe(1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
