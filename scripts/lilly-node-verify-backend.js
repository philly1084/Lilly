'use strict';
const fs = require('node:fs'); const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
function run(bin, args, input) { return execFileSync(bin, args, { input, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
function kub(args, input) { return run('/usr/local/bin/kubectl', args, input); }
const pods = JSON.parse(kub(['get', 'pods', '-n', 'kimibuilt', '-l', 'app=backend', '-o', 'json'])).items
  .filter(p => !p.metadata.deletionTimestamp && p.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
assert.equal(pods.length, 1); const pod = pods[0];
assert.match(pod.status.podIP, /^10\.42\.0\.\d{1,3}$/);
assert.ok(pod.spec.volumes.some(v => v.secret?.secretName === 'lilly-node-client-primary'));
const unitPath = '/etc/systemd/system/lilly-node.service'; const unit = fs.readFileSync(unitPath, 'utf8');
const line = `IPAddressAllow=${pod.status.podIP}/32`;
if (!unit.includes(line)) {
  assert.ok(unit.includes('IPAddressDeny=any'));
  fs.writeFileSync(unitPath, unit.replace('IPAddressDeny=any', `IPAddressDeny=any\n${line}`));
  run('/usr/bin/systemctl', ['daemon-reload']); run('/usr/bin/systemctl', ['restart', 'lilly-node.service']);
}
const proof = `const fs=require('fs'),https=require('https'),assert=require('assert');
const c=JSON.parse(fs.readFileSync(process.env.LILLY_TEAMS_NODE_RPC_CONFIG));
for(const n of ['LILLY_TEAMS_ENABLED','LILLY_TEAMS_VISION_ENABLED','LILLY_TEAMS_RECOVERY_ENABLED','LILLY_TEAMS_BIND_EXECUTION_OWNER'])assert.equal(process.env[n],'false');
const req=https.get(c.nodes[0].url+'/unsupported',{key:fs.readFileSync(c.tlsFiles.key),cert:fs.readFileSync(c.tlsFiles.cert),ca:fs.readFileSync(c.tlsFiles.ca),rejectUnauthorized:true},res=>{
assert.equal(res.socket.getPeerCertificate().fingerprint256.replaceAll(':','').toLowerCase(),c.nodes[0].fingerprint.replaceAll(':','').toLowerCase());
assert.equal(res.statusCode,400);res.resume();res.on('end',()=>console.log(JSON.stringify({backendMutualTlsVerified:true,nodePinVerified:true,executionDisabled:true})));});
req.setTimeout(5000,()=>req.destroy(new Error('deadline')));req.on('error',()=>process.exit(1));`;
const connection = JSON.parse(kub(['exec', '-i', '-n', 'kimibuilt', pod.metadata.name, '--', 'node', '-'], proof));
const health = JSON.parse(run('/usr/bin/curl', ['-fsS', '--max-time', '10', 'http://10.43.152.112:3000/health']));
assert.equal(health.status, 'healthy');
const report = { at: new Date().toISOString(), pod: pod.metadata.name, image: pod.spec.containers.find(c => c.name === 'backend').image,
  ...connection, backendHealthy: true, agentsStarted: 0, ownerBindingEnabled: false };
fs.writeFileSync('/opt/lilly-node/backend-connection-proof.json', JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report));
