'use strict';
const fs = require('node:fs'); const assert = require('node:assert/strict'); const crypto = require('node:crypto'); const { execFileSync } = require('node:child_process');
const run = args => execFileSync('kubectl', args, { encoding: 'utf8' }).trim();
const name = 'lilly-remote-ops-e69a1d11f85e';
const before = JSON.parse(fs.readFileSync(`/tmp/${name}-before.json`));
const after = JSON.parse(run(['-n', 'kimibuilt', 'get', 'deployment/backend', '-o', 'json']));
const expected = structuredClone(before.spec);
const index = expected.template.spec.containers.findIndex(c => c.name === 'backend');
expected.template.spec.volumes.push({ name: 'remote-ops-api', configMap: { name, defaultMode: 420 } });
for (const f of ['tools.js', 'remote-ops-contract.js']) expected.template.spec.containers[index].volumeMounts.push({ name: 'remote-ops-api', mountPath: `/app/src/routes/${f}`, subPath: f, readOnly: true });
expected.template.metadata.annotations = { ...expected.template.metadata.annotations, 'lilly/remote-ops-source': 'e69a1d11f85e601b988d7def93a795e730359c3f', 'lilly/remote-ops-config': name };
assert.ok(require('node:util').isDeepStrictEqual(after.spec, expected), 'Unexpected deployment spec change');
const cm = JSON.parse(run(['-n', 'kimibuilt', 'get', 'configmap', name, '-o', 'json']));
assert.equal(cm.immutable, true);
for (const [f, content] of Object.entries(cm.data)) {
  const expectedHash = crypto.createHash('sha256').update(fs.readFileSync(`/tmp/lilly-remote-ops-e69a1d11f85e/source/src/routes/${f}`)).digest('hex');
  assert.equal(crypto.createHash('sha256').update(content).digest('hex'), expectedHash);
  assert.equal(run(['-n', 'kimibuilt', 'exec', 'deployment/backend', '--', 'sha256sum', `/app/src/routes/${f}`]).split(/\s/)[0], expectedHash);
}
console.log(JSON.stringify({ configMap: name, immutable: true, sourceAndMountedHashesMatch: true, unrelatedDeploymentSpecPreserved: true, image: after.spec.template.spec.containers[index].image }));
