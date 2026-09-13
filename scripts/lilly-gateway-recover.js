'use strict';
const fs = require('node:fs'); const assert = require('node:assert/strict'); const { execFileSync } = require('node:child_process');
const root = fs.mkdtempSync('/root/lilly-gateway-recovery.');
function run(bin, args) { return execFileSync(bin, args, { encoding: 'utf8', timeout: 600000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
const ns = 'n8n-openai-gateway'; const name = 'n8n-openai-cli-gateway';
const expected = 'ghcr.io/philly1084/cli-model-gateway@sha256:479c0cff09d0c3fc1264c5e6c9301abf9f3162f245069ede3f342993fee1a6d0';
const before = JSON.parse(run('/usr/local/bin/kubectl', ['get', 'deployment', name, '-n', ns, '-o', 'json']));
assert.equal(before.spec.template.spec.containers[0].image, expected);
const image = JSON.parse(run('/usr/bin/docker', ['image', 'inspect', '82e849f73104']))[0];
assert.ok(image.RepoDigests.includes(expected));
fs.writeFileSync(`${root}/deployment-before.json`, JSON.stringify(before), { mode: 0o600 });
const tag = 'localhost/lilly-gateway-recovery:82e849f73104';
run('/usr/bin/docker', ['tag', image.Id, tag]);
run('/usr/bin/docker', ['save', '--format', 'oci-archive', '-o', `${root}/image.tar`, tag]);
run('/usr/local/bin/k3s', ['ctr', 'images', 'import', `${root}/image.tar`]);
const patch = [{ op: 'test', path: '/metadata/resourceVersion', value: before.metadata.resourceVersion }];
const expectedSpec = structuredClone(before.spec);
for (const kind of ['initContainers', 'containers']) for (let i = 0; i < before.spec.template.spec[kind].length; i++) {
  const old = before.spec.template.spec[kind][i];
  assert.ok(old.image === expected || old.image === 'ghcr.io/philly1084/cli-model-gateway:cluster-431b9c8467ab');
  patch.push({ op: 'replace', path: `/spec/template/spec/${kind}/${i}/image`, value: tag });
  expectedSpec.template.spec[kind][i].image = tag;
}
run('/usr/local/bin/kubectl', ['patch', 'deployment', name, '-n', ns, '--type=json', '--dry-run=server', '-p', JSON.stringify(patch)]);
run('/usr/local/bin/kubectl', ['patch', 'deployment', name, '-n', ns, '--type=json', '-p', JSON.stringify(patch)]);
const after = JSON.parse(run('/usr/local/bin/kubectl', ['get', 'deployment', name, '-n', ns, '-o', 'json']));
assert.deepEqual(after.spec, expectedSpec);
console.log(JSON.stringify({ root, tag, originalImageVerified: true, nonImageSettingsPreserved: true }));
