'use strict';
// Explicit primary installation. No model/agent flags are changed.
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = '/opt/lilly-node'; const cfg = '/etc/lilly-node';
function run(bin, args, input) { return execFileSync(bin, args, { input, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
function kub(args, input) { return run('/usr/local/bin/kubectl', args, input); }
function write(name, value) { fs.writeFileSync(`${cfg}/${name}`, value, { mode: 0o600, flag: 'wx' }); }
assert.equal(os.hostname(), 'ubuntu-32gb-fsn1-1'); assert.equal(process.getuid(), 0);
assert.equal(fs.existsSync(root), false);
assert.equal(fs.existsSync(`${cfg}/service.json`), false);
assert.equal(kub(['get', 'namespace', 'lilly-team-workers', '--ignore-not-found', '-o', 'name']), '');
assert.equal(fs.existsSync('/etc/systemd/system/lilly-node.service'), false);
fs.mkdirSync(root, { mode: 0o700 });
run('/usr/bin/tar', ['-xzf', '/tmp/lilly-node-install.tgz', '-C', root]);
const hashes = JSON.parse(fs.readFileSync('/tmp/lilly-node-install-hashes.json'));
for (const [file, hash] of Object.entries(hashes)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`${root}/${file}`)).digest('hex'), hash);
fs.mkdirSync(`${root}/runtime/bin`, { recursive: true });
const runtime = fs.readFileSync('/tmp/lilly-node-service-source.hAJFiT/node24');
assert.equal(crypto.createHash('sha256').update(runtime).digest('hex'), 'a990a8ae388fc285ddbce280e63fca48cfd7695f632b66aec6ed581566eace99');
fs.writeFileSync(`${root}/runtime/bin/node`, runtime, { mode: 0o755 });
fs.mkdirSync(`${root}/node_modules`);
for (const name of ['pg', 'pg-types', 'postgres-array', 'postgres-date', 'postgres-interval', 'xtend', 'postgres-bytea', 'pg-int8', 'pg-connection-string', 'pg-protocol', 'pg-pool', 'ws', 'pgpass', 'split2']) {
  fs.cpSync(`/opt/kimibuilt/node_modules/${name}`, `${root}/node_modules/${name}`, { recursive: true, dereference: true });
}
const openssl = args => run('/usr/bin/openssl', args);
openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '3650', '-subj', '/CN=Lilly Node Private CA', '-keyout', `${cfg}/node-ca.key`, '-out', `${cfg}/node-ca.crt`]);
for (const name of ['server', 'client']) {
  openssl(['req', '-new', '-newkey', 'rsa:3072', '-nodes', '-subj', `/CN=lilly-node-${name}`, '-keyout', `${cfg}/${name}.key`, '-out', `${cfg}/${name}.csr`]);
  write(`${name}.ext`, name === 'server' ? 'subjectAltName=IP:10.42.0.1\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n');
  openssl(['x509', '-req', '-in', `${cfg}/${name}.csr`, '-CA', `${cfg}/node-ca.crt`, '-CAkey', `${cfg}/node-ca.key`, '-CAcreateserial', '-days', '365', '-extfile', `${cfg}/${name}.ext`, '-out', `${cfg}/${name}.crt`]);
}
for (const name of fs.readdirSync(cfg)) fs.chmodSync(`${cfg}/${name}`, 0o600);
const { createNodeRbac } = require(`${root}/src/agent-computer/node-rbac`);
const rbac = createNodeRbac({ nodeName: os.hostname(), profileVolumeNames: [], backendPodNames: [] });
const namespace = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'lilly-team-workers', labels: { 'app.kubernetes.io/part-of': 'lilly' } } };
kub(['create', '--dry-run=server', '-f', '-'], JSON.stringify(namespace));
kub(['create', '-f', '-'], JSON.stringify(namespace));
kub(['create', '--dry-run=server', '-f', '-'], JSON.stringify(rbac));
kub(['create', '-f', '-'], JSON.stringify(rbac));
const sa = rbac.items[0].metadata.name;
// Dedicated API token, stored only on the native host. No backend/admin token reuse.
const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: `${sa}-token`, namespace: 'lilly-team-workers', annotations: { 'kubernetes.io/service-account.name': sa } }, type: 'kubernetes.io/service-account-token' };
kub(['create', '-f', '-'], JSON.stringify(secret));
let credential;
for (let i = 0; i < 10; i++) {
  credential = JSON.parse(kub(['get', 'secret', secret.metadata.name, '-n', 'lilly-team-workers', '-o', 'json']));
  if (credential.data?.token) break;
  run('/usr/bin/sleep', ['1']);
}
assert.ok(credential.data?.token);
write('kubernetes.token', Buffer.from(credential.data.token, 'base64'));
write('kubernetes-ca.crt', Buffer.from(credential.data['ca.crt'], 'base64'));
const fingerprint = name => new crypto.X509Certificate(fs.readFileSync(`${cfg}/${name}.crt`)).fingerprint256;
write('service.json', JSON.stringify({ version: 1, nodeName: os.hostname(), listen: { host: '10.42.0.1', port: 9447 },
  tlsFiles: { key: `${cfg}/server.key`, cert: `${cfg}/server.crt`, ca: `${cfg}/node-ca.crt` }, clientFingerprints: [fingerprint('client')],
  database: { host: '10.43.84.112', port: 5432, database: 'kimibuilt', user: 'lilly_node_primary', passwordFile: `${cfg}/database.password`, caFile: `${cfg}/database-ca.crt` },
  kubernetes: { server: 'https://127.0.0.1:6443', tokenPath: `${cfg}/kubernetes.token`, caPath: `${cfg}/kubernetes-ca.crt` },
  recovery: { image: 'localhost/lilly-recovery-worker@sha256:8efbd814ce1b1efd0dd4da22a8c2eecdbe24d340d54b5e2d1017af60dbebe0bf', storageRoot: '/var/lib/rancher/k3s/storage' }, backendPodNames: [] }, null, 2));
write('backend-client.json', JSON.stringify({ version: 1, nodes: [{ name: os.hostname(), url: 'https://10.42.0.1:9447', fingerprint: fingerprint('server') }], tlsFiles: { key: `${cfg}/client.key`, cert: `${cfg}/client.crt`, ca: `${cfg}/node-ca.crt` } }, null, 2));
console.log(run(`${root}/runtime/bin/node`, [`${root}/bin/lilly-node-service.js`, '--config', `${cfg}/service.json`, '--check']));
// Root-owned source/dependencies cannot be modified by worker users.
run('/usr/bin/chmod', ['-R', 'go-w', root]);
let unit = fs.readFileSync(`${root}/deploy/lilly-node/lilly-node.service`, 'utf8');
// Restrict inbound AND outbound traffic by systemd cgroup filtering. Only local
// API/node address and the database are needed until backend activation is approved.
unit = unit.replace('LimitNOFILE=256', 'IPAddressDeny=any\nIPAddressAllow=127.0.0.0/8\nIPAddressAllow=10.42.0.1/32\nIPAddressAllow=10.43.84.112/32\nLimitNOFILE=256');
fs.writeFileSync('/etc/systemd/system/lilly-node.service', unit, { mode: 0o644, flag: 'wx' });
run('/usr/bin/systemd-analyze', ['verify', '/etc/systemd/system/lilly-node.service']);
run('/usr/bin/systemctl', ['daemon-reload']);
run('/usr/bin/systemctl', ['enable', '--now', 'lilly-node.service']);
console.log(run('/usr/bin/systemctl', ['show', 'lilly-node.service', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID']));
console.log(JSON.stringify({ sourceFilesVerified: Object.keys(hashes).length, installed: true, agentsStarted: 0, backendAccessEnabled: false }));
