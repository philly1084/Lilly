'use strict';
const fs = require('node:fs'); const assert = require('node:assert/strict'); const { execFileSync } = require('node:child_process');
function run(bin, args) { return execFileSync(bin, args, { encoding: 'utf8', timeout: 50000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
const built = JSON.parse(fs.readFileSync('/tmp/lilly-team-release-built.json'));
assert.match(built.tag, /^localhost\/lilly-team-release:[a-f0-9]{16}$/);
run('/usr/bin/docker', ['run', '--rm', '--network=none', '--entrypoint=node', built.tag, '-e',
  "require('/app/src/agent-teams/runtime'); require('/app/src/agent-computer/configured-factory'); console.log('runtime_imports_passed')"]);
const args = ['-n', 'kimibuilt'];
const before = JSON.parse(run('/usr/local/bin/kubectl', [...args, 'get', 'deployment', 'backend', '-o', 'json']));
const index = before.spec.template.spec.containers.findIndex(c => c.name === 'backend');
const container = before.spec.template.spec.containers[index];
assert.equal(container.image, 'ghcr.io/philly1084/lilly:sha-0fad485');
for (const name of ['LILLY_TEAMS_ENABLED', 'LILLY_TEAMS_VISION_ENABLED', 'LILLY_TEAMS_RECOVERY_ENABLED', 'LILLY_TEAMS_BIND_EXECUTION_OWNER']) assert.equal(container.env.find(e => e.name === name)?.value, 'false');
fs.writeFileSync(`${built.root}/deployment-before.json`, JSON.stringify(before), { mode: 0o600, flag: 'wx' });
const patch = [ { op: 'test', path: '/metadata/resourceVersion', value: before.metadata.resourceVersion },
  { op: 'replace', path: `/spec/template/spec/containers/${index}/image`, value: built.tag },
  { op: 'add', path: `/spec/template/spec/containers/${index}/imagePullPolicy`, value: 'IfNotPresent' } ];
run('/usr/local/bin/kubectl', [...args, 'patch', 'deployment', 'backend', '--type=json', '--dry-run=server', '-p', JSON.stringify(patch)]);
run('/usr/local/bin/kubectl', [...args, 'patch', 'deployment', 'backend', '--type=json', '-p', JSON.stringify(patch)]);
const after = JSON.parse(run('/usr/local/bin/kubectl', [...args, 'get', 'deployment', 'backend', '-o', 'json']));
const expected = structuredClone(before.spec); expected.template.spec.containers[index].image = built.tag; expected.template.spec.containers[index].imagePullPolicy = 'IfNotPresent';
assert.deepEqual(after.spec, expected);
console.log(JSON.stringify({ tag: built.tag, runtimeImportsPassed: true, unrelatedDeploymentSpecPreserved: true, executionDisabled: true }));
