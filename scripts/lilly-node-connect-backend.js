'use strict';
const fs = require('node:fs'); const assert = require('node:assert/strict'); const os = require('node:os');
const { execFileSync } = require('node:child_process');
function run(bin, args, input) { return execFileSync(bin, args, { input, encoding: 'utf8', timeout: 55000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
function kub(args, input) { return run('/usr/local/bin/kubectl', args, input); }
assert.equal(os.hostname(), 'ubuntu-32gb-fsn1-1');
const name = 'lilly-node-client-primary'; const mount = '/etc/lilly-node-client';
assert.equal(kub(['get', 'secret', name, '-n', 'kimibuilt', '--ignore-not-found', '-o', 'name']), '');
const before = JSON.parse(kub(['get', 'deployment', 'backend', '-n', 'kimibuilt', '-o', 'json']));
const spec = before.spec.template.spec; const index = spec.containers.findIndex(c => c.name === 'backend'); assert.ok(index >= 0);
assert.ok(!spec.volumes?.some(v => v.name === name));
assert.ok(spec.securityContext?.fsGroup === undefined || spec.securityContext.fsGroup === 1001);
const container = spec.containers[index];
const backup = '/etc/lilly-node/backend-before-connection.json';
fs.writeFileSync(backup, JSON.stringify(before), { flag: 'wx', mode: 0o600 });
const config = JSON.parse(fs.readFileSync('/etc/lilly-node/backend-client.json'));
config.tlsFiles = { key: `${mount}/client.key`, cert: `${mount}/client.crt`, ca: `${mount}/node-ca.crt` };
const data = { 'config.json': Buffer.from(JSON.stringify(config)).toString('base64') };
for (const file of ['client.key', 'client.crt', 'node-ca.crt']) data[file] = fs.readFileSync(`/etc/lilly-node/${file}`).toString('base64');
const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: 'kimibuilt' }, type: 'Opaque', immutable: true, data };
kub(['create', '--dry-run=server', '-f', '-'], JSON.stringify(secret));
kub(['create', '-f', '-'], JSON.stringify(secret));
const names = ['LILLY_TEAMS_ENABLED', 'LILLY_TEAMS_VISION_ENABLED', 'LILLY_TEAMS_RECOVERY_ENABLED', 'LILLY_TEAMS_BIND_EXECUTION_OWNER', 'LILLY_TEAMS_NODE_RPC_CONFIG'];
const env = (container.env || []).filter(e => !names.includes(e.name));
for (const key of names.slice(0, 4)) env.push({ name: key, value: 'false' });
env.push({ name: names[4], value: `${mount}/config.json` });
const patch = [
  { op: 'test', path: '/metadata/resourceVersion', value: before.metadata.resourceVersion },
  { op: 'add', path: `/spec/template/spec/containers/${index}/env`, value: env },
  { op: 'add', path: `/spec/template/spec/containers/${index}/volumeMounts`, value: [...(container.volumeMounts || []), { name, mountPath: mount, readOnly: true }] },
  { op: 'add', path: '/spec/template/spec/volumes', value: [...(spec.volumes || []), { name, secret: { secretName: name, defaultMode: 288 } }] },
  { op: 'add', path: '/spec/template/spec/securityContext', value: { ...(spec.securityContext || {}), fsGroup: 1001 } },
];
kub(['patch', 'deployment', 'backend', '-n', 'kimibuilt', '--type=json', '--dry-run=server', '-p', JSON.stringify(patch)]);
kub(['patch', 'deployment', 'backend', '-n', 'kimibuilt', '--type=json', '-p', JSON.stringify(patch)]);
console.log('Backend connection configuration applied; execution explicitly disabled. Await rollout before node allowlist update.');
