'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 240000 }).trim();

const revision=run('git',['rev-parse','HEAD']); const name='lilly-remote-ops-'+revision.slice(0,12);
const files = ['src/routes/remote-ops-limits.js', 'src/routes/remote-ops-cancel.js', 'src/routes/remote-agent-tasks.js', 'src/remote-agent-task-service.js', 'src/middleware/security.js', 'src/routes/tools.js', 'src/routes/remote-ops-contract.js', 'src/routes/remote-ops-service.js', 'src/routes/remote-ops-artifacts.js', 'src/remote-cli/agents-sdk-runner.js', 'src/agent-sdk/tools/categories/ssh/RemoteCliAgentTool.js', 'src/agent-sdk/tools/categories/ssh/SSHExecuteTool.js'];
const data=Object.fromEntries(files.map(f=>[f.split('/').pop(),fs.readFileSync(f,'utf8')])); const before=JSON.parse(fs.readFileSync('/tmp/'+name+'-before.json')); const index=before.spec.template.spec.containers.findIndex(c=>c.name==='backend'); const volumeIndex=before.spec.template.spec.volumes.findIndex(v=>v.name==='remote-ops-api'); const mounts=before.spec.template.spec.containers[index].volumeMounts; const annotations={...before.spec.template.metadata.annotations,'lilly/remote-ops-source':revision,'lilly/remote-ops-config':name};
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
