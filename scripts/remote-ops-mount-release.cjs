'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 240000 }).trim();
assert.ok(process.env.KIMIBUILT_RELEASE_OWNER, 'Deployment coordinator lease required');
const revision = run('git', ['rev-parse', 'HEAD']);
assert.equal(revision, process.env.KIMIBUILT_RELEASE_SOURCE_SHA);
const name = `lilly-remote-ops-${revision.slice(0, 12)}`;
const files = ['src/routes/remote-ops-limits.js', 'src/routes/remote-ops-cancel.js', 'src/routes/remote-agent-tasks.js', 'src/remote-agent-task-service.js', 'src/middleware/security.js', 'src/routes/tools.js', 'src/routes/remote-ops-contract.js', 'src/routes/remote-ops-service.js', 'src/routes/remote-ops-artifacts.js', 'src/remote-cli/agents-sdk-runner.js', 'src/agent-sdk/tools/categories/ssh/RemoteCliAgentTool.js', 'src/agent-sdk/tools/categories/ssh/SSHExecuteTool.js'];
const data = Object.fromEntries(files.map(f => [f.split('/').pop(), fs.readFileSync(f, 'utf8')]));
const before = JSON.parse(run('kubectl', ['-n', 'kimibuilt', 'get', 'deployment/backend', '-o', 'json']));
const index = before.spec.template.spec.containers.findIndex(c => c.name === 'backend');
assert.equal(before.spec.template.spec.containers[index].image, process.env.KIMIBUILT_RELEASE_EXPECTED_IMAGE);
fs.writeFileSync(`/tmp/${name}-before.json`, JSON.stringify(before), { mode: 0o600 });
const volumeName = 'remote-ops-api';
const volumeIndex = before.spec.template.spec.volumes.findIndex(v => v.name === volumeName);
assert.ok(volumeIndex >= 0);
assert.equal(before.spec.template.spec.volumes[volumeIndex].configMap.name, process.env.REMOTE_OPS_EXPECTED_CONFIG);
const mounts = structuredClone(before.spec.template.spec.containers[index].volumeMounts || []);
for (const f of files) {
  const existing = mounts.find(v => v.mountPath === `/app/${f}`);
  if (existing) assert.ok(existing.name === volumeName && existing.subPath === f.split('/').pop(), `Conflicting mount ${f}`);
  else mounts.push({ name: volumeName, mountPath: `/app/${f}`, subPath: f.split('/').pop(), readOnly: true });
}
const manifestPath = `/tmp/${name}.json`;
fs.writeFileSync(manifestPath, JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: 'kimibuilt', annotations: { 'lilly/source-sha': revision } }, immutable: true, data }));
run('kubectl', ['create', '--dry-run=server', '-f', manifestPath]);
run('kubectl', ['create', '-f', manifestPath]);
const annotations = { ...before.spec.template.metadata.annotations, 'lilly/remote-ops-source': revision, 'lilly/remote-ops-config': name };
const patch = [
  { op: 'test', path: '/metadata/resourceVersion', value: before.metadata.resourceVersion },
  { op: 'replace', path: `/spec/template/spec/volumes/${volumeIndex}/configMap/name`, value: name },
  { op: 'add', path: `/spec/template/spec/containers/${index}/volumeMounts`, value: mounts },
  { op: 'add', path: '/spec/template/metadata/annotations', value: annotations },
];
run('kubectl', ['-n', 'kimibuilt', 'patch', 'deployment/backend', '--type=json', '--dry-run=server', '-p', JSON.stringify(patch)]);
run('kubectl', ['-n', 'kimibuilt', 'patch', 'deployment/backend', '--type=json', '-p', JSON.stringify(patch)]);
console.log(run('kubectl', ['-n', 'kimibuilt', 'rollout', 'status', 'deployment/backend', '--timeout=180s']));
const after = JSON.parse(run('kubectl', ['-n', 'kimibuilt', 'get', 'deployment/backend', '-o', 'json']));
const expected = structuredClone(before.spec);
expected.template.spec.volumes[volumeIndex].configMap.name = name;
expected.template.spec.containers[index].volumeMounts = mounts;
expected.template.metadata.annotations = annotations;
assert.ok(require('node:util').isDeepStrictEqual(after.spec, expected), 'Unexpected deployment spec changes');
const hashes = {};
for (const f of files) {
  hashes[f] = crypto.createHash('sha256').update(data[f.split('/').pop()]).digest('hex');
  assert.equal(run('kubectl', ['-n', 'kimibuilt', 'exec', 'deployment/backend', '--', 'sha256sum', `/app/${f}`]).split(/\s/)[0], hashes[f]);
}
console.log(JSON.stringify({ revision, configMap: name, image: after.spec.template.spec.containers[index].image, hashes, unrelatedDeploymentSpecPreserved: true }));
